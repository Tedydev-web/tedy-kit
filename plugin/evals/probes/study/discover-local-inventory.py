import json
import re
import sys
from pathlib import Path

from study_pool import GH_LINK
from study_topic import TopicError, load_topic, term_regex, topic_arguments


def frontmatter(path):
    text = path.read_text(errors="replace")
    if not text.startswith("---"):
        return {}
    head = text.split("---", 2)[1]
    found = {}
    for key in ("name", "description", "license"):
        match = re.search(rf"^{key}:\s*(.*)$", head, re.M)
        if match:
            found[key] = match.group(1).strip().strip("'\"")
    return found


def inventory(topic, home):
    if "local" not in topic["strata"]:
        raise TopicError(f"{topic['path']}: the topic lists no local stratum")
    home = Path(home)
    term = term_regex(topic["terms"])
    rows = []

    def shown(path):
        return "~/" + str(path.relative_to(home))

    def tag(kind, name, location, text, extra):
        terms = sorted({m.group(1).lower() for m in term.finditer(f"{name.replace('_', '-')} {text}")})
        if terms:
            rows.append({"kind": kind, "name": name, "path": location, "matched_terms": terms, **extra})

    for skill in sorted(home.glob(".claude/skills/*/SKILL.md")):
        fm = frontmatter(skill)
        tag("user-skill", fm.get("name") or skill.parent.name, shown(skill), fm.get("description", ""), {"license": fm.get("license") or "unstated"})
    installed_file = home / ".claude/plugins/installed_plugins.json"
    installed = json.loads(installed_file.read_text()).get("plugins", {}) if installed_file.exists() else {}
    for plugin_id, installs in sorted(installed.items()):
        for install in installs[:1]:
            root = Path(install["installPath"])
            for asset in sorted(list(root.glob("skills/*/SKILL.md")) + list(root.glob("agents/*.md")) + list(root.glob("commands/*.md"))):
                stem = asset.parent.name if asset.name == "SKILL.md" else asset.stem
                kind = "plugin-skill" if asset.name == "SKILL.md" else f"plugin-{asset.parent.name.rstrip('s')}"
                location = shown(asset) if asset.is_relative_to(home) else f"{plugin_id}:{asset.relative_to(root)}"
                tag(kind, f"{plugin_id}:{stem}", location, frontmatter(asset).get("description", ""),
                    {"plugin_version": install.get("version"), "plugin_sha": install.get("gitCommitSha")})
    for market in sorted(home.glob(".claude/plugins/marketplaces/*/.claude-plugin/marketplace.json")):
        name = market.parent.parent.name
        for plugin in json.loads(market.read_text()).get("plugins", []):
            source = plugin.get("source")
            link = GH_LINK.search(json.dumps(source) + " " + (plugin.get("homepage") or ""))
            if not link and isinstance(source, dict):
                link = re.match(r"^([\w-]+)/([\w.-]+)$", source.get("repo", ""))
            text = f"{plugin.get('description') or ''} {' '.join(plugin.get('keywords') or [])}"
            url = f"https://github.com/{link.group(1)}/{link.group(2).removesuffix('.git')}" if link else None
            tag("marketplace-plugin", f"{plugin.get('name')}@{name}", shown(market), text, {"installed": f"{plugin.get('name')}@{name}" in installed, "url": url})
    return rows


def main(argv=None):
    args = topic_arguments("Tag installed skills, plugins and marketplace entries with the topic's terms (tags only, no copied text).",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--home"], {"default": str(Path.home()), "help": "home folder holding .claude"})).parse_args(argv)
    try:
        rows = inventory(load_topic(args.repo, args.topic), args.home)
    except TopicError as error:
        sys.exit(f"discover-local-inventory: {error}")
    out = Path(args.work) / "local-inventory.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    by_kind = {}
    for row in rows:
        by_kind[row["kind"]] = by_kind.get(row["kind"], 0) + 1
    print(f"local rows {len(rows)}; by kind {by_kind}")


if __name__ == "__main__":
    main()
