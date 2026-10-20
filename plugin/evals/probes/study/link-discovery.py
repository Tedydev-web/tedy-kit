import json
import sys
from pathlib import Path

from study_pool import DISCOVERY_LINK, DISCOVERY_STATES, Pool, read_json
from study_topic import TopicError, load_topic, terms_digest, topic_arguments


def link(repo, name, work, discovery):
    topic = load_topic(repo, name)
    if not topic.get("facet"):
        raise TopicError(f"{name} is not a facet; a whole topic discovers in its own working folder")
    base = load_topic(repo, name.partition(":")[0])
    work, discovery = Path(work).resolve(), Path(discovery).resolve()
    if work == discovery:
        raise TopicError("the facet's working folder must differ from the topic's discovery folder")
    own = [s for s in DISCOVERY_STATES if (work / s).exists()]
    if own:
        raise TopicError(f"{work} holds its own {', '.join(own)}; a facet reads the whole topic's discovery and never discovers itself")
    states = [discovery / s for s in DISCOVERY_STATES if (discovery / s).is_file()]
    if not states:
        raise TopicError(f"no discovery state ({', '.join(DISCOVERY_STATES)}) in {discovery}")
    for state in states:
        Pool(state, base["terms"])
    existing = read_json(work / DISCOVERY_LINK, None)
    if existing and existing.get("folder") != str(discovery):
        raise TopicError(f"{work} already reads the discovery in {existing.get('folder')}")
    work.mkdir(parents=True, exist_ok=True)
    link = {"folder": str(discovery), "topic": base["name"], "config": str(base["path"].resolve()), "terms_sha256": terms_digest(base["terms"])}
    (work / DISCOVERY_LINK).write_text(json.dumps(link, indent=1) + "\n")
    return [s.name for s in states]


def main(argv=None):
    args = topic_arguments("Point a facet's working folder at the whole topic's discovery folder. Facet steps read the discovery states, pools and caches from it and "
                           "never write it; everything they write lands in the facet's folder.",
                           (["--work"], {"required": True, "help": "the facet's working folder"}),
                           (["--discovery"], {"required": True, "help": "the whole topic's working folder, read only"})).parse_args(argv)
    try:
        states = link(args.repo, args.topic, args.work, args.discovery)
    except TopicError as error:
        sys.exit(f"link-discovery: {error}")
    print(f"{args.topic}: reads {', '.join(states)}, the pools and the caches from {Path(args.discovery).resolve()}")


if __name__ == "__main__":
    main()
