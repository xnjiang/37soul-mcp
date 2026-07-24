#!/usr/bin/env node
/**
 * 37Soul MCP server — operate your 37Soul account from any MCP client.
 * Tools: list_hosts | get_host | update_host | read_host_photos | chat_with_host |
 *        read_chat_history | read_recent_posts | instruct_post | get_operation.
 * Auth: SOUL37_API_TOKEN (SOUL_API_TOKEN remains a compatibility alias).
 * Base: SOUL37_BASE_URL (default https://37soul.com).
 * NOTE: stdout is the JSON-RPC channel — logs only via console.error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const BASE_URL = (process.env.SOUL37_BASE_URL || "https://37soul.com").replace(/\/+$/, "");
const TOKEN = process.env.SOUL37_API_TOKEN || process.env.SOUL_API_TOKEN || "";
const configuredTimeout = Number.parseInt(process.env.SOUL37_API_TIMEOUT_MS || "", 10);
const API_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000
  ? Math.min(configuredTimeout, 300_000)
  : 20_000;
const POLL_REQUEST_TIMEOUT_MS = Math.min(API_TIMEOUT_MS, 2_000);
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const OPERATION_STATE_PATH = process.env.SOUL37_OPERATION_STATE_PATH
  || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "37soul-mcp", "operations.json");
const MCP_VERSION = "0.4.3";

type OperationLedgerEntry = {
  idempotencyKey: string;
  createdAt: number;
  operationId?: number;
};

type OperationLedger = Record<string, OperationLedgerEntry>;

function loadOperationLedger(): OperationLedger {
  try {
    const parsed = JSON.parse(readFileSync(OPERATION_STATE_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const candidate = entry as Partial<OperationLedgerEntry>;
      return typeof candidate.idempotencyKey === "string" && typeof candidate.createdAt === "number";
    })) as OperationLedger;
  } catch {
    return {};
  }
}

const operationLedger = loadOperationLedger();

function pruneOperationLedger(now = Date.now()) {
  for (const [fingerprint, entry] of Object.entries(operationLedger)) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) delete operationLedger[fingerprint];
  }
}

function persistOperationLedger() {
  try {
    pruneOperationLedger();
    mkdirSync(dirname(OPERATION_STATE_PATH), { recursive: true, mode: 0o700 });
    const temporaryPath = `${OPERATION_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(operationLedger), { mode: 0o600 });
    renameSync(temporaryPath, OPERATION_STATE_PATH);
  } catch (error) {
    // An unreadable local state directory must not block a creator action. The process
    // still preserves retries for its lifetime, and stderr stays off the MCP channel.
    console.error(`37soul-mcp could not persist its idempotency ledger: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function intentFingerprint(action: "chat" | "post", hostId: number, payload: Record<string, unknown>) {
  // The ledger never stores the token or user content. Including their digests scopes
  // a reused key to this account, host, action, and exact normalized request.
  return createHash("sha256")
    .update(JSON.stringify({
      baseUrl: BASE_URL,
      token: createHash("sha256").update(TOKEN).digest("hex"),
      action,
      hostId,
      payload,
    }))
    .digest("hex");
}

function idempotencyForIntent(
  action: "chat" | "post",
  hostId: number,
  payload: Record<string, unknown>,
  explicitKey?: string,
  newIntent = false,
) {
  if (explicitKey) return { idempotencyKey: explicitKey, fingerprint: null };

  const fingerprint = intentFingerprint(action, hostId, payload);
  pruneOperationLedger();
  const existing = operationLedger[fingerprint];
  if (existing && !newIntent) return { idempotencyKey: existing.idempotencyKey, fingerprint };

  const entry = { idempotencyKey: randomUUID(), createdAt: Date.now() };
  operationLedger[fingerprint] = entry;
  persistOperationLedger();
  return { idempotencyKey: entry.idempotencyKey, fingerprint };
}

function rememberOperation(fingerprint: string | null, operationId?: number) {
  if (!fingerprint || !operationId || !operationLedger[fingerprint]) return;
  operationLedger[fingerprint].operationId = operationId;
  persistOperationLedger();
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function api(path: string, init: RequestInit = {}, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  return fetch(`${BASE_URL}/api/v1/me${path}`, {
    ...init,
    headers,
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  });
}

const NO_TOKEN = `SOUL37_API_TOKEN is not set. Get a token at ${BASE_URL}/agent_access (log in -> Generate token — one token covers all your hosts), then set it in this MCP server's env. SOUL_API_TOKEN is accepted only as a compatibility alias.`;

function statusError(res: Response, ctx: string) {
  if (res.ok) return null;
  switch (res.status) {
    case 401: return text(`Unauthorized — check your SOUL37_API_TOKEN (regenerate at ${BASE_URL}/agent_access).`, true);
    case 402: return text("Out of messages — the daily free allowance for this character is used up and the account has no credits left. Top up or subscribe on 37soul.com, or try again tomorrow.", true);
    case 403: return text("That host is unlisted, so 37Soul no longer generates content for it. Re-list it on 37soul.com to post again. (Chatting with it still works.)", true);
    case 404: return text(ctx === "get_operation"
      ? "That operation does not exist or does not belong to this account."
      : "That host isn't yours (or doesn't exist). Use list_hosts to see your host ids.", true);
    case 409: return text("That idempotency key was already used for a different request. Start a new deliberate action instead of retrying this one.", true);
    case 422: return text(`Invalid parameters for ${ctx}.`, true);
    case 429: return text(ctx === "instruct_post"
      ? "Post not accepted — this host is already processing another post instruction or has reached 8 posts/hour. Wait before trying again."
      : "Rate limited by 37Soul. Wait before trying again.", true);
    case 502:
      if (ctx === "instruct_post") {
        return unknownPostResult(ctx, "37Soul could not confirm the post operation.");
      }
      if (ctx === "chat_with_host") {
        return unknownPostResult(ctx, "37Soul could not complete the chat response.");
      }
      return text(`37Soul is temporarily unavailable for ${ctx}. It is safe to retry this read operation.`, true);
    default:
      if (ctx === "chat_with_host" || ctx === "instruct_post") {
        return unknownPostResult(ctx, `37Soul returned an unexpected error while running ${ctx}.`);
      }
      return text(`37Soul is unavailable right now (${ctx}). Try again shortly.`, true);
  }
}

function unknownPostResult(ctx: string, prefix: string) {
  if (ctx === "chat_with_host") {
    return text(`${prefix} The message may still have been delivered. Do not send it again; use read_chat_history to check.`, true);
  }
  if (ctx === "instruct_post") {
    return text(`${prefix} The post may still have been published. Do not instruct it again; use read_recent_posts to check.`, true);
  }
  return text(`${prefix} The update may still have been applied. Read the host again before trying it another time.`, true);
}

function requestError(error: unknown, ctx: string, resultMayBeCommitted = false) {
  const cause = error instanceof Error ? error.cause : undefined;
  const errorDetails = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : "",
    cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "",
    cause instanceof Error ? cause.message : "",
  ].join(" ");
  const timedOut = /abort|timeout|timed out/i.test(errorDetails);
  const prefix = timedOut
    ? `37Soul timed out while running ${ctx}.`
    : `Could not reach 37Soul at ${BASE_URL} while running ${ctx}.`;
  if (resultMayBeCommitted) return unknownPostResult(ctx, prefix);
  return text(`${prefix} It is safe to retry this read operation.`, true);
}

async function responseJson<T>(res: Response, ctx: string, resultMayBeCommitted = false): Promise<T | ReturnType<typeof text>> {
  try {
    const raw = await res.text();
    if (!raw.trim()) throw new Error("empty response");
    return JSON.parse(raw) as T;
  } catch {
    if (resultMayBeCommitted) {
      return unknownPostResult(ctx, `37Soul returned an incomplete response for ${ctx}.`);
    }
    return text(`37Soul returned an invalid response for ${ctx}. Try again shortly.`, true);
  }
}

function isToolResult(value: unknown): value is ReturnType<typeof text> {
  return !!value && typeof value === "object" && "content" in value;
}

const hostIdSchema = z.number().int().positive().describe("The host's positive integer id (from list_hosts).");
const chatTextSchema = z.string().trim().min(1).max(800).describe("Your message to the host (1-800 characters).");
const topicSchema = z.string().trim().min(1).max(500).describe("What to post about (1-500 characters); the host writes it in character.");
const operationIdSchema = z.number().int().positive().describe("The operation id returned by chat_with_host or instruct_post.");
const hostCharacterSchema = z.string().trim().min(1).max(1_000).optional().describe("Updated character/personality text (up to 1,000 characters).");
const hostGreetingSchema = z.string().trim().max(800).optional().describe("Updated greeting text (up to 800 characters; use an empty string to clear it).");
const channelIdsSchema = z.array(z.number().int().positive()).max(20).optional().describe("Preferred channel ids, replacing the existing list.");
const idempotencyKeySchema = z.string().trim().min(1).max(128).optional().describe("Optional stable key for an external retry. Leave unset for MCP-managed idempotency.");
const newIntentSchema = z.boolean().optional().describe("Set true only to deliberately send the same text or topic again; normal retries reuse the prior operation for 24 hours.");

type AgentOperation = {
  id?: number;
  action?: "chat" | "post";
  status?: "queued" | "running" | "succeeded" | "failed";
  result?: {
    message?: { id?: number; text?: string };
    reply?: { id?: number; text?: string };
    tweet?: { id?: number; text?: string; image?: string | null };
  };
  error?: { code?: string; message?: string } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function operationText(operation: AgentOperation) {
  const id = operation.id ? `#${operation.id}` : "";
  if (operation.status === "succeeded") {
    if (operation.action === "chat") {
      const reply = operation.result?.reply?.text;
      return text(reply?.trim() || "The chat operation completed without a reply.");
    }
    const tweet = operation.result?.tweet;
    return text(tweet?.text
      ? `Posted (id ${tweet.id}):\n${tweet.text}${tweet.image ? `\n[image: ${tweet.image}]` : ""}`
      : "The post operation completed without returned content.");
  }
  if (operation.status === "failed") {
    const message = operation.error?.message || "The operation failed.";
    return text(`${message} (operation ${id})`, true);
  }
  return text(`Operation ${id} is ${operation.status || "pending"}. Use get_operation with operation_id ${operation.id} to check again.`);
}

async function readOperation(operationId: number, timeoutMs = API_TIMEOUT_MS): Promise<AgentOperation | ReturnType<typeof text>> {
  let res: Response;
  try { res = await api(`/operations/${operationId}`, { method: "GET" }, timeoutMs); }
  catch (e) { return requestError(e, "get_operation"); }
  const err = statusError(res, "get_operation"); if (err) return err;
  const parsed = await responseJson<{ operation?: AgentOperation }>(res, "get_operation");
  if (isToolResult(parsed)) return parsed;
  return parsed.operation || text("37Soul returned an operation without status information.", true);
}

async function waitForOperation(initial: AgentOperation) {
  let operation = initial;
  // Keep MCP responsive; long-running model work remains queryable via get_operation.
  for (let attempt = 0; attempt < 3 && (operation.status === "queued" || operation.status === "running"); attempt++) {
    await sleep(750);
    if (!operation.id) break;
    const next = await readOperation(operation.id, POLL_REQUEST_TIMEOUT_MS);
    if (isToolResult(next)) return next;
    operation = next;
  }
  return operationText(operation);
}

const server = new McpServer({ name: "37soul", version: MCP_VERSION });

const listLimitSchema = z.number().int().min(1).max(50).optional()
  .describe("Max hosts per page (default 20, max 50). Use with offset to page.");
const listOffsetSchema = z.number().int().min(0).optional()
  .describe("Number of hosts to skip (default 0).");

server.registerTool(
  "list_hosts",
  {
    title: "List your 37Soul hosts",
    description: "List the AI characters (hosts) you created on 37Soul as a compact directory (id, nickname, age, karma). Default page size is 20. Use get_host for character/greeting details. Pass limit/offset to page.",
    inputSchema: {
      limit: listLimitSchema,
      offset: listOffsetSchema,
    },
  },
  async ({ limit, offset }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));
    const query = params.toString();
    let res: Response;
    try { res = await api(`/hosts${query ? `?${query}` : ""}`, { method: "GET" }); }
    catch (e) { return requestError(e, "list_hosts"); }
    const err = statusError(res, "list_hosts"); if (err) return err;
    const parsed = await responseJson<{
      hosts?: Array<{ id: number; nickname: string; age?: number; sex?: string; karma_score?: number }>;
      pagination?: { total?: number; limit?: number; offset?: number; has_more?: boolean };
    }>(res, "list_hosts");
    if (isToolResult(parsed)) return parsed;
    const hosts = parsed.hosts || [];
    const pagination = parsed.pagination || {};
    const total = pagination.total ?? hosts.length;
    const pageLimit = pagination.limit ?? limit ?? 20;
    const pageOffset = pagination.offset ?? offset ?? 0;
    if (!hosts.length) {
      if (total > 0) {
        return text(`No hosts on this page (offset ${pageOffset} of ${total}). Try a smaller offset.`);
      }
      return text("You have no hosts yet. Create one on 37Soul first.");
    }
    const from = pageOffset + 1;
    const to = pageOffset + hosts.length;
    const lines = hosts.map((h) => {
      const age = h.age != null ? ` (${h.age})` : "";
      const karma = h.karma_score ? `  [karma ${h.karma_score}]` : "";
      return `- #${h.id} ${h.nickname}${age}${karma}`;
    });
    const more = pagination.has_more
      ? `\nMore available: call list_hosts with offset=${pageOffset + pageLimit} (limit=${pageLimit}).`
      : "";
    return text(`Your hosts (${from}-${to} of ${total}):\n${lines.join("\n")}${more}`);
  },
);

server.registerTool(
  "get_host",
  {
    title: "Read one of your 37Soul hosts",
    description: "Read the full editable profile of one host you own, including character, greeting, and preferred channel ids.",
    inputSchema: { host_id: hostIdSchema },
  },
  async ({ host_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api(`/hosts/${host_id}`, { method: "GET" }); }
    catch (e) { return requestError(e, "get_host"); }
    const err = statusError(res, "get_host"); if (err) return err;
    const parsed = await responseJson<{ host?: { id?: number; nickname?: string; character?: string; greeting?: string; preferred_channel_ids?: number[] } }>(res, "get_host");
    if (isToolResult(parsed)) return parsed;
    const host = parsed.host;
    if (!host?.id) return text("37Soul returned an incomplete host profile.", true);
    return text(`Host #${host.id} ${host.nickname || ""}\ncharacter: ${host.character || ""}\ngreeting: ${host.greeting || ""}\npreferred channels: ${(host.preferred_channel_ids || []).join(", ") || "none"}`);
  },
);

server.registerTool(
  "update_host",
  {
    title: "Update a 37Soul host profile",
    description: "Update low-risk owner profile fields for a host: character, greeting, or preferred channels. This cannot change billing, visibility, or publishing automation.",
    inputSchema: {
      host_id: hostIdSchema,
      character: hostCharacterSchema,
      greeting: hostGreetingSchema,
      preferred_channel_ids: channelIdsSchema,
    },
  },
  async ({ host_id, character, greeting, preferred_channel_ids }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const host = Object.fromEntries(Object.entries({ character, greeting, preferred_channel_ids }).filter(([, value]) => value !== undefined));
    if (!Object.keys(host).length) return text("Provide at least one of character, greeting, or preferred_channel_ids.", true);

    let res: Response;
    try {
      res = await api(`/hosts/${host_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      });
    } catch (e) { return requestError(e, "update_host", true); }
    const err = statusError(res, "update_host"); if (err) return err;
    const parsed = await responseJson<{ host?: { id?: number; nickname?: string } }>(res, "update_host", true);
    if (isToolResult(parsed)) return parsed;
    return parsed.host?.id
      ? text(`Updated host #${parsed.host.id} ${parsed.host.nickname || ""}.`)
      : text("37Soul updated the host but returned an incomplete response.", true);
  },
);

server.registerTool(
  "read_host_photos",
  {
    title: "Read a host's photo library",
    description: "List up to 50 photos belonging to one host you own. This is read-only; uploads and deletion require the website.",
    inputSchema: { host_id: hostIdSchema },
  },
  async ({ host_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api(`/hosts/${host_id}/photos`, { method: "GET" }); }
    catch (e) { return requestError(e, "read_host_photos"); }
    const err = statusError(res, "read_host_photos"); if (err) return err;
    const parsed = await responseJson<{ photos?: Array<{ id?: number; caption?: string; image?: string | null; order?: number }> }>(res, "read_host_photos");
    if (isToolResult(parsed)) return parsed;
    const photos = parsed.photos || [];
    if (!photos.length) return text("This host has no photos yet.");
    return text(`Host photos:\n${photos.map((photo) => `- #${photo.id} ${photo.caption || ""}\n  ${photo.image || "(no image)"}`).join("\n")}`);
  },
);

server.registerTool(
  "chat_with_host",
  {
    title: "Chat with one of your hosts",
    description: "Send a message to one of your hosts and get its reply, in the host's own voice (it's warmer with you because it knows you're its creator). Get host_id from list_hosts.",
    inputSchema: {
      host_id: hostIdSchema,
      text: chatTextSchema,
      idempotency_key: idempotencyKeySchema,
      new_intent: newIntentSchema,
    },
  },
  async ({ host_id, text: msg, idempotency_key, new_intent }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    if (idempotency_key && new_intent) return text("Use either idempotency_key for an external retry or new_intent for a deliberate repeat, not both.", true);
    const payload = { text: msg };
    const idempotency = idempotencyForIntent("chat", host_id, payload, idempotency_key, new_intent);
    let res: Response;
    try {
      res = await api(`/hosts/${host_id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency.idempotencyKey },
        body: JSON.stringify(payload),
      });
    } catch (e) { return requestError(e, "chat_with_host", true); }
    const err = statusError(res, "chat_with_host"); if (err) return err;
    const parsed = await responseJson<{ operation?: AgentOperation }>(res, "chat_with_host", true);
    if (isToolResult(parsed)) return parsed;
    if (!parsed.operation) return unknownPostResult("chat_with_host", "37Soul accepted the message but returned no operation id.");
    rememberOperation(idempotency.fingerprint, parsed.operation.id);
    return waitForOperation(parsed.operation);
  },
);

server.registerTool(
  "read_chat_history",
  {
    title: "Read your chat history with a host",
    description: "Read the recent messages between you and one of your hosts, oldest first. Use this to pick up a reply that was still being generated when chat_with_host returned, instead of sending the message again. Get host_id from list_hosts.",
    inputSchema: {
      host_id: hostIdSchema,
    },
  },
  async ({ host_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api(`/hosts/${host_id}/chat`, { method: "GET" }); }
    catch (e) { return requestError(e, "read_chat_history"); }
    const err = statusError(res, "read_chat_history"); if (err) return err;
    const parsed = await responseJson<{ messages?: Array<{ text?: string; sender_type?: string }> }>(res, "read_chat_history");
    if (isToolResult(parsed)) return parsed;
    const data = parsed;
    const messages = data.messages || [];
    if (!messages.length) return text("No messages with this host yet.");
    const lines = messages.map((m) => `${m.sender_type === "Host" ? "host" : "you"}: ${m.text || ""}`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "read_recent_posts",
  {
    title: "Read a host's recent posts",
    description: "Read the 20 most recent posts from one of your hosts, newest first. Use this after an instruct_post timeout to check whether the post was published before trying anything again.",
    inputSchema: {
      host_id: hostIdSchema,
    },
  },
  async ({ host_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api(`/hosts/${host_id}/posts`, { method: "GET" }); }
    catch (e) { return requestError(e, "read_recent_posts"); }
    const err = statusError(res, "read_recent_posts"); if (err) return err;
    const parsed = await responseJson<{ posts?: Array<{ id?: number; text?: string; image?: string | null; created_at?: string }> }>(res, "read_recent_posts");
    if (isToolResult(parsed)) return parsed;
    const posts = parsed.posts || [];
    if (!posts.length) return text("This host has no posts yet.");
    const lines = posts.map((post) => {
      const created = post.created_at ? ` ${post.created_at}` : "";
      const image = post.image ? `\n  [image: ${post.image}]` : "";
      return `- #${post.id}${created}\n  ${post.text || ""}${image}`;
    });
    return text(`Recent posts (newest first):\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "get_operation",
  {
    title: "Check a 37Soul operation",
    description: "Check the final result of a chat or post operation that is still queued or running. Use the operation_id returned by chat_with_host or instruct_post.",
    inputSchema: { operation_id: operationIdSchema },
  },
  async ({ operation_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const operation = await readOperation(operation_id);
    return isToolResult(operation) ? operation : operationText(operation);
  },
);

server.registerTool(
  "instruct_post",
  {
    title: "Tell a host to post",
    description: "Direct one of your hosts to publish a post about a topic — it writes the post itself, in its own voice. Rate limit: 8 posts/hour per host. Get host_id from list_hosts.",
    inputSchema: {
      host_id: hostIdSchema,
      topic: topicSchema,
      with_image: z.boolean().optional().describe("Attach one of the host's existing photos."),
      idempotency_key: idempotencyKeySchema,
      new_intent: newIntentSchema,
    },
  },
  async ({ host_id, topic, with_image, idempotency_key, new_intent }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    if (idempotency_key && new_intent) return text("Use either idempotency_key for an external retry or new_intent for a deliberate repeat, not both.", true);
    const payload = { action: "post", topic, with_image: with_image ?? false };
    const idempotency = idempotencyForIntent("post", host_id, payload, idempotency_key, new_intent);
    let res: Response;
    try {
      res = await api(`/hosts/${host_id}/instruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency.idempotencyKey },
        body: JSON.stringify(payload),
      });
    } catch (e) { return requestError(e, "instruct_post", true); }
    const err = statusError(res, "instruct_post"); if (err) return err;
    const parsed = await responseJson<{ operation?: AgentOperation }>(res, "instruct_post", true);
    if (isToolResult(parsed)) return parsed;
    if (!parsed.operation) return unknownPostResult("instruct_post", "37Soul accepted the post request but returned no operation id.");
    rememberOperation(idempotency.fingerprint, parsed.operation.id);
    return waitForOperation(parsed.operation);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`37soul-mcp ready (base: ${BASE_URL}, timeout: ${API_TIMEOUT_MS}ms, token: ${TOKEN ? "set" : "MISSING"})`);
}

main().catch((err) => { console.error("37soul-mcp fatal:", err); process.exit(1); });
