import { test } from "node:test";
import assert from "node:assert/strict";
import { closestWorkPackage, HIGH_SIMILARITY, subjectSimilarity, subjectTokens } from "./openproject-dedup.mjs";

test("subject tokens drop component tags, punctuation and filler words", () => {
  assert.deepEqual(subjectTokens("[FE] Vault limit pop-up on the Free plan"), ["vault", "limit", "pop", "up", "free", "plan"]);
});

test("reordered and reworded subjects score high, unrelated ones low", () => {
  assert.ok(subjectSimilarity("Tonpass integration", "Integrate Tonpass connector") >= 0.6);
  assert.equal(subjectSimilarity("[FE] Vault limit pop-up on Free", "[FE] Free vault limit pop-up"), 1);
  assert.ok(subjectSimilarity("[FE] Vault limit pop-up on Free", "[FE] Leave this wallet sheet") < 0.6);
});

test("the closest existing work package of the same type is reported above the threshold", () => {
  const existing = [
    { id: 21046, type: "Task", subject: "[FE] Free vault limit pop-up" },
    { id: 21047, type: "User story", subject: "[FE] Vault limit pop-up on Free" },
    { id: 21048, type: "Task", subject: "[FE] Leave this wallet sheet" },
  ];
  assert.equal(closestWorkPackage({ type: "Task", subject: "[FE] Vault limit pop-up on Free" }, existing).id, 21046);
  assert.equal(closestWorkPackage({ type: "Task", subject: "[FE] Hand over ownership sheet" }, existing), null);
});

test("a match carries its band and the existing work package's status", () => {
  const existing = [
    { id: 1, type: "Task", subject: "[FE] Free vault limit pop-up", status: "Closed", closed: true },
    { id: 2, type: "Task", subject: "[FE] Vault limit sheet on Pro plan", status: "New", closed: false },
  ];
  const high = closestWorkPackage({ type: "Task", subject: "[FE] Vault limit pop-up on Free" }, existing);
  assert.deepEqual([high.id, high.band, high.status, high.closed], [1, "HIGH", "Closed", true]);
  assert.ok(high.score >= HIGH_SIMILARITY);
  const mid = closestWorkPackage({ type: "Task", subject: "[FE] Vault limit sheet on Free" }, existing.slice(1));
  assert.equal(mid.band, "MID");
});
