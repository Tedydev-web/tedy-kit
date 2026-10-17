const idOf = (href) => Number(href.split("/").pop());
const ends = (relation) => [idOf(relation._links.from.href), idOf(relation._links.to.href)];

export const relationLine = (relation) => `relation ${relation.id}: #${ends(relation)[0]} ${relation.type} #${ends(relation)[1]}`;

export const pairRelation = (relations, a, b) => relations.find((relation) => ends(relation).includes(a) && ends(relation).includes(b) && a !== b) ?? null;

export const says = (relation, from, type) => (relation.type === type && ends(relation)[0] === from) || (relation.reverseType === type && ends(relation)[1] === from);

const relationsOf = async (client, id) => (await client.request(`/api/v3/work_packages/${id}/relations`))._embedded.elements;

const create = (client, from, type, to) =>
  client.request(`/api/v3/work_packages/${from}/relations`, { method: "POST", body: { type, _links: { from: { href: `/api/v3/work_packages/${from}` }, to: { href: `/api/v3/work_packages/${to}` } } } });

async function printRelations(client, ids) {
  for (const id of ids) {
    console.log(`#${id} relations:`);
    for (const relation of await relationsOf(client, id)) console.log(`  ${relationLine(relation)}`);
  }
}

export async function setRelation(client, from, to, flags) {
  if (typeof flags.type !== "string") throw new Error("relation needs --type <relates|blocks|precedes|follows|duplicates|includes|requires>");
  if (from === to) throw new Error("relation needs two different work packages");
  const old = pairRelation(await relationsOf(client, from), from, to);
  if (old && says(old, from, flags.type)) {
    console.log(`refused: ${relationLine(old)} already says this`);
    return 1;
  }
  console.log(`#${from} → #${to}: ${old ? relationLine(old) : "no relation"} → #${from} ${flags.type} #${to}`);
  if (flags.apply === undefined) {
    console.log(`WRITE → ${client.host} · #${from} #${to} : ${old ? "1 relation delete + " : ""}1 relation create; run again with --apply`);
    return 0;
  }
  if (old) await client.request(`/api/v3/relations/${old.id}`, { method: "DELETE" });
  try {
    await create(client, from, flags.type, to);
  } catch (error) {
    console.log(`create failed: ${error.message}`);
    if (old) {
      const [oldFrom, oldTo] = ends(old);
      await create(client, oldFrom, old.type, oldTo).then(
        () => console.log(`restored #${oldFrom} ${old.type} #${oldTo}`),
        (restoreError) => console.log(`restore failed, recreate #${oldFrom} ${old.type} #${oldTo} by hand: ${restoreError.message}`),
      );
    }
    await printRelations(client, [from, to]);
    return 1;
  }
  const read = pairRelation(await relationsOf(client, from), from, to);
  const ok = Boolean(read && says(read, from, flags.type));
  console.log(ok ? `set ${relationLine(read)}` : `created but the read-back shows ${read ? relationLine(read) : "no relation"}; open #${from} and check`);
  return ok ? 0 : 1;
}

export async function deleteRelation(client, id, flags) {
  const relation = await client.request(`/api/v3/relations/${id}`);
  console.log(relationLine(relation));
  if (flags.apply === undefined) {
    console.log(`WRITE → ${client.host} · #${ends(relation).join(" #")} : 1 relation delete; run again with --apply`);
    return 0;
  }
  await client.request(`/api/v3/relations/${id}`, { method: "DELETE" });
  const left = (await relationsOf(client, ends(relation)[0])).some((other) => other.id === relation.id);
  console.log(left ? `relation ${id} is still there on read-back; open #${ends(relation)[0]} and check` : `deleted relation ${id}`);
  return left ? 1 : 0;
}
