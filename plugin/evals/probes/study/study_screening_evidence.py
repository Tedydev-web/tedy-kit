import json
import re
import urllib.parse

WORKFLOW = re.compile(r"^\.github/workflows/([^/]+\.ya?ml)$")
TEST_DIR = re.compile(r"^(tests?|__tests__|specs?|e2e)$", re.I)
TEST_FILE = re.compile(r"(^test_.+|.+_test\.\w+|.+\.(test|spec)\.\w+)$", re.I)
CHANGELOG = re.compile(r"^(CHANGELOG|CHANGES|HISTORY)(\.md)?$", re.I)
PYPROJECT_NAME = re.compile(r'^name\s*=\s*"([^"]+)"', re.M)
PERMANENT = re.compile(r"\b(404|410)\b|not found|could not resolve", re.I)
CHANGELOG_CHARS, TEST_PATHS = 1500, 30


def error_kind(status):
    return "permanent" if PERMANENT.search(status) else "transient"


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
        return ({"published": False}, None) if error_kind(status) == "permanent" else (None, status)
    try:
        return {"published": True, "latest": latest(json.loads(out))}, None
    except (ValueError, KeyError, TypeError, AttributeError):
        return None, f"unparsable registry reply from {url}"


def test_paths(paths):
    found = []
    for path in paths:
        parts = path.split("/")
        if len(parts) <= 2 and (any(TEST_DIR.match(p) for p in parts) or TEST_FILE.match(parts[-1])):
            found.append(path)
    return sorted(found)[:TEST_PATHS]


def repo_evidence(fetch, repo, paths, read_text):
    evidence, errors = {}, []
    releases, status = api_json(fetch, f"repos/{repo}/releases?per_page=100")
    if releases is None or not isinstance(releases, list):
        errors.append(f"releases: {status}")
    else:
        evidence["releases"] = {"count": len(releases), "latest": releases[0].get("tag_name") if releases else None,
                                "published": (releases[0].get("published_at") or "")[:10] if releases else None}
    tags, status = api_json(fetch, f"repos/{repo}/tags?per_page=100")
    if tags is None or not isinstance(tags, list):
        errors.append(f"tags: {status}")
    else:
        evidence["tags"] = {"count": len(tags), "latest": tags[0].get("name") if tags else None}
    owner, status = api_json(fetch, f"users/{repo.split('/', 1)[0]}")
    if not isinstance(owner, dict):
        errors.append(f"owner: {status}")
    else:
        evidence["owner_public_repos"] = owner.get("public_repos")
    evidence["workflows"] = sorted(m.group(1) for m in map(WORKFLOW.match, paths) if m)
    evidence["tests"] = test_paths(paths)
    changelog = next((p for p in paths if CHANGELOG.match(p)), None)
    if changelog:
        text, error = read_text(changelog, CHANGELOG_CHARS)
        evidence["changelog_head"] = text
        errors += [f"{changelog}: {error}"] if error else []
    package = {}
    if "package.json" in paths:
        text, error = read_text("package.json", 20000)
        try:
            name = json.loads(text).get("name") if not error else None
        except ValueError:
            name = None
        if isinstance(name, str) and name:
            facts, error = registry(fetch, f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@').replace('/', '%2F')}", lambda d: d["dist-tags"]["latest"])
            package["npm"] = {"name": name, **(facts or {})}
        errors += [f"npm: {error}"] if error else []
    if "pyproject.toml" in paths:
        text, error = read_text("pyproject.toml", 20000)
        found = PYPROJECT_NAME.search(text or "")
        if found:
            facts, error = registry(fetch, f"https://pypi.org/pypi/{urllib.parse.quote(found.group(1))}/json", lambda d: d["info"]["version"])
            package["pypi"] = {"name": found.group(1), **(facts or {})}
        errors += [f"pypi: {error}"] if error else []
    evidence["package"] = package
    return evidence, errors
