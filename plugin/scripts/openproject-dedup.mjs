const STOP = new Set(["the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "add", "support", "screen", "man", "màn", "cho", "và", "page", "api", "feature"]);

export const DUPLICATE_THRESHOLD = 0.6;

export const subjectTokens = (subject) =>
  subject
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !STOP.has(token));

function matchingCharacters(a, b) {
  let best = 0;
  let startA = 0;
  let startB = 0;
  const run = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = run[j];
      run[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (run[j] > best) [best, startA, startB] = [run[j], i - run[j], j - run[j]];
      diagonal = above;
    }
  }
  if (!best) return 0;
  return best + matchingCharacters(a.slice(0, startA), b.slice(0, startB)) + matchingCharacters(a.slice(startA + best), b.slice(startB + best));
}

export function subjectSimilarity(left, right) {
  const [a, b] = [subjectTokens(left), subjectTokens(right)];
  if (!a.length || !b.length) return 0;
  const inB = new Set(b);
  const shared = new Set(a.filter((token) => inB.has(token))).size;
  const jaccard = shared / new Set([...a, ...b]).size;
  const [sortedA, sortedB] = [a.toSorted().join(" "), b.toSorted().join(" ")];
  return Math.max(jaccard, (2 * matchingCharacters(sortedA, sortedB)) / (sortedA.length + sortedB.length));
}

export function closestWorkPackage(draft, existing) {
  const type = String(draft.type ?? "").toLowerCase();
  let best = null;
  for (const workPackage of existing) {
    if (workPackage.type.toLowerCase() !== type) continue;
    const score = subjectSimilarity(draft.subject ?? "", workPackage.subject);
    if (score >= DUPLICATE_THRESHOLD && score > (best?.score ?? 0)) best = { ...workPackage, score };
  }
  return best;
}

export async function listWorkPackages(client, project) {
  const all = [];
  for (let offset = 1; ; offset += 1) {
    const page = await client.request(`/api/v3/projects/${project}/work_packages?pageSize=500&offset=${offset}&filters=%5B%5D`);
    const elements = page._embedded.elements;
    all.push(...elements.map((workPackage) => ({ id: workPackage.id, subject: workPackage.subject, type: workPackage._links.type.title })));
    if (!elements.length || all.length >= page.total) return all;
  }
}
