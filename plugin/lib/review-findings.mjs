const HEADER = /^[ \t]*###\s*\d+\.\s*(?:CONFIRMED|PLAUSIBLE)\s*\S\s*(\S+?):(\d+)/gm;

export function matchFindings(text, planted) {
  const own = text.split(/^[ \t]*Pre-existing:/m)[0];
  const heads = [...own.matchAll(HEADER)];
  const findings = heads.map((head, i) => ({ path: head[1], line: Number(head[2]), text: own.slice(head.index, heads[i + 1]?.index) }));
  const hits = (finding, spot) => (finding.path === spot.file || finding.path.endsWith(`/${spot.file}`)) && spot.lines.includes(finding.line) && (!spot.words || spot.words.test(finding.text));
  const found = planted.filter((problem) => findings.some((finding) => problem.at.some((spot) => hits(finding, spot)))).map((problem) => problem.id);
  const extra = findings.filter((finding) => !planted.some((problem) => problem.at.some((spot) => hits(finding, spot)))).length;
  return { found, missed: planted.map((problem) => problem.id).filter((id) => !found.includes(id)), findings: findings.length, extra };
}

export function reviewerOutputs(events) {
  const ids = new Set(events.flatMap((event) => (event.type === "assistant" ? event.message.content : []))
    .filter((block) => block.type === "tool_use" && /(^|:)reviewer$/.test(block.input?.subagent_type ?? ""))
    .map((block) => block.id));
  return events.flatMap((event) => (event.type === "user" && Array.isArray(event.message?.content) ? event.message.content : []))
    .filter((block) => block.type === "tool_result" && ids.has(block.tool_use_id))
    .map((block) => (typeof block.content === "string" ? block.content : block.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")));
}
