import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOPICS = Path("docs") / "prior-art" / "topics"
SWEEPS = Path("docs") / "prior-art" / "sweeps"
SNOWBALL_RANK_BASE = 1000
DEFAULT_PILOT_ROWS = 20
SESSION_CLIS = ("claude", "agy")
SAIGON = timezone(timedelta(hours=7))


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


def screened_strata(topic):
    return [s for s, rule in topic["strata"].items() if isinstance(rule.get("channels"), dict)]


def require_screened(topic, stratum):
    if stratum not in topic["strata"]:
        raise TopicError(f"topic {topic['name']} has no {stratum} stratum")
    if stratum not in screened_strata(topic):
        raise TopicError(f"{stratum} is tag-only (no channels in {topic['path']}): it gets no inputs, sessions, freeze or stop row")


def write_stop_row(topic, stratum, row):
    path = topic["path"]
    text = path.read_text()
    expected = json.loads(text)
    if stratum not in expected.get("strata", {}):
        raise TopicError(f"{path}: no strata.{stratum} to write a stop row into")
    expected["strata"][stratum]["stop_row"] = row
    block = re.compile(r'"' + re.escape(stratum) + r'"\s*:\s*\{').search(text, text.find('"strata"'))
    key = re.compile(r'"stop_row"\s*:\s*(?:null|-?\d+|"[^"]*")').search(text, block.end())
    attempts = [text[:key.start()] + f'"stop_row": {row}' + text[key.end():]] if key else []
    closing = text[block.end():].lstrip().startswith("}")
    attempts.append(text[:block.end()] + f'"stop_row": {row}' + ("" if closing else ", ") + text[block.end():])
    for candidate in attempts:
        try:
            if json.loads(candidate) == expected:
                path.write_text(candidate)
                return
        except ValueError:
            continue
    raise TopicError(f"{path}: could not write strata.{stratum}.stop_row without touching anything else; set it with the toolchain on a plain JSON file")


def saigon_today():
    return datetime.now(SAIGON).date().isoformat()


def pilot_rows(topic):
    value = topic.get("pilot_rows", DEFAULT_PILOT_ROWS)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise TopicError(f"{topic['path']}: pilot_rows must be a positive int")
    return value


def session_option(topic, where, option):
    if not isinstance(option, dict) or option.get("cli") not in SESSION_CLIS or not isinstance(option.get("model"), str) or not option["model"]:
        raise TopicError(f"{topic['path']}: {where} needs a cli ({' or '.join(SESSION_CLIS)}) and a model id")
    if option["cli"] == "agy" and "effort" in option:
        raise TopicError(f"{topic['path']}: {where}: agy takes no effort, it is part of the model id")
    if "effort" in option and (not isinstance(option["effort"], str) or not option["effort"]):
        raise TopicError(f"{topic['path']}: {where}.effort must be a non-empty string")
    return {k: option[k] for k in ("cli", "model", "effort") if k in option}


def session_a(topic):
    return session_option(topic, "sessions.A", topic.get("sessions", {}).get("A"))


def session_b(topic):
    b = topic.get("sessions", {}).get("B")
    primary = session_option(topic, "sessions.B", b)
    fallback = session_option(topic, "sessions.B.fallback", b["fallback"]) if "fallback" in b else None
    also = b.get("pilot_also", [])
    if not isinstance(also, list):
        raise TopicError(f"{topic['path']}: sessions.B.pilot_also must be a list")
    return primary, fallback, [session_option(topic, f"sessions.B.pilot_also[{i}]", o) for i, o in enumerate(also)]


def session_b_options(topic):
    primary, fallback, also = session_b(topic)
    return [primary] + ([fallback] if fallback else []) + also


def topic_arguments(description, *extra):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--topic", required=True, help="topic config name under docs/prior-art/topics/")
    parser.add_argument("--repo", default=".", help="kit repository root")
    for flags, options in extra:
        parser.add_argument(*flags, **options)
    return parser
