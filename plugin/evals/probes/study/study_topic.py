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
KEBAB = r"[a-z0-9]+(?:-[a-z0-9]+)*"


class TopicError(ValueError):
    pass


def _require(topic, path, key, kind):
    value = topic.get(key)
    if not isinstance(value, kind) or not value:
        raise TopicError(f"{path}: {key} must be a non-empty {kind.__name__}")
    return value


def load_topic(repo, name):
    base, _, facet = (name or "").partition(":")
    if not re.fullmatch(KEBAB, base) or (facet and not re.fullmatch(KEBAB, facet)):
        raise TopicError(f"topic name {name!r} must be kebab-case, or topic:facet")
    path = Path(repo) / TOPICS / f"{base}.json"
    if not path.is_file():
        raise TopicError(f"no topic config at {path}")
    try:
        topic = json.loads(path.read_text())
    except ValueError as error:
        raise TopicError(f"{path}: not JSON: {error}") from error
    if not isinstance(topic, dict):
        raise TopicError(f"{path}: must be a JSON object")
    if facet:
        topic = with_facet(topic, path, facet)
    _require(topic, path, "sweep", str)
    terms = _require(topic, path, "terms", list)
    if not all(isinstance(t, str) and t for t in terms):
        raise TopicError(f"{path}: terms must be non-empty strings")
    strata = _require(topic, path, "strata", dict)
    for stratum, rule in strata.items():
        if not isinstance(rule, dict):
            raise TopicError(f"{path}: strata.{stratum} must be an object")
    return {**topic, "name": name, "path": path, **({"facet": facet} if facet else {})}


def with_facet(topic, path, facet):
    rule = (topic.get("facets") or {}).get(facet)
    if not isinstance(rule, dict):
        raise TopicError(f"{path}: no facet {facet} under facets")
    where = f"{path}: facets.{facet}"
    for key, kind in (("sweep", str), ("problems", list), ("terms", list)):
        if not isinstance(rule.get(key), kind) or not rule[key]:
            raise TopicError(f"{where}.{key} must be a non-empty {kind.__name__}")
    outside = [t for t in rule["terms"] if t.lower() not in {u.lower() for u in topic.get("terms", [])}]
    if outside:
        raise TopicError(f"{where}: terms {outside} are not topic terms; the topic's discovery searches only its own terms")
    outside = [p for p in rule["problems"] if p not in topic.get("problems", [])]
    if outside:
        raise TopicError(f"{where}: problems {outside} are not topic problems")
    strata = rule.get("strata") or {}
    outside = sorted(set(strata) - set(topic.get("strata", {})))
    if outside:
        raise TopicError(f"{where}: strata {outside} are not topic strata")
    merged = {s: {**r, **{k: v for k, v in strata.get(s, {}).items() if k in ("stop_row", "forced_repos")}} for s, r in topic.get("strata", {}).items()}
    return {**topic, "sweep": rule["sweep"], "problems": rule["problems"], "terms": rule["terms"], "strata": merged}


def topic_for_sweep(repo, sweep):
    found = []
    for path in sorted((Path(repo) / TOPICS).glob("*.json")):
        try:
            config = json.loads(path.read_text())
        except ValueError as error:
            raise TopicError(f"{path}: not JSON: {error}") from error
        if config.get("sweep") == sweep:
            found.append(path.stem)
        found += [f"{path.stem}:{f}" for f, rule in sorted((config.get("facets") or {}).items()) if isinstance(rule, dict) and rule.get("sweep") == sweep]
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
    facet = topic.get("facet")
    holder = expected["facets"][facet] if facet else expected
    if stratum not in expected.get("strata", {}):
        raise TopicError(f"{path}: no strata.{stratum} to write a stop row into")
    holder.setdefault("strata", {}).setdefault(stratum, {})["stop_row"] = row
    anchor = text.find('"' + facet + '"', text.find('"facets"')) if facet else 0
    strata = text.find('"strata"', anchor)
    block = re.compile(r'"' + re.escape(stratum) + r'"\s*:\s*\{').search(text, strata) if strata >= 0 else None
    attempts = []
    if block:
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
    raise TopicError(f"{path}: could not write {'facets.' + facet + '.' if facet else ''}strata.{stratum}.stop_row without touching anything else; set it with the toolchain on a plain JSON file")


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
    parser.add_argument("--topic", required=True, help="topic config name under docs/prior-art/topics/, or topic:facet for one of its facets")
    parser.add_argument("--repo", default=".", help="kit repository root")
    for flags, options in extra:
        parser.add_argument(*flags, **options)
    return parser
