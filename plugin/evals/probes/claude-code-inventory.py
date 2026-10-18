import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
LLMS = "https://code.claude.com/docs/llms.txt"
HOOKS = "https://code.claude.com/docs/en/hooks.md"
PLUGIN = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]


def fetch(url):
    result = subprocess.run(["curl", "-sSfL", "-A", UA, url], capture_output=True, text=True, timeout=120)
    if result.returncode != 0 or not result.stdout.strip():
        sys.exit(f"fetch failed: {url}: exit {result.returncode} {result.stderr.strip()[:200]}")
    return result.stdout


def hook_events(page):
    text = re.sub(r"```.*?```", "", page, flags=re.S)
    section = text.split("\n## Hook events\n", 1)[1].split("\n## ", 1)[0]
    headings = re.findall(r"^### (\w+)\s*$", section, re.M)
    tables = [text.split(header, 1)[1].split("\n\n", 1)[0] for header in ("| Event | When it fires |", "| Hook event | Can block? |")]
    return headings, [set(re.findall(r"^\| `(\w+)` \|", table, re.M)) for table in tables]


def frontmatter_keys(path, keys):
    text = path.read_text()
    head = text.split("---", 2)[1] if text.startswith("---") else ""
    return [k for k in keys if re.search(rf"^{k}:", head, re.M)]


def kit_components():
    manifest = json.loads((PLUGIN / ".claude-plugin/plugin.json").read_text())
    hooks_file = PLUGIN / "hooks/hooks.json"
    hooks = json.loads(hooks_file.read_text()) if hooks_file.exists() else {}
    settings_file = PLUGIN / "settings.json"
    settings = json.loads(settings_file.read_text()) if settings_file.exists() else manifest.get("settings", {})
    skills = sorted(PLUGIN.glob("skills/*/SKILL.md"))
    agents = sorted(PLUGIN.glob("agents/*.md"))
    pinned = [f"{p.relative_to(PLUGIN)}: {k}" for p in skills + agents for k in frontmatter_keys(p, ["model", "effort"])]
    checks = [
        ("plugin", "manifest", ".claude-plugin/plugin.json", True),
        ("skill", "component", "skills/*/SKILL.md", len(skills)),
        ("subagent", "component", "agents/*.md", len(agents)),
        ("slash command", "component", "commands/*.md", len(list(PLUGIN.glob("commands/*.md")))),
        ("output style", "component", "output-styles/*.md", len(list(PLUGIN.glob("output-styles/*.md")))),
        ("statusline", "component", "settings subagentStatusLine", "subagentStatusLine" in settings),
        ("MCP server", "component", ".mcp.json or manifest mcpServers", (PLUGIN / ".mcp.json").exists() or "mcpServers" in manifest),
        ("hooks", "component", "hooks/hooks.json", hooks_file.exists()),
        ("plugin eval", "component", "evals/", (PLUGIN / "evals").is_dir()),
        ("LSP server", "component", ".lsp.json", (PLUGIN / ".lsp.json").exists()),
        ("monitor", "component", "monitors/monitors.json", (PLUGIN / "monitors/monitors.json").exists()),
        ("theme", "component", "themes/*.json", len(list(PLUGIN.glob("themes/*.json")))),
        ("workflow", "component", "workflows/*.js", len(list(PLUGIN.glob("workflows/*.js")))),
        ("executable", "component", "bin/", (PLUGIN / "bin").is_dir()),
        ("channel", "component", "manifest channels", "channels" in manifest),
        ("mod", "component", "hooks.json modules", "modules" in hooks),
        ("model / effort pin", "model setting", "model:/effort: frontmatter in skills, agents", len(pinned)),
    ]
    return checks, set(hooks.get("hooks", {})), pinned


def mark(value):
    if value is True:
        return "yes"
    return f"yes ({value})" if value else "no"


def main():
    llms = fetch(LLMS)
    urls = re.findall(r"\]\((https://code\.claude\.com/docs/[^)\s]+)\)", llms)
    unique = sorted(set(urls))
    digest = hashlib.sha256("\n".join(unique).encode()).hexdigest()[:16]
    headings, in_tables = hook_events(fetch(HOOKS))
    checks, kit_hooks, pinned = kit_components()
    version = subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip() or "unknown"
    today = datetime.now(timezone(timedelta(hours=7))).date().isoformat()

    out = [
        f"- Claude Code: `{version}`",
        f"- Date: {today} (Asia/Saigon)",
        f"- `{LLMS}`: {len(urls)} doc links, {len(unique)} unique; sha256[:16] of the sorted unique list: `{digest}`",
        f"- Hook events (`### ` headings under `## Hook events` of `{HOOKS}`): {len(headings)}; lifecycle table {len(in_tables[0])}, exit code 2 table {len(in_tables[1])}",
    ]
    for label, table in zip(("lifecycle table", "exit code 2 table"), in_tables):
        for name in sorted(set(headings) ^ table):
            out.append(f"- WARNING: `{name}` is in {'the headings but not' if name in headings else 'not the headings but'} the {label}")
    for name in sorted(kit_hooks - set(headings)):
        out.append(f"- WARNING: kit hooks.json uses `{name}`, not a documented event")
    out += ["", f"Evidence paths are relative to `{PLUGIN.name}/`.", "", "| surface | kind | kit uses | evidence |", "| :- | :- | :- | :- |"]
    out += [f"| {name} | hook event | {'yes' if name in kit_hooks else 'no'} | hooks/hooks.json |" for name in headings]
    out += [f"| {name} | {kind} | {mark(value)} | {where} |" for name, kind, where, value in checks]
    out += [f"- pinned: {p}" for p in pinned]
    used = sum(1 for n in headings if n in kit_hooks) + sum(1 for _, _, _, v in checks if mark(v) != "no")
    out.append(f"\nKit uses {used} of {len(headings) + len(checks)} generated rows.")
    print("\n".join(out))


if __name__ == "__main__":
    main()
