import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, requestJson } from "./api-request.mjs";

function stubFetch(statuses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(options.method);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return new Response(status === 200 ? '{"id":"1"}' : '{"message":"busy"}', { status, headers: { "retry-after": "0" } });
  };
  return calls;
}

const noWait = async () => {};

test("a GET is retried after a server error", async () => {
  const calls = stubFetch([503, 200]);
  assert.deepEqual(await requestJson("https://api.example.com/a", { wait: noWait }), { id: "1" });
  assert.equal(calls.length, 2);
});

test("a POST that met a server error is never sent twice, because the server may have saved it", async () => {
  const calls = stubFetch([502, 200]);
  await assert.rejects(requestJson("https://api.example.com/comments", { method: "POST", body: { message: "x" }, wait: noWait }), /HTTP 502/);
  assert.equal(calls.length, 1);
});

test("a rate-limited POST is retried, because the server refused it before saving", async () => {
  const calls = stubFetch([429, 200]);
  assert.deepEqual(await requestJson("https://api.example.com/comments", { method: "POST", body: { message: "x" }, wait: noWait }), { id: "1" });
  assert.deepEqual(calls, ["POST", "POST"]);
});

test("a Google quota 403 is retried and waits longer each time; a permission 403 is not", async () => {
  const waits = [];
  let n = 0;
  globalThis.fetch = async () => (n++ < 2 ? new Response('{"error":{"message":"Quota exceeded for quota metric \'Queries\'"}}', { status: 403 }) : new Response('{"id":"1"}', { status: 200 }));
  assert.deepEqual(await requestJson("https://www.googleapis.com/drive/v3/files/x", { wait: async (s) => waits.push(s) }), { id: "1" });
  assert.deepEqual(waits, [15, 30]);
  globalThis.fetch = async () => new Response('{"error":{"message":"The user does not have sufficient permissions"}}', { status: 403 });
  await assert.rejects(requestJson("https://www.googleapis.com/drive/v3/files/x", { wait: noWait }), /HTTP 403: The user does not have sufficient permissions/);
});

test("redact masks key-value secrets and token-shaped values but keeps the rest of the message", () => {
  const masked = redact("invalid apikey=" + "abcd1234efgh" + ', "token": "' + "s3cr3tvalue" + '", Authorization: Basic ' + "YXBpa2V5OmFiY2RlZmdoaWprbG1ub3A=" + ", sha " + "0123456789abcdef".repeat(2) + ", ghp_" + "abcdefghijklmnopqrstuvwxyz01");
  assert.doesNotMatch(masked, /abcd1234efgh|s3cr3tvalue|YXBpa2V5|0123456789abcdef0123|ghp_abcdef/);
  assert.match(masked, /^invalid apikey=\*\*\*/);
  assert.equal(redact("Subject can't be blank."), "Subject can't be blank.");
});

test("an error body that echoes a secret is redacted before it reaches the thrown message", async () => {
  globalThis.fetch = async () => new Response("bad request for apikey=topsecretvalue123", { status: 400 });
  await assert.rejects(requestJson("https://op.example/api/v3/x"), (error) => !error.message.includes("topsecretvalue123") && /apikey=\*\*\*/.test(error.message));
});
