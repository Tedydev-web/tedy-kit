import { test } from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "./api-request.mjs";

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
