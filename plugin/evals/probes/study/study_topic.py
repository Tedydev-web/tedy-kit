import argparse
import hashlib
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
FLAGGERS = {"rubric_trigger": [{"cli": "agy", "model": "gemini-3.8-flash-high"}], "record_only": [{"cli": "agy", "model": "gpt-oss-120b-medium"}]}


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
    _require(topic, path, "sweep", str)
    terms = _require(topic, path, "terms", list)
    if not all(isinstance(t, str) and t for t in terms):
        raise TopicError(f"{path}: terms must be non-empty strings")
    strata = _require(topic, path, "strata", dict)
    for stratum, rule in strata.items():
        if not isinstance(rule, dict):
            raise TopicError(f"{path}: strata.{stratum} must be an object")
    eligibility = topic.get("eligibility", {"vi": "-", "en": "-"})
    if not isinstance(eligibility, dict) or set(eligibility) != {"vi", "en"} or not all(isinstance(v, str) and v for v in eligibility.values()):
        raise TopicError(f"{path}: eligibility must hold exactly vi and en, each a non-empty string")
    if "facets" in topic:
        check_facets(topic, path)
    if facet:
        topic = with_facet(topic, path, facet)
    return {**topic, "name": name, "path": path, **({"facet": facet} if facet else {})}


def check_facets(topic, path):
    facets = topic["facets"]
    if not isinstance(facets, dict) or not facets:
        raise TopicError(f"{path}: facets must be a non-empty object")
    terms = {t.lower() for t in topic.get("terms", []) if isinstance(t, str)}
    for name, rule in facets.items():
        where = f"{path}: facets.{name}"
        if not isinstance(rule, dict):
            raise TopicError(f"{where} must be an object")
        if not isinstance(rule.get("sweep"), str) or not rule["sweep"]:
            raise TopicError(f"{where}.sweep must name the facet's sweep")
        for key in ("problems", "terms"):
            if not isinstance(rule.get(key), list) or not rule[key] or not all(isinstance(v, str) and v for v in rule[key]):
                raise TopicError(f"{where}.{key} must be non-empty strings")
        strata = rule.get("strata", {})
        if not isinstance(strata, dict):
            raise TopicError(f"{where}.strata must be an object")
        for stratum, value in strata.items():
            if not isinstance(value, dict):
                raise TopicError(f"{where}.strata.{stratum} must be an object")
        outside = [t for t in rule["terms"] if t.lower() not in terms]
        if outside:
            raise TopicError(f"{where}: terms {outside} are not topic terms; the topic's discovery searches only its own terms")
        outside = [p for p in rule["problems"] if p not in topic.get("problems", [])]
        if outside:
            raise TopicError(f"{where}: problems {outside} are not topic problems")
        outside = sorted(set(strata) - set(topic.get("strata", {})))
        if outside:
            raise TopicError(f"{where}: strata {outside} are not topic strata")
    homes = {p: [n for n, rule in facets.items() if p in rule["problems"]] for p in topic.get("problems", [])}
    unplaced = [p for p, names in homes.items() if not names]
    if unplaced:
        raise TopicError(f"{path}: facets leave problems {unplaced} in no facet")
    for problem, names in homes.items():
        if len(names) > 1:
            raise TopicError(f"{path}: problem {problem} sits in facets {names}; each problem sits in exactly one facet")
    sweeps = [topic.get("sweep")] + [rule["sweep"] for rule in facets.values()]
    for sweep in sweeps:
        if sweeps.count(sweep) > 1:
            raise TopicError(f"{path}: sweep {sweep} is named more than once")


def with_facet(topic, path, facet):
    rule = (topic.get("facets") or {}).get(facet)
    if not isinstance(rule, dict):
        raise TopicError(f"{path}: no facet {facet} under facets")
    own = rule.get("strata", {})
    strata = {s: {**r, "stop_row": own.get(s, {}).get("stop_row"), "forced_repos": own.get(s, {}).get("forced_repos", [])} for s, r in topic.get("strata", {}).items()}
    return {**topic, "sweep": rule["sweep"], "problems": rule["problems"], "terms": rule["terms"], "strata": strata}


def terms_digest(terms):
    return hashlib.sha256(json.dumps(sorted({t.lower() for t in terms})).encode()).hexdigest()


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


def product_filter(topic):
    channels = topic["strata"].get("product", {}).get("channels")
    if not isinstance(channels, dict) or not isinstance(channels.get("harness"), str):
        raise TopicError(f"{topic['path']}: strata.product.channels needs a harness pattern")
    harness, term = re.compile(channels["harness"], re.I), term_regex(topic["terms"])
    extra = re.compile(channels["extra_text"], re.I) if channels.get("extra_text") else None
    return lambda text: bool(harness.search(text) and (term.search(text) or (extra and extra.search(text))))


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


def named_models(topic):
    sessions = topic.get("sessions") if isinstance(topic.get("sessions"), dict) else {}
    b = sessions.get("B") if isinstance(sessions.get("B"), dict) else {}
    qgs = topic.get("qgs_judges") if isinstance(topic.get("qgs_judges"), dict) else {}
    also = b.get("pilot_also") if isinstance(b.get("pilot_also"), list) else []
    named = {"sessions.A": sessions.get("A"), "sessions.B": b, "sessions.B.fallback": b.get("fallback"), **{f"sessions.B.pilot_also[{i}]": o for i, o in enumerate(also)},
             **{f"qgs_judges.{side}": o for side, o in qgs.items()}, "reader": topic.get("reader"), "cross_family": topic.get("cross_family")}
    return {where: o["model"] for where, o in named.items() if isinstance(o, dict) and isinstance(o.get("model"), str)}


def reference_option(topic, ladder=()):
    if topic.get("reference") is None:
        return None
    option = session_option(topic, "reference", topic["reference"])
    roles = [where for where, model in named_models(topic).items() if model == option["model"]] + (["the stage-1 ladder"] if option["model"] in ladder else [])
    if roles:
        raise TopicError(f"{topic['path']}: reference {option['model']} is also {', '.join(roles)}; the reference is never a judge, a stage-1 model or a replacement")
    return option


def flagger_option(topic, where, option):
    checked = session_option(topic, where, option)
    if "retest" not in option:
        return checked
    if option["retest"] is not True:
        raise TopicError(f"{topic['path']}: {where}.retest must be true or absent")
    reference = topic.get("reference") if isinstance(topic.get("reference"), dict) else {}
    if checked != {k: reference[k] for k in ("cli", "model", "effort") if k in reference}:
        raise TopicError(f"{topic['path']}: {where} is a retest, a second independent pass of the reference; it names the reference's cli, model and effort")
    return {**checked, "retest": True}


def flaggers(topic, ladder=()):
    out = {}
    for role, default in FLAGGERS.items():
        key = f"{role}_flaggers"
        listed = topic.get(key, default)
        if not isinstance(listed, list):
            raise TopicError(f"{topic['path']}: {key} must be a list")
        out[role] = [flagger_option(topic, f"{key}[{i}]", o) for i, o in enumerate(listed)]
    options = [o for listed in out.values() for o in listed]
    models = [o["model"] for o in options]
    twice = sorted({m for m in models if models.count(m) > 1})
    if twice:
        raise TopicError(f"{topic['path']}: flagger {', '.join(twice)} listed twice; a flagger has one role")
    reference = topic.get("reference") if isinstance(topic.get("reference"), dict) else {}
    if reference.get("model") in [o["model"] for o in options if not o.get("retest")]:
        raise TopicError(f"{topic['path']}: flagger {reference['model']} is the reference; a flagger labels blind of it")
    judges = {where: model for where, model in named_models(topic).items() if where != "cross_family"}
    for model in models:
        roles = [where for where, judge in judges.items() if judge == model] + (["the stage-1 ladder"] if model in ladder else [])
        if roles:
            raise TopicError(f"{topic['path']}: flagger {model} is also {', '.join(roles)}; an index judge never flags the reference it is measured against")
    return out


def topic_arguments(description, *extra):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--topic", required=True, help="topic config name under docs/prior-art/topics/, or topic:facet for one of its facets")
    parser.add_argument("--repo", default=".", help="kit repository root")
    for flags, options in extra:
        parser.add_argument(*flags, **options)
    return parser
