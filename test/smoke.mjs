#!/usr/bin/env node
/**
 * End-to-end smoke test: mock 37Soul API + drive the real server over stdio JSON-RPC.
 * No framework — `npm test`. Asserts tool surface, happy paths, and every status the
 * /api/v1/me contract can actually return.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let status = 200; // override to force an error path
const seen = [];

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (status !== 200) return send(status, { error: "forced" });
    if (req.url === "/api/v1/me/hosts")
      return send(200, { hosts: [{ id: 262, nickname: "Nyx", age: 25, character: "night owl illustrator", karma_score: 120 }] });
    if (req.url.endsWith("/chat") && req.method === "POST")
      return send(200, { message: { id: 1, text: "hi" }, reply: { id: 2, text: "还行，又通宵改稿哈哈" } });
    if (req.url.endsWith("/chat") && req.method === "GET")
      return send(200, { messages: [
        { id: 1, text: "在忙吗", sender_type: "User" },
        { id: 2, text: "不忙，刚收工", sender_type: "Host" },
      ] });
    if (req.url.endsWith("/instruct"))
      return send(201, { action: "post", tweet: { id: 987, text: "凌晨三点的显示器", image: null } });
    send(404, { error: "nope" });
  });
});
await new Promise((r) => api.listen(0, r));
const port = api.address().port;

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, SOUL37_API_TOKEN: "tok_test", SOUL37_BASE_URL: `http://127.0.0.1:${port}/` },
  stderr: "ignore",
}));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content[0].text, isError: !!r.isError };
};

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message.split("\n")[0]}`); }
};

// --- tool surface ---
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("exposes the four documented tools", () =>
  assert.deepEqual(names, ["chat_with_host", "instruct_post", "list_hosts", "read_chat_history"]));

// --- happy paths ---
const hosts = await call("list_hosts");
check("list_hosts renders the host line", () => assert.match(hosts.text, /#262 Nyx \(25\)/));

const chat = await call("chat_with_host", { host_id: 262, text: "最近怎么样？" });
check("chat_with_host relays the reply", () => assert.match(chat.text, /又通宵改稿/));

const hist = await call("read_chat_history", { host_id: 262 });
check("read_chat_history shows both sides oldest-first", () => {
  assert.match(hist.text, /在忙吗/);
  assert.match(hist.text, /刚收工/);
  assert.ok(hist.text.indexOf("在忙吗") < hist.text.indexOf("刚收工"), "order should be oldest-first");
});
check("read_chat_history uses GET, not POST", () => {
  const last = seen[seen.length - 1];
  assert.equal(last.method, "GET");
  assert.match(last.url, /\/chat$/);
});

const post = await call("instruct_post", { host_id: 262, topic: "熬夜", with_image: false });
check("instruct_post reports the published text", () => assert.match(post.text, /凌晨三点的显示器/));
check("with_image false is sent as a real boolean", () =>
  assert.match(seen[seen.length - 1].body, /"with_image":false/));

check("auth header is attached", () => assert.equal(seen[0].auth, "Bearer tok_test"));

// --- error contract: every status /api/v1/me can return ---
const errorCases = [
  [401, "instruct_post", /token/i],
  [402, "chat_with_host", /credit|limit/i],   // daily free messages used up, no credits
  [403, "instruct_post", /unlisted/i],        // platform stopped generating for this host
  [404, "instruct_post", /isn't yours|not/i],
  [422, "instruct_post", /invalid/i],
  [429, "instruct_post", /8 times|rate/i],
  [502, "instruct_post", /generat/i],         // upstream model produced nothing
];
for (const [code, tool, pattern] of errorCases) {
  status = code;
  const r = await call(tool, { host_id: 262, text: "x", topic: "x" });
  check(`HTTP ${code} → actionable message, flagged as error`, () => {
    assert.ok(r.isError, "should set isError");
    assert.match(r.text, pattern);
    assert.doesNotMatch(r.text, /HTTP \d\d\d/, "should not leak a raw status code");
  });
}
status = 200;

await client.close();
api.close();

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
