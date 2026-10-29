const REVERT = /^Revert\b/;
const LINK = /\bOP#(\d+)\b|\/work_packages\/(\d+)\b/g;

export const linkedIds = (text) => [...new Set([...String(text ?? "").matchAll(LINK)].map((match) => Number(match[1] ?? match[2])))];

export function flowOf(tracker) {
  if (tracker.flow) return tracker.flow;
  return Object.fromEntries(
    Object.entries(tracker.merge_status ?? {}).map(([type, merged]) => [type, { start: tracker.open_status?.[type], review: tracker.open_status?.[type], merged, revert: tracker.revert_status?.[type] }]),
  );
}

export function statusEvent({ prs, started }) {
  const relevant = prs.filter((pr) => pr.base === pr.integration && pr.state !== "closed");
  const merged = relevant.filter((pr) => pr.state === "merged");
  const lastWork = merged.filter((pr) => !REVERT.test(pr.title)).map((pr) => pr.mergedAt).sort().at(-1) ?? "";
  if (merged.some((pr) => REVERT.test(pr.title) && pr.mergedAt > lastWork)) return "revert";
  if (relevant.some((pr) => pr.state === "open" && !REVERT.test(pr.title))) return "review";
  if (merged.some((pr) => !REVERT.test(pr.title))) return "merged";
  return started ? "start" : null;
}

export function planStatus(facts, tracker) {
  const flow = flowOf(tracker)[facts.type];
  if (!flow) return { skip: `type ${facts.type} has no flow in the map` };
  const event = statusEvent(facts);
  if (!event) return { skip: "no PR into the integration branch and the work has not started" };
  const override = facts.authorRoles.map((role) => flow.by_role?.[role]).find(Boolean) ?? {};
  const merged = override.merged ?? flow.merged;
  const to = event === "merged" ? merged : flow[event];
  if (!to) return { skip: `type ${facts.type} has no ${event} status in the map` };
  const assign = event === "merged" && override.assign === "author" ? "author" : null;
  const chain = [...new Set([...(tracker.not_started ?? []), flow.start, flow.review, merged])];
  const inFlow = new Set([flow.start, flow.review, flow.merged, flow.revert, ...Object.values(flow.by_role ?? {}).map((role) => role.merged)]);
  if (facts.status === to) return assign && !facts.assigneeIsAuthor ? { to, assign, event } : { skip: `already ${to}` };
  if (event === "revert") return inFlow.has(facts.status) ? { to, assign, event } : { skip: `${facts.status} is outside the flow, so a person set it` };
  const at = chain.indexOf(facts.status);
  if (at < 0) return { skip: `${facts.status} is outside the flow, so a person set it` };
  if (at > chain.indexOf(to)) return { skip: `already past ${to} (${facts.status})` };
  return { to, assign, event };
}
