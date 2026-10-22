const FIELDS = [
  ["id", "id"],
  ["type", "type"],
  ["subject", "subject"],
  ["status", "status"],
  ["priority", "priority"],
  ["assignee", "assignee"],
  ["startDate", "start"],
  ["dueDate", "due"],
  ["estimate", "estimate"],
  ["parent", "parent"],
  ["relates", "relates"],
  ["blocks", "blocks"],
  ["precedes", "precedes"],
  ["follows", "follows"],
  ["merge", "merge"],
  ["fields", "fields"],
];
const KNOWN = new Set(["slug", "description", ...FIELDS.map(([key]) => key)]);

const shown = (value) => {
  if (Array.isArray(value)) return value.map((item) => (item !== null && typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ");
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
};

const present = (value) => value !== undefined && !(Array.isArray(value) && !value.length);

export function renderWorkPackageDraft(draft, step) {
  const extra = Object.keys(draft).filter((key) => !KNOWN.has(key)).sort().map((key) => [key, key]);
  const action = step.action === "create" ? "action create" : `action ${step.action} #${step.id}`;
  const lines = [`task ${draft.slug}`, action, ...[...FIELDS, ...extra].filter(([key]) => present(draft[key])).map(([key, label]) => `${label}: ${shown(draft[key])}`)];
  if (typeof draft.description === "string") lines.push("description:", ...draft.description.split("\n"));
  return lines.join("\n");
}

export const renderRollbackItem = (item) => `#${item.id} ${item.subject}`;

export const renderDocComment = (item, tab) => [`EPIC ${item.epic} · tab ${tab} · ${item.where}`, `quote: ${item.quote}`, item.comment.trim()].join("\n");

export const approvalLines = (blocks) => `approval lines:\n${blocks.join("\n\n")}`;
