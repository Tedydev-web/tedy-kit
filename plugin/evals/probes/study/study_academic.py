import re
import urllib.parse
import xml.etree.ElementTree as ET

from study_pool import parse_json

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_COMMENT = "{http://arxiv.org/schemas/atom}comment"
ARXIV_ID = re.compile(r"arxiv\.org/abs/(\S+?)(?:v\d+)?$")
ARXIV_URL = "https://export.arxiv.org/api/query?search_query={query}&start=0&max_results={size}&sortBy=relevance"
S2_URL = "https://api.semanticscholar.org/graph/v1/paper/search?query={query}&limit={size}&fields=title,year,url,abstract,externalIds"


def squash(text):
    return " ".join((text or "").split())


def arxiv_papers(out):
    papers = []
    for entry in ET.fromstring(out).iter(f"{ATOM}entry"):
        found = ARXIV_ID.search(squash(entry.findtext(f"{ATOM}id")))
        if not found:
            continue
        text = " ".join(squash(entry.findtext(tag)) for tag in (f"{ATOM}summary", ARXIV_COMMENT))
        papers.append((f"arxiv:{found.group(1)}", {"title": squash(entry.findtext(f"{ATOM}title")), "published": squash(entry.findtext(f"{ATOM}published"))[:10],
                                                   "url": f"https://arxiv.org/abs/{found.group(1)}"}, text))
    return papers


def s2_papers(body):
    papers = []
    for paper in body.get("data") or []:
        ids = paper.get("externalIds") or {}
        key = f"arxiv:{ids['ArXiv']}" if ids.get("ArXiv") else f"doi:{ids['DOI'].lower()}" if ids.get("DOI") else f"s2:{paper.get('paperId')}"
        url = f"https://arxiv.org/abs/{ids['ArXiv']}" if ids.get("ArXiv") else paper.get("url") or ""
        papers.append((key, {"title": squash(paper.get("title")), "published": str(paper.get("year") or ""), "url": url}, squash(paper.get("abstract"))))
    return papers


def keep_papers(pool, channel, label, papers):
    linked = new = 0
    for key, meta, text in papers:
        entry = pool.state.setdefault("papers", {}).setdefault(key, {**meta, "channels": [], "queries": []})
        for field, value in (("channels", channel), ("queries", label)):
            if value not in entry[field]:
                entry[field].append(value)
        found, fresh = pool.links(text, channel, key)
        linked, new = linked + found, new + fresh
    return linked, new


def academic_search(fetch, pool, channel, label, url, parse, pause):
    step = f"academic {label}"
    if pool.done(step):
        return
    out, status, seconds = fetch.run(["curl", "-sSf", url], timeout=120)
    papers = []
    if status == "ok":
        try:
            papers = parse(out)
        except ET.ParseError:
            status = "unparsable Atom feed"
    linked, new = keep_papers(pool, channel, label, papers)
    pool.record(step, channel, label, status, seconds, len(papers), linked, new)
    fetch.pace(pause)


def run_academic(fetch, pool, academic):
    size = academic.get("max_results", 50)
    for query in academic.get("arxiv", []):
        academic_search(fetch, pool, "arxiv", f"arxiv {query}", ARXIV_URL.format(query=urllib.parse.quote(query), size=size), arxiv_papers, 3)
    for query in academic.get("semantic_scholar", []):
        academic_search(fetch, pool, "semantic-scholar", f"s2 {query}", S2_URL.format(query=urllib.parse.quote(query), size=size),
                        lambda out: s2_papers(parse_json(out, "ok", {})), 1.5)
