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

// 协议 v2：mock 的 /soul 带 you_are / core_version，并认 core_version 参数。
let CORE_262 = "cv262"; // I4: 需要在测试中间改一次版本，验证「人设变了」的提醒
let soulMood = "今天有点想闹腾";
let turnDelayMs = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// I1: 追踪 /turn 是否曾经并发在途 —— 在请求体读完（路由分支执行）时加一，
// 在延迟响应发出之后减一。真正串行的写回永远看不到「加一时已经有一个在途」。
let turnInFlight = 0;
let turnOverlap = false;
let host500Attempts = 0;

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
    if (req.url?.startsWith("/api/v1/me/hosts") && req.method === "GET" && !req.url.slice("/api/v1/me/hosts".length).match(/^\/\d/)) {
      const url = new URL(req.url, "http://127.0.0.1");
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
      const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
      const all = [
        { id: 262, nickname: "Nyx", age: 25, karma_score: 120 },
        { id: 261, nickname: "Luna", age: 22, karma_score: 40 },
        { id: 260, nickname: "Zephyr", age: 28, karma_score: 10 },
      ];
      const page = all.slice(offset, offset + limit);
      return send(200, {
        hosts: page,
        pagination: { total: all.length, limit, offset, has_more: offset + page.length < all.length },
      });
    }
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
    if (req.url.startsWith("/api/v1/me/hosts/262/soul") && req.method === "GET") {
      const unchanged = new URL(req.url, "http://x").searchParams.get("core_version") === CORE_262;
      return send(200, {
        you_are: "You are Nyx, 25, female (host #262) — the same person your SOUL.md describes; what follows is what is true of her today.",
        host: unchanged
          ? { id: 262, nickname: "Nyx", age: 25, sex: "female" }
          : { id: 262, nickname: "Nyx", age: 25, sex: "female", character: "night owl illustrator", greeting: "hi" },
        core_version: CORE_262,
        mood: { key: "playful", line: soulMood },
        relationship: {
          summary: "聊过三次，主要聊工作",
          facts: [{ kind: "fact", content: "养了只叫 Mochi 的狗" }],
          temperature: "warm",
          days_since_last_talk: 1,
          messages_exchanged: 12,
        },
        recent_life: [{ text: "今天把稿子改完了", image: "https://files.example/desk.webp" }],
        photos: [{ caption: "天台", url: "https://files.example/roof.webp" }],
        videos: [{ caption: "风车", url: "https://files.example/mill.mp4" }],
        thread: { text: "把那批照片重新洗一遍", kind: "doing", days_in: 2, resolution: null },
        circle: [{ nickname: "沈青", closeness: "familiar", mutual: true, interactions: 5 }],
        directive: {
          action: "SHARE",
          instruction: "---\nTHIS TURN — SHARE: Answer them briefly, then bring up something from your own week.",
          min_reply_length: 150,
        },
        // 后端终审裁定：guidance 每次都发（三条禁令管的是每次都发的字段），core_version 只省人设原文。
        guidance: "You are still yourself.",
        ...(unchanged ? { core: "unchanged" } : {}),
      });
    }
    // I3: 402 host 的 /soul，同样的形状，不一样的名字 —— 用来验证提示排在身份之后，
    // you_are 仍然是第一行。
    if (req.url.startsWith("/api/v1/me/hosts/402/soul") && req.method === "GET") {
      return send(200, {
        you_are: "You are Rae, 24, female (host #402) — the same person your SOUL.md describes; what follows is what is true of her today.",
        host: { id: 402, nickname: "Rae", age: 24, sex: "female", character: "quiet baker", greeting: "hey" },
        core_version: "cv402",
        mood: { key: "calm", line: "还行" },
        relationship: { summary: null, facts: [], temperature: "new", days_since_last_talk: null, messages_exchanged: 0 },
      });
    }
    if (req.url === "/api/v1/me/hosts/262/facts" && req.method === "POST") {
      const parsedBody = JSON.parse(body || "{}");
      // 用户在网页上删过的那条：服务端返回墓碑，不复活。
      if (parsedBody.content === "不想再提前任")
        return send(200, { fact: { id: 9, kind: "fact", content: "不想再提前任", dismissed: true } });
      // M10: TaskFactGate 拒收的任务型事实 —— 422 带改写建议，不是通用报错。
      if (parsedBody.content === "run bin/render-build.sh to deploy")
        return send(422, {
          error: "This looks like a task fact, not something about the person.",
          matched: ["shell_command", "source_extension"],
          hint: "Build commands, code style and tooling belong in your own memory, not hers. If this really " +
                "is about them — e.g. \"they are building a project called render-build\" — say it as a sentence " +
                "about the person and send it again.",
        });
      return send(201, { fact: { id: 8, kind: parsedBody.kind || "fact", content: parsedBody.content, dismissed: false } });
    }
    if (req.url.endsWith("/media") && req.method === "POST") {
      const parsedBody = JSON.parse(body || "{}");
      // 用 host id 选错误码，这样一个桩就能覆盖全部分支
      const hostId = req.url.match(/hosts\/(\d+)\/media/)[1];
      if (hostId === "402") return send(402, { error: "insufficient_credits" });
      if (hostId === "429") return send(429, { error: "rate_limited" });
      if (hostId === "503") return send(503, { error: "generation_failed" });
      if (hostId === "409") return send(409, { error: "already_pending" });
      if (parsedBody.kind === "video")
        return send(202, { kind: "video", status: "generating", credits_remaining: 34 });
      return send(201, { kind: "photo", url: "https://files.37soul.com/p/new.webp",
                         caption: "窗边的信封", credits_remaining: 94 });
    }
    if (req.url === "/api/v1/me/hosts/262/turn" && req.method === "POST") {
      if (turnInFlight > 0) turnOverlap = true;
      turnInFlight++;
      return setTimeout(() => {
        send(201, { messages: [{ id: 21, source: "agent" }, { id: 22, source: "agent" }] });
        turnInFlight--;
      }, turnDelayMs);
    }
    if (req.url === "/api/v1/me/hosts/402/turn" && req.method === "POST")
      return send(402, { error: "Out of messages" });
    if (req.url === "/api/v1/me/hosts/500/turn" && req.method === "POST") {
      host500Attempts++;
      if (host500Attempts === 1) return send(500, { error: "boom" });
      return send(201, { messages: [] });
    }
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

const connectClient = async (name, extraEnv = {}) => {
  const client = new Client({ name, version: "1" });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...serverEnv, ...extraEnv },
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
// 这条断言 2026-09-08 救了一次：服务端 POST /media 上线当天 MCP 没跟，agent 只好
// 满硬盘 grep 文档、抠 credentials.json 手写 curl。工具表是 agent 唯一看得见的
// 能力清单 —— 服务端加了能力而这里没加，等于没上线。
check("exposes the thirteen documented tools", () =>
  assert.deepEqual(names, ["chat_with_host", "get_host", "get_operation", "instruct_post", "list_hosts", "log_turn", "read_chat_history", "read_host_photos", "read_recent_posts", "remember", "shoot", "update_host", "whoami"]));

const hosts = await call("list_hosts");
check("list_hosts renders a compact host line", () => {
  assert.match(hosts.text, /#262 Nyx \(25\).*karma 120/);
  assert.match(hosts.text, /1-3 of 3/);
  assert.doesNotMatch(hosts.text, /night owl|character:/i);
});
check("legacy SOUL_API_TOKEN alias authenticates requests", () =>
  assert.equal(seen.at(-1).auth, "Bearer tok_test"));

const paged = await call("list_hosts", { limit: 1, offset: 1 });
check("list_hosts pages with limit and offset", () => {
  assert.match(paged.text, /#261 Luna \(22\)/);
  assert.match(paged.text, /2-2 of 3/);
  assert.match(paged.text, /offset=2/);
  const listReq = seen.findLast((request) => request.url.startsWith("/api/v1/me/hosts") && request.method === "GET" && !request.url.match(/\/hosts\/\d/));
  assert.match(listReq.url, /limit=1/);
  assert.match(listReq.url, /offset=1/);
});

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

// ── 人格模式：0.5.0 上线 whoami / remember 时没更新工具名断言，这两个工具此前
// 没有任何 smoke 覆盖。log_turn 一起补上。
const soul = await call("whoami", { host_id: 262 });
const soulRequest = seen.filter((r) => r.url.startsWith("/api/v1/me/hosts/262/soul")).at(-1);

check("whoami sends a turn token, so the directive is not frozen and the turn is billed once", () =>
  assert.match(soulRequest.url, /[?&]turn=[^&]+/));

check("whoami renders her own life, not just her character", () => {
  assert.match(soul.text, /night owl illustrator/);
  assert.match(soul.text, /今天有点想闹腾/);
  assert.match(soul.text, /今天把稿子改完了/);          // recent_life
  assert.match(soul.text, /files\.example\/desk\.webp/); // 动态自带的图
  assert.match(soul.text, /把那批照片重新洗一遍/);       // thread
  assert.match(soul.text, /沈青/);                        // circle
  assert.match(soul.text, /files\.example\/roof\.webp/); // photos
  assert.match(soul.text, /files\.example\/mill\.mp4/);  // videos
  assert.match(soul.text, /warm/);                        // temperature
  assert.match(soul.text, /THIS TURN — SHARE/);
});

check("whoami tells the agent to send the exchange back", () =>
  assert.match(soul.text, /log_turn/));

check("whoami 的 THIS TURN 正文里站内格式已经洗掉了", () => {
  const thisTurnSection = soul.text.split("\n\n").find((section) => section.startsWith("THIS TURN —"));
  assert.ok(thisTurnSection, "no THIS TURN section rendered");
  assert.doesNotMatch(thisTurnSection, /---/);
  assert.doesNotMatch(thisTurnSection, /THIS TURN — SHARE:/); // 前缀只在标题行，不在正文里重复
});

// ── 协议 v2 · whoami ────────────────────────────────────────────────
const soulUrls = () => seen.filter((r) => r.url.startsWith("/api/v1/me/hosts/262/soul")).map((r) => r.url);
check("第一次 whoami 手上没有缓存，要完整的核心", () =>
  assert.doesNotMatch(soulUrls()[0], /core_version=/));
// 0.7 以前 MCP 从不转 you_are，自己拼一句 "You are Nyx"。服务端那句才带「你就是
// SOUL.md 里那个人」和「名字对不上怎么办」，所以第一行必须是它。
check("whoami 第一行是服务端的 you_are，不是本地拼的", () =>
  assert.match(soul.text.split("\n")[0], /same person your SOUL\.md describes/));
check("whoami 的说明不再要求每轮都调", () => {
  const d = tools.find((t) => t.name === "whoami").description;
  assert.match(d, /not every turn/i);
  assert.doesNotMatch(d, /START OF EVERY TURN/);
});
check("log_turn 只给聊天用，干活的轮次不写", () =>
  assert.match(tools.find((t) => t.name === "log_turn").description, /skip it for pure work/i));
check("whoami 结尾不再说「每次都回写」，并且不许把回写说给对方听", () => {
  assert.match(soul.text, /skip it for pure work/i);
  assert.match(soul.text, /never mention saving or logging/i);
});

// ── 协议 v2 · log_turn ──────────────────────────────────────────────
// 等 whoami 之后那次后台预取落地，再改她的心情 —— 下一次预取才会看到变化。
await sleep(300);
soulMood = "有点累，但挺安静";
turnDelayMs = 1500;
const loggedAt = Date.now();
const logged = await call("log_turn", { host_id: 262, user_message: "我这周把猫接回来了", host_message: "那家伙终于回家了" });
const loggedTook = Date.now() - loggedAt;
check("log_turn 不等网络（写回在后台）", () => assert.ok(loggedTook < 700, `took ${loggedTook}ms`));
check("log_turn 明说不许告诉对方", () => assert.match(logged.text, /do not mention this to them/i));
check("log_turn 再钉一次她是谁", () => assert.match(logged.text, /You are Nyx/));
check("log_turn 交出下一轮的意图，说明是下一句不是这一句", () =>
  assert.match(logged.text, /For your NEXT reply \(not the one you are finishing now\) — SHARE/));
check("log_turn 的下一轮意图带上这周的素材", () =>
  assert.match(logged.text, /\(from your week: 今天把稿子改完了\)/));
check("log_turn 的下一轮意图里站内格式已经洗掉了", () => {
  assert.doesNotMatch(logged.text, /---/);
  assert.doesNotMatch(logged.text, /THIS TURN —/);
});
await sleep(2000);
const logged2 = await call("log_turn", { host_id: 262, user_message: "你今天怎么样", host_message: "有点累，不过还好" });
check("她变了什么，跟着 log_turn 回来", () => assert.match(logged2.text, /有点累，但挺安静/));
await sleep(2000);
turnDelayMs = 0;
check("后台预取带着 core_version，人设不重发", () => assert.match(soulUrls().at(-1), /core_version=cv262/));

// ── I1: 同一个角色的后台写回排队 ──────────────────────────────────
turnDelayMs = 800;
turnInFlight = 0;
turnOverlap = false;
const serializedAt = Date.now();
const [logA, logB] = await Promise.all([
  call("log_turn", { host_id: 262, user_message: "queue one", host_message: "reply one" }),
  call("log_turn", { host_id: 262, user_message: "queue two", host_message: "reply two" }),
]);
check("两次 log_turn 都立即返回，不等排队里的写回", () => {
  assert.equal(logA.isError, false);
  assert.equal(logB.isError, false);
  assert.ok(Date.now() - serializedAt < 700);
});
await sleep(2200); // 两次 800ms 的写回严格串行需要 ~1600ms+，留够余量
check("同一个角色的后台写回严格排队，不会并发在途", () => assert.equal(turnOverlap, false));
check("两次写回按 log_turn 的调用顺序落地", () => {
  const queueRequests = seen.filter((r) => r.url === "/api/v1/me/hosts/262/turn" && r.method === "POST");
  const indexOne = queueRequests.findIndex((r) => r.body.includes("queue one"));
  const indexTwo = queueRequests.findIndex((r) => r.body.includes("queue two"));
  assert.ok(indexOne !== -1 && indexTwo !== -1);
  assert.ok(indexOne < indexTwo);
});
turnDelayMs = 0;

const retryAt = Date.now();
const retried = await call("log_turn", { host_id: 500, user_message: "retry me", host_message: "ok" });
check("会先失败一次的写回也立即返回", () => {
  assert.equal(retried.isError, false);
  assert.ok(Date.now() - retryAt < 700);
});
await sleep(1500);
check("重试复用同一个 turn，而不是铸一个新的", () => {
  const retryRequests = seen.filter((r) => r.url === "/api/v1/me/hosts/500/turn" && r.method === "POST");
  assert.equal(retryRequests.length, 2);
  const turns = retryRequests.map((r) => JSON.parse(r.body).turn);
  assert.equal(turns[0], turns[1]);
});

// ── I4: 隔久了没读 whoami，log_turn 要提醒 ────────────────────────
// 独立进程、独立状态：只有它自己看得见自己的 lastWhoamiAt，不跟主流程的 host 262 state 打架。
const staleClient = await connectClient("stale-whoami", { SOUL37_WHOAMI_STALE_MS: "1000" });
const staleCall = async (name, args = {}) => {
  const r = await staleClient.callTool({ name, arguments: args });
  return { text: r.content[0].text, isError: !!r.isError };
};
await staleCall("whoami", { host_id: 262 });
await sleep(1200);
const staleLogged = await staleCall("log_turn", { host_id: 262, user_message: "hi", host_message: "hey" });
check("隔久了没读 whoami，log_turn 提醒重新读", () => assert.match(staleLogged.text, /call whoami/i));
await staleClient.close();

// ── shoot ──────────────────────────────────────────────────────────
// 服务端 2026-09-08 上线 POST /media 当天 MCP 没跟，agent 只好翻文档手写 curl。
// 补上工具之后，这里守的是它**行为对**，不只是**存在**。
const shot = await call("shoot", { host_id: 262 });
check("shoot 拿到照片后，把 markdown 写法直接交给模型", () => {
  // 交 markdown 而不是裸链接：log_turn 会把它转成站内标记，网站上也是一张真图。
  assert.match(shot.text, /!\[窗边的信封\]\(https:\/\/files\.37soul\.com\/p\/new\.webp\)/);
  assert.match(shot.text, /94/);
});
check("shoot 默认拍照片，不默默拍视频（视频贵得多）", () => {
  const req = seen.filter((r) => r.url.endsWith("/media")).at(-1);
  assert.equal(JSON.parse(req.body).kind, "photo");
});

const clip = await call("shoot", { host_id: 262, kind: "video" });
// 2026-09-08 实测：一条 4 秒片 94.6 秒出片。上一版文案写「几十秒到几分钟」，
// 模型自己挑了 sleep 50 → 必然扑空 → 报「没拍成」，而后端其实在正常生成。
// 所以等待时间写实测值，并且明说「查不到 ≠ 失败」。
check("等待时间是具体的，不是「几十秒到几分钟」", () => {
  assert.match(clip.text, /95 seconds/);
  assert.match(clip.text, /at least 100 seconds/);
});
check("说清查不到只是还没好，不是失败", () => {
  assert.match(clip.text, /NOT READY, not failed/);
});
// 秒数是给 agent 排等待用的，**不是给她说的**。人不会报「大概一分半就好」——
// 那是机器在说话。两个读者必须在文案里分开，否则模型会把 95 秒原样转述出去。
check("明确禁止把秒数说给用户", () => {
  assert.match(clip.text, /do not say any of these numbers out loud/i);
  assert.match(clip.text, /No countdown, no seconds/i);
});
check("视频是异步的，明确指向 read_chat_history 而不是相册", () => {
  assert.match(clip.text, /read_chat_history/);
  // ⚠️ 私聊里买的媒体永远不进公开相册，模型去 whoami 的 videos 里等会等到天荒地老
  assert.match(clip.text, /never enters her public album/i);
  assert.doesNotMatch(clip.text, /!\[/);
});

// 这四个码在 /media 上的语义和别处不同，不能落进通用的 statusError：
// 403 在别处是「host 未上架」，503 在别处只说「稍后重试」——这里还必须说清钱退了。
for (const [id, why] of [
  ["402", /out of credits/i],
  ["429", /too many/i],
  ["503", /refunded/i],
  ["409", /still being shot/i],
]) {
  const failed = await call("shoot", { host_id: Number(id) });
  check(`shoot HTTP ${id} → 说得清下一步该干嘛`, () => {
    assert.equal(failed.isError, true);
    assert.match(failed.text, why);
  });
  // 每条拒绝都得**两半齐全**：WHY 给模型判断，TO THEM 是她能说的话。
  // 只有 WHY 的话，模型会把「账户余额不足」原样念给用户 —— 她不会那样说话。
  check(`shoot HTTP ${id} → 分开了「给模型的原因」和「她怎么说」`, () => {
    assert.match(failed.text, /^WHY:/m);
    assert.match(failed.text, /TO THEM, as her:/);
  });
}
// 402 是最容易穿帮的一条：账户、额度、充值这三个词从她嘴里出来就露馅了。
check("402 明确禁用「账户/额度/充值」这几个词", async () => {
  const failed = await call("shoot", { host_id: 402 });
  assert.match(failed.text, /Do not say .*account.*credits.*top up/i);
});
check("log_turn writes both sides back", () => {
  const turnRequests = seen.filter((r) => r.url === "/api/v1/me/hosts/262/turn");
  const first = turnRequests.find((r) => r.body.includes("我这周把猫接回来了"));
  assert.ok(first, "the first exchange never reached /turn");
  assert.match(first.body, /那家伙终于回家了/);
});

// 协议 v2：计费只在写回上，turn 是它的幂等键 —— 每一轮都得是新的。
check("每次写回都带自己的 turn", () => {
  const turns = seen.filter((r) => r.url === "/api/v1/me/hosts/262/turn").map((r) => JSON.parse(r.body).turn);
  assert.ok(turns.length >= 2);
  assert.equal(new Set(turns).size, turns.length);
});

const deniedAt = Date.now();
const denied = await call("log_turn", { host_id: 402, user_message: "a", host_message: "b" });
check("写回会被拒也照样立即返回", () => {
  assert.equal(denied.isError, false);
  assert.ok(Date.now() - deniedAt < 700);
});
await sleep(300); // 让刚才那次写回落地、转成 "refused"，提示挂起
const soul402 = await call("whoami", { host_id: 402 });
check("提示挂起时，whoami 第一行仍然是 you_are，不是提示", () =>
  assert.match(soul402.text.split("\n")[0], /Rae/));
check("第一次转进 refused：下一次调用（这里是 whoami）说一次「没存上」", () => {
  assert.match(soul402.text, /An earlier exchange was not saved/);
  assert.match(soul402.text, /do not retry/);
});

const afterDenied = await call("log_turn", { host_id: 402, user_message: "c", host_message: "d" });
await sleep(300); // 这次写回同样 402，但状态没变（还是 refused）——不应该再提一次
const afterDenied2 = await call("log_turn", { host_id: 402, user_message: "e", host_message: "f" });
check("再来的 402 不会重复提示", () => {
  assert.doesNotMatch(afterDenied.text, /was not saved/i);
  assert.doesNotMatch(afterDenied2.text, /was not saved/i);
});

const soul2 = await call("whoami", { host_id: 262 });
check("consecutive whoami calls do not reuse one turn token", () => {
  const first = new URL(soulRequest.url, "http://x").searchParams.get("turn");
  const second = new URL(seen.filter((r) => r.url.startsWith("/api/v1/me/hosts/262/soul")).at(-1).url, "http://x").searchParams.get("turn");
  assert.notEqual(first, second);
  assert.ok(soul2.text.length > 0);
});

// 协议 v2 的部分加载：第二次读带上缓存的 core_version，服务端回 core:"unchanged"、
// 不带人设原文 —— 渲染出来的她必须还是完整的（从缓存补回），因为一个 MCP 进程
// 会跨很多段对话，新对话里第一次 whoami 不能没有她是谁。
check("第二次 whoami 带 core_version，服务端省掉人设，渲染仍从缓存补全", () => {
  const url = seen.filter((r) => r.url.startsWith("/api/v1/me/hosts/262/soul")).at(-1).url;
  assert.match(url, /core_version=cv262/);
  assert.match(soul2.text, /WHO YOU ARE\nnight owl illustrator/);
  assert.match(soul2.text, /YOUR GREETING\nhi/);
});

// ── I4: 人设变了要提醒 ─────────────────────────────────────────────
// 这个 client 手里缓存的 core_version 还是 cv262（上面两次 whoami 都没有改过它）。
// 现在把服务端的「当前版本」换掉，模拟「人设在别处被改了」：下一次写回触发的后台
// 预取会带回新版本号，发现跟 shownCoreVersion 对不上，下下次 log_turn 就该提醒。
CORE_262 = "cv262-v2";
await call("log_turn", { host_id: 262, user_message: "core change 1", host_message: "core change 1 reply" });
await sleep(500); // 让这次写回成功、触发的后台预取落地（拿到新版本号）
const afterCoreChange = await call("log_turn", { host_id: 262, user_message: "core change 2", host_message: "core change 2 reply" });
check("人设变了，log_turn 提醒重新读 whoami", () => assert.match(afterCoreChange.text, /Her persona changed/));

const longTurn = await call("log_turn", { host_id: 262, user_message: "hi", host_message: "x".repeat(1200) });
await sleep(300);
check("log_turn says which side it trimmed", () => {
  assert.match(longTurn.text, /trimmed to 800/);
  assert.equal(JSON.parse(seen.filter((r) => r.url === "/api/v1/me/hosts/262/turn").at(-1).body).host_message.length, 800);
});

const saved = await call("remember", { host_id: 262, content: "养了只叫 Mochi 的狗" });
check("remember confirms a real save", () => assert.match(saved.text, /Saved \[fact\]/));

const tombstoned = await call("remember", { host_id: 262, content: "不想再提前任" });
check("remember does not claim to have saved a fact the person deleted", () => {
  assert.doesNotMatch(tombstoned.text, /^Saved/m);
  assert.match(tombstoned.text, /deleted/);
});

// M10: TaskFactGate 的 422 带改写建议，remember 要把它转述出来，而不是回通用报错。
const taskFact = await call("remember", { host_id: 262, content: "run bin/render-build.sh to deploy" });
check("remember 转述 422 的改写建议，而不是通用的 Invalid parameters", () => {
  assert.ok(taskFact.isError);
  assert.match(taskFact.text, /Build commands, code style and tooling belong in your own memory/i);
  assert.doesNotMatch(taskFact.text, /^Invalid parameters for remember\.$/);
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

// Capture the key the first process last stored for this exact intent (after new_intent).
// Error-case chat posts with other text must not be compared as "previous request".
const sameIntentChat = (request) =>
  request.url.endsWith("/chat")
  && request.method === "POST"
  && request.body.includes("最近怎么样");
const priorSameIntentKey = seen.filter(sameIntentChat).at(-1).idempotencyKey;
const operationsBeforeRestart = operations.size;

await client.close();
const restartedClient = await connectClient("restart");
const restartedRetry = await restartedClient.callTool({
  name: "chat_with_host",
  arguments: { host_id: 262, text: "最近怎么样？" },
});
check("the idempotency ledger survives an MCP restart", () => {
  assert.match(restartedRetry.content[0].text, /又通宵改稿/);
  const after = seen.filter(sameIntentChat);
  assert.equal(after.at(-1).idempotencyKey, priorSameIntentKey);
  // Same key reuses the mock operation — no new operation row is created.
  assert.equal(operations.size, operationsBeforeRestart);
});
await restartedClient.close();
api.close();
rmSync(stateDirectory, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
