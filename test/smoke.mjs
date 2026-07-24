#!/usr/bin/env node
/**
 * End-to-end smoke test: mock 37Soul API + drive the real server over stdio JSON-RPC.
 * It covers the complete MCP surface, asynchronous operations, local validation, and
 * every status the agent API can return.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let status = 200;
let nextOperationId = 1;
const operations = new Map();
const operationsByKey = new Map();
const seen = [];

const operation = (action, idempotencyKey) => {
  const existing = operationsByKey.get(`${action}:${idempotencyKey}`);
  if (existing) return { id: existing.id, action, status: "queued", result: {}, error: null };

  const id = nextOperationId++;
  const result = action === "chat"
    ? { reply: { id: 2, text: "还行，又通宵改稿哈哈" } }
    : { tweet: { id: 987, text: "凌晨三点的显示器", image: null } };
  const created = { id, action, status: "succeeded", result, error: null };
  operations.set(id, created);
  operationsByKey.set(`${action}:${idempotencyKey}`, created);
  return { id, action, status: "queued", result: {}, error: null };
};

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idempotencyKey: req.headers["idempotency-key"], body });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer tok_test") return send(401, { error: "unauthorized" });
    if (status !== 200) return send(status, { error: "forced" });
    if (req.url === "/api/v1/me/hosts" && req.method === "GET")
      return send(200, { hosts: [{ id: 262, nickname: "Nyx", age: 25, character: "night owl illustrator", karma_score: 120 }] });
    if (req.url === "/api/v1/me/hosts/262" && req.method === "GET")
      return send(200, { host: { id: 262, nickname: "Nyx", character: "night owl illustrator", greeting: "hi", preferred_channel_ids: [3] } });
    if (req.url === "/api/v1/me/hosts/262" && req.method === "PATCH")
      return send(200, { host: { id: 262, nickname: "Nyx" } });
    if (req.url === "/api/v1/me/hosts/262/photos" && req.method === "GET")
      return send(200, { photos: [{ id: 7, caption: "studio", image: "https://files.example/7.webp", order: 0 }] });
    if (req.url.startsWith("/api/v1/me/operations/") && req.method === "GET") {
      const id = Number(req.url.split("/").pop());
      return operations.has(id) ? send(200, { operation: operations.get(id) }) : send(404, { error: "missing" });
    }
    if (req.url === "/api/v1/me/hosts/999/chat") return;
    if (req.url === "/api/v1/me/hosts/998/chat" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>not json</html>");
    }
    if (req.url === "/api/v1/me/hosts/997/instruct") {
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end("{broken");
    }
    if (req.url.endsWith("/chat") && req.method === "POST")
      return send(202, { operation: operation("chat", String(req.headers["idempotency-key"])) });
    if (req.url.endsWith("/chat") && req.method === "GET")
      return send(200, { messages: [
        { id: 1, text: "在忙吗", sender_type: "User" },
        { id: 2, text: "不忙，刚收工", sender_type: "Host" },
      ] });
    if (req.url.endsWith("/posts") && req.method === "GET")
      return send(200, { posts: [
        { id: 987, text: "凌晨三点的显示器", image: null, created_at: "2026-07-22T09:00:00Z" },
      ] });
    if (req.url.endsWith("/instruct") && req.method === "POST")
      return send(202, { operation: operation("post", String(req.headers["idempotency-key"])) });
    send(404, { error: "nope" });
  });
});
await new Promise((r) => api.listen(0, r));
const port = api.address().port;
const stateDirectory = mkdtempSync(path.join(tmpdir(), "37soul-mcp-smoke-"));
const statePath = path.join(stateDirectory, "operations.json");
const serverEnv = {
  ...process.env,
  SOUL_API_TOKEN: "tok_test", // Compatibility alias used by prior skill installs.
  SOUL37_BASE_URL: `http://127.0.0.1:${port}/`,
  SOUL37_API_TIMEOUT_MS: "1000",
  SOUL37_OPERATION_STATE_PATH: statePath,
};

const connectClient = async (name) => {
  const client = new Client({ name, version: "1" });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: serverEnv,
    stderr: "ignore",
  }));
  return client;
};

const client = await connectClient("smoke");

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content[0].text, isError: !!r.isError };
};

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message.replaceAll("\n", "\n       ")}`); }
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("exposes the nine documented tools", () =>
  assert.deepEqual(names, ["chat_with_host", "get_host", "get_operation", "instruct_post", "list_hosts", "read_chat_history", "read_host_photos", "read_recent_posts", "update_host"]));

const hosts = await call("list_hosts");
check("list_hosts renders the host line", () => assert.match(hosts.text, /#262 Nyx \(25\)/));
check("legacy SOUL_API_TOKEN alias authenticates requests", () =>
  assert.equal(seen.at(-1).auth, "Bearer tok_test"));

const fullHost = await call("get_host", { host_id: 262 });
check("get_host renders editable fields", () => assert.match(fullHost.text, /preferred channels: 3/));

const updated = await call("update_host", { host_id: 262, greeting: "new hello" });
check("update_host confirms the update", () => assert.match(updated.text, /Updated host #262/));
check("update_host sends only documented fields", () => assert.match(seen.at(-1).body, /"greeting":"new hello"/));

const photos = await call("read_host_photos", { host_id: 262 });
check("read_host_photos returns image details", () => assert.match(photos.text, /studio/));

const chat = await call("chat_with_host", { host_id: 262, text: "最近怎么样？" });
check("chat_with_host polls the operation and relays the reply", () => assert.match(chat.text, /又通宵改稿/));
const chatRequest = seen.findLast((request) => request.url.endsWith("/chat") && request.method === "POST");
check("chat_with_host supplies an idempotency key", () => assert.match(chatRequest.idempotencyKey, /^[0-9a-f-]{36}$/));
const retriedChat = await call("chat_with_host", { host_id: 262, text: "最近怎么样？" });
check("a repeated chat intent reuses its idempotency key", () => {
  assert.match(retriedChat.text, /又通宵改稿/);
  const chatRequests = seen.filter((request) => request.url.endsWith("/chat") && request.method === "POST");
  assert.equal(chatRequests.at(-1).idempotencyKey, chatRequests.at(-2).idempotencyKey);
  assert.equal(operations.size, 1);
});
const deliberateRepeat = await call("chat_with_host", { host_id: 262, text: "最近怎么样？", new_intent: true });
check("new_intent deliberately creates a new chat operation", () => {
  assert.match(deliberateRepeat.text, /又通宵改稿/);
  const chatRequests = seen.filter((request) => request.url.endsWith("/chat") && request.method === "POST");
  assert.notEqual(chatRequests.at(-1).idempotencyKey, chatRequests.at(-2).idempotencyKey);
  assert.equal(operations.size, 2);
});
check("the durable idempotency ledger stores neither token nor message text", () => {
  const ledger = readFileSync(statePath, "utf8");
  assert.doesNotMatch(ledger, /tok_test|最近怎么样/);
});

const hist = await call("read_chat_history", { host_id: 262 });
check("read_chat_history shows both sides oldest-first", () => {
  assert.match(hist.text, /在忙吗/);
  assert.match(hist.text, /刚收工/);
  assert.ok(hist.text.indexOf("在忙吗") < hist.text.indexOf("刚收工"));
});

const recent = await call("read_recent_posts", { host_id: 262 });
check("read_recent_posts reports recent posts", () => assert.match(recent.text, /#987/));

const post = await call("instruct_post", { host_id: 262, topic: "熬夜", with_image: false });
check("instruct_post polls and reports the published text", () => assert.match(post.text, /凌晨三点的显示器/));
const postRequest = seen.findLast((request) => request.url.endsWith("/instruct") && request.method === "POST");
check("post writes a boolean image flag and idempotency key", () => {
  assert.match(postRequest.body, /"with_image":false/);
  assert.match(postRequest.idempotencyKey, /^[0-9a-f-]{36}$/);
});

const checked = await call("get_operation", { operation_id: 1 });
check("get_operation returns a completed operation result", () => assert.match(checked.text, /又通宵改稿/));

const seenBeforeValidation = seen.length;
const invalid = await call("chat_with_host", { host_id: -1, text: "x" });
check("invalid input is rejected locally without an API request", () => {
  assert.ok(invalid.isError);
  assert.equal(seen.length, seenBeforeValidation);
});

const malformed = await call("read_chat_history", { host_id: 998 });
check("invalid JSON is returned as a safe tool error", () => {
  assert.ok(malformed.isError);
  assert.match(malformed.text, /invalid response/i);
});

const timedOut = await call("chat_with_host", { host_id: 999, text: "hello" });
check("POST timeout warns that the result may be committed", () => {
  assert.ok(timedOut.isError);
  assert.match(timedOut.text, /timed out/i);
  assert.match(timedOut.text, /may still have been delivered/i);
});

const incompletePost = await call("instruct_post", { host_id: 997, topic: "hello" });
check("incomplete POST response is treated as an unknown result", () => {
  assert.ok(incompletePost.isError);
  assert.match(incompletePost.text, /may still have been published/i);
});

const errorCases = [
  [401, "instruct_post", /token/i],
  [402, "chat_with_host", /credit|limit/i],
  [403, "instruct_post", /unlisted/i],
  [404, "instruct_post", /isn't yours|not/i],
  [409, "instruct_post", /idempotency/i],
  [422, "instruct_post", /invalid/i],
  [429, "instruct_post", /8 posts|processing|rate/i],
  [502, "instruct_post", /may still have been published/i],
  [502, "chat_with_host", /may still have been delivered/i],
  [500, "instruct_post", /may still have been published/i],
];
for (const [code, tool, pattern] of errorCases) {
  status = code;
  const r = await call(tool, { host_id: 262, text: "x", topic: "x" });
  check(`HTTP ${code} → actionable message, flagged as error`, () => {
    assert.ok(r.isError);
    assert.match(r.text, pattern);
    assert.doesNotMatch(r.text, /HTTP \d\d\d/);
  });
}
status = 200;

await client.close();
const restartedClient = await connectClient("restart");
const restartedRetry = await restartedClient.callTool({
  name: "chat_with_host",
  arguments: { host_id: 262, text: "最近怎么样？" },
});
check("the idempotency ledger survives an MCP restart", () => {
  assert.match(restartedRetry.content[0].text, /又通宵改稿/);
  const chatRequests = seen.filter((request) => request.url.endsWith("/chat") && request.method === "POST");
  assert.equal(chatRequests.at(-1).idempotencyKey, chatRequests.at(-2).idempotencyKey);
  assert.equal(operations.size, 3);
});
await restartedClient.close();
api.close();
rmSync(stateDirectory, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
