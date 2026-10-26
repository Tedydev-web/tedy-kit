const FENCE = /```[\s\S]*?```/g;
const CODE_SPAN = /`[^`\n]*`/g;
const BARE_REF = /(?<![\w&/])#{1,3}(\d+)(?!\w)/g;

export const bareWorkPackageRefs = (text) => [...new Set([...text.replace(FENCE, "").replace(CODE_SPAN, "").matchAll(BARE_REF)].map((match) => Number(match[1])))];

export async function foreignWorkPackageRefs(client, projectHref, text) {
  const foreign = [];
  for (const id of bareWorkPackageRefs(text)) {
    const href = await client.request(`/api/v3/work_packages/${id}`).then(
      (workPackage) => workPackage._links?.project?.href,
      (error) => {
        if (error.status === 404 || error.status === 403) return null;
        throw error;
      },
    );
    if (href !== projectHref) foreign.push(id);
  }
  return foreign;
}

export const foreignRefsAdvice = (ids) => `${ids.map((id) => `#${id}`).join(", ")} would link a work package outside this project; OpenProject links every bare #N, even after a backslash, so put a number that is not one of this project's work packages in backticks: \`#${ids[0]}\``;
