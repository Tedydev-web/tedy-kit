import argparse
import json
import re
from pathlib import Path

TOPICS = Path("docs") / "prior-art" / "topics"
SWEEPS = Path("docs") / "prior-art" / "sweeps"
SNOWBALL_RANK_BASE = 1000


class TopicError(ValueError):
    pass


def _require(topic, path, key, kind):
    value = topic.get(key)
    if not isinstance(value, kind) or not value:
        raise TopicError(f"{path}: {key} must be a non-empty {kind.__name__}")
    return value


def load_topic(repo, name):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name or ""):
        raise TopicError(f"topic name {name!r} must be kebab-case")
    path = Path(repo) / TOPICS / f"{name}.json"
    if not path.is_file():
        raise TopicError(f"no topic config at {path}")
    try:
        topic = json.loads(path.read_text())
    except ValueError as error:
        raise TopicError(f"{path}: not JSON: {error}") from error
    if not isinstance(topic, dict):
        raise TopicError(f"{path}: must be a JSON object")
    _require(topic, path, "sweep", str)
    terms = _require(topic, path, "terms", list)
    if not all(isinstance(t, str) and t for t in terms):
        raise TopicError(f"{path}: terms must be non-empty strings")
    strata = _require(topic, path, "strata", dict)
    for stratum, rule in strata.items():
        if not isinstance(rule, dict):
            raise TopicError(f"{path}: strata.{stratum} must be an object")
    return {**topic, "name": name, "path": path}


def topic_for_sweep(repo, sweep):
    found = []
    for path in sorted((Path(repo) / TOPICS).glob("*.json")):
        try:
            if json.loads(path.read_text()).get("sweep") == sweep:
                found.append(path.stem)
        except ValueError as error:
            raise TopicError(f"{path}: not JSON: {error}") from error
    if len(found) != 1:
        raise TopicError(f"sweep {sweep} is named by {len(found)} topic configs under {Path(repo) / TOPICS}, expected 1: {found}")
    return load_topic(repo, found[0])


def sweep_folder(repo, topic):
    return Path(repo) / SWEEPS / topic["sweep"]


def term_regex(terms):
    return re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(t) for t in terms) + r")(?![a-z0-9])", re.I)


def stratum_rule(topic, stratum, key, kind):
    value = topic["strata"].get(stratum, {}).get(key)
    if not isinstance(value, kind) or isinstance(value, bool):
        raise TopicError(f"{topic['path']}: strata.{stratum}.{key} must be a {kind.__name__}")
    return value


def topic_arguments(description, *extra):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--topic", required=True, help="topic config name under docs/prior-art/topics/")
    parser.add_argument("--repo", default=".", help="kit repository root")
    for flags, options in extra:
        parser.add_argument(*flags, **options)
    return parser
