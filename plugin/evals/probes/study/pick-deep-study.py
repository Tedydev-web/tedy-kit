import re
import sys
from pathlib import Path

from study_sweep_record import screen
from study_topic import TopicError, load_topic, topic_arguments

CARD_NAME = re.compile(r"^---\n(?:(?!---\n)[^\n]*\n)*?name: (.+)\n")
PER_PROBLEM = 3


def card_sources(repo):
    names = []
    for path in sorted((Path(repo) / "docs" / "prior-art").glob("*.md")):
        match = CARD_NAME.match(path.read_text())
        if match and not match.group(1).strip().startswith("<"):
            names.append(match.group(1).strip())
    return names


def greedy(decided, table, covered_sources, picks):
    new = lambda mechs: {m for m in mechs if table.kind(m) == "new"}
    by_repo = {}
    for stratum, rows in decided.items():
        for row in rows:
            if row["decision"] != "eligible" and not row["decision"].startswith("study"):
                continue
            entry = by_repo.setdefault(row["repo"].lower(), {"repo": row["repo"], "where": [], "mechs": set(), "issues": set()})
            entry["where"].append(f"{stratum}#{row['rank']}")
            entry["mechs"] |= row["session_mechs"]
            entry["issues"] |= row["issues"]
    covered_keys = {c.lower() for c in covered_sources}
    covered = set().union(*(new(v["mechs"]) for k, v in by_repo.items() if k in covered_keys))
    chosen = []
    for _ in range(picks):
        left = [v for k, v in by_repo.items() if k not in covered_keys and v not in chosen]
        if not left:
            break
        best = max(left, key=lambda v: (len(new(v["mechs"]) - covered), len(v["issues"]), v["repo"]))
        gain = sorted(new(best["mechs"]) - covered)
        chosen.append(best)
        covered |= set(gain)
        yield best, gain
    total = set().union(*(new(v["mechs"]) for v in by_repo.values())) if by_repo else set()
    remaining = sorted(((len(new(v["mechs"]) - covered), v["repo"]) for v in by_repo.values() if v not in chosen and v["repo"].lower() not in covered_keys), reverse=True)[:8]
    yield {"eligible": len(by_repo), "new_total": len(total), "covered": len(covered), "remaining": remaining}, None


def main(argv=None):
    args = topic_arguments("Pick deep-study sources greedily: each pick adds the most new mechanisms not yet covered by cards or earlier picks.",
                           (["--covered"], {"help": "comma-separated sources already carded, default every card in docs/prior-art"}),
                           (["--picks"], {"type": int, "help": f"number of picks, default {PER_PROBLEM} per topic problem minus the carded eligible sources"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        state = screen(Path(args.repo), topic)
    except TopicError as error:
        sys.exit(f"pick-deep-study: {error}")
    covered = [c for c in args.covered.split(",") if c] if args.covered is not None else card_sources(args.repo)
    eligible = {r["repo"].lower() for rows in state["decided"].values() for r in rows if r["decision"] == "eligible" or r["decision"].startswith("study")}
    carded = [c for c in covered if c.lower() in eligible]
    picks = args.picks if args.picks is not None else PER_PROBLEM * len(topic.get("problems", [])) - len(carded)
    print(f"covered by cards: {carded}; picks {picks}")
    for best, gain in greedy(state["decided"], state["table"], covered, max(picks, 0)):
        if gain is None:
            print(f"eligible repos {best['eligible']}; new mechanisms across eligible {best['new_total']}; covered by cards + picks {best['covered']}")
            print("remaining gain after picks:", best["remaining"])
        else:
            print(f"pick {best['repo']} {best['where']} gain {len(gain)} issues {len(best['issues'])}: {gain}")


if __name__ == "__main__":
    main()
