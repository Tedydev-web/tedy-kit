import json
import re
import urllib.parse

WORKFLOW = re.compile(r"^\.github/workflows/([^/]+\.ya?ml)$")
TEST_DIR = re.compile(r"^(tests?|__tests__|specs?|e2e|evals?|benchmarks?)$", re.I)
TEST_FILE = re.compile(r"(^test_.+|.+_test\.\w+|.+\.(test|spec)\.\w+)$", re.I)
CHANGELOG = re.compile(r"^(CHANGELOG|CHANGES|HISTORY)(\.md)?$", re.I)
PYPROJECT_NAME = re.compile(r'^name\s*=\s*"([^"]+)"', re.M)
REPO_GONE = re.compile(r"\b(404|410)\b|Could not resolve to a Repository", re.I)
FILE_GONE = re.compile(r"\b(404|410)\b")
CHANGELOG_CHARS, TEST_PATHS, PAGE, TOP_REPOS, DESCRIPTION_CHARS = 1500, 30, 100, 10, 160


def tree_error_kind(status):
    return "permanent" if REPO_GONE.search(status) else "transient"


def file_gone(status):
    return bool(FILE_GONE.search(status))


def counted(items):
    return f"{PAGE}+" if len(items) >= PAGE else len(items)


def api_json(fetch, path):
    out, status, _ = fetch.run(["gh", "api", path], timeout=120)
    if status != "ok":
        return None, status
    try:
        return json.loads(out), "ok"
    except ValueError:
        return None, f"unparsable reply from {path.split('?')[0]}"


def registry(fetch, url, latest):
    out, status, _ = fetch.run(["curl", "-sSf", url], timeout=60)
    if status != "ok":
        return ({"published": False}, None) if file_gone(status) else (None, status)
    try:
        return {"published": True, "latest": latest(json.loads(out))}, None
    except (ValueError, KeyError, TypeError, AttributeError):
        return None, f"unparsable registry reply from {url}"


def test_paths(paths):
    found = sorted(p for p in paths if any(TEST_DIR.match(part) for part in p.split("/")[:-1]) or TEST_FILE.match(p.rsplit("/", 1)[-1]))
    return {"count": len(found), "paths": found[:TEST_PATHS]}


def top_repos(listing):
    owned = sorted((r for r in listing if isinstance(r, dict) and not r.get("fork")), key=lambda r: (-(r.get("stargazers_count") or 0), r.get("name") or ""))
    return [{"name": r.get("name"), "stars": r.get("stargazers_count") or 0, "description": (r.get("description") or "")[:DESCRIPTION_CHARS]} for r in owned[:TOP_REPOS]]


def listed(fetch, path, field, shape, problems):
    body, status = api_json(fetch, path)
    if not isinstance(body, shape):
        (problems["missing"] if file_gone(status) else problems["errors"]).append(f"{field}: {status if status != 'ok' else 'unexpected reply shape'}")
        return None
    return body


def package_facts(fetch, paths, read_text, problems):
    package = {}
    for manifest, kind, name_of, url, latest in (
            ("package.json", "npm", lambda t: json.loads(t).get("name"), "https://registry.npmjs.org/{}", lambda d: d["dist-tags"]["latest"]),
            ("pyproject.toml", "pypi", lambda t: (PYPROJECT_NAME.search(t) or [None, None])[1], "https://pypi.org/pypi/{}/json", lambda d: d["info"]["version"])):
        if manifest not in paths:
            continue
        text = read_text(manifest, 20000)
        try:
            name = name_of(text) if text else None
        except (ValueError, AttributeError):
            name = None
        if not isinstance(name, str) or not name:
            continue
        facts, error = registry(fetch, url.format(urllib.parse.quote(name, safe="@").replace("/", "%2F")), latest)
        package[kind] = {"name": name, **(facts or {})}
        if error:
            problems["errors"].append(f"{kind}: {error}")
    return package


def repo_evidence(fetch, repo, paths, read_text, problems):
    evidence, owner = {}, repo.split("/", 1)[0]
    releases = listed(fetch, f"repos/{repo}/releases?per_page={PAGE}", "releases", list, problems)
    if releases is not None:
        evidence["releases"] = {"count": counted(releases), "latest": releases[0].get("tag_name") if releases else None,
                                "published": (releases[0].get("published_at") or "")[:10] if releases else None}
    tags = listed(fetch, f"repos/{repo}/tags?per_page={PAGE}", "tags", list, problems)
    if tags is not None:
        evidence["tags"] = {"count": counted(tags), "latest": tags[0].get("name") if tags else None}
    user = listed(fetch, f"users/{owner}", "owner", dict, problems)
    if user is not None:
        evidence["owner_public_repos"] = user.get("public_repos")
    repos = listed(fetch, f"users/{owner}/repos?per_page={PAGE}&type=owner", "owner repositories", list, problems)
    if repos is not None:
        evidence["owner_top_repos"] = top_repos(repos)
    evidence["workflows"] = sorted(m.group(1) for m in map(WORKFLOW.match, paths) if m)
    evidence["tests"] = test_paths(paths)
    changelog = next((p for p in paths if CHANGELOG.match(p)), None)
    if changelog:
        evidence["changelog_head"] = read_text(changelog, CHANGELOG_CHARS)
    evidence["package"] = package_facts(fetch, paths, read_text, problems)
    return evidence
