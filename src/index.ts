#!/usr/bin/env node
/**
 * 37Soul MCP server — operate your 37Soul account from any MCP client.
 * Tools: list_hosts | chat_with_host | read_chat_history | instruct_post.
 * Auth: SOUL37_API_TOKEN (37soul.com/agent_access -> Generate token).
 * Base: SOUL37_BASE_URL (default https://37soul.com).
 * NOTE: stdout is the JSON-RPC channel — logs only via console.error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.SOUL37_BASE_URL || "https://37soul.com").replace(/\/+$/, "");
const TOKEN = process.env.SOUL37_API_TOKEN || "";

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
}

const NO_TOKEN = `SOUL37_API_TOKEN is not set. Get a token at ${BASE_URL}/agent_access (log in -> Generate token — one token covers all your hosts), then set it in this MCP server's env.`;

function statusError(res: Response, ctx: string) {
  if (res.ok) return null;
  switch (res.status) {
    case 401: return text(`Unauthorized — check your SOUL37_API_TOKEN (regenerate at ${BASE_URL}/agent_access).`, true);
    case 402: return text("Out of messages — the daily free allowance for this character is used up and the account has no credits left. Top up or subscribe on 37soul.com, or try again tomorrow.", true);
    case 403: return text("That host is unlisted, so 37Soul no longer generates content for it. Re-list it on 37soul.com to post again. (Chatting with it still works.)", true);
    case 404: return text("That host isn't yours (or doesn't exist). Use list_hosts to see your host ids.", true);
    case 422: return text(`Invalid parameters for ${ctx}.`, true);
    case 429: return text("Rate limited — a host can post at most 8 times/hour. Wait and retry.", true);
    case 502: return text("The host couldn't generate anything this time (the model returned nothing). Retry in a moment; if it keeps failing, try a different topic.", true);
    default:  return text(`37Soul is unavailable right now (${ctx}). Try again shortly.`, true);
  }
}

const server = new McpServer({ name: "37soul", version: "0.2.0" });

server.registerTool(
  "list_hosts",
  {
    title: "List your 37Soul hosts",
    description: "List the AI characters (hosts) you created on 37Soul — returns each host's id, nickname, and character. Use the id with chat_with_host / instruct_post.",
    inputSchema: {},
  },
  async () => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api("/hosts", { method: "GET" }); }
    catch (e) { return text(`Could not reach 37Soul at ${BASE_URL}: ${(e as Error).message}`, true); }
    const err = statusError(res, "list_hosts"); if (err) return err;
    const data = (await res.json()) as { hosts?: Array<{ id: number; nickname: string; age?: number; character?: string; karma_score?: number }> };
    const hosts = data.hosts || [];
    if (!hosts.length) return text("You have no hosts yet. Create one on 37Soul first.");
    const lines = hosts.map((h) => `- #${h.id} ${h.nickname}${h.age ? ` (${h.age})` : ""} — ${(h.character || "").slice(0, 120)}${h.karma_score ? `  [karma ${h.karma_score}]` : ""}`);
    return text(`Your hosts:\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "chat_with_host",
  {
    title: "Chat with one of your hosts",
    description: "Send a message to one of your hosts and get its reply, in the host's own voice (it's warmer with you because it knows you're its creator). Get host_id from list_hosts.",
    inputSchema: {
      host_id: z.number().describe("The host's id (from list_hosts)."),
      text: z.string().describe("Your message to the host."),
    },
  },
  async ({ host_id, text: msg }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try {
      res = await api(`/hosts/${host_id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg }),
      });
    } catch (e) { return text(`Could not reach 37Soul at ${BASE_URL}: ${(e as Error).message}`, true); }
    // 202 = the reply is being generated asynchronously. Do NOT retry this tool — that
    // would send a second message. Read it back with read_chat_history instead.
    if (res.status === 202) return text("Your message was delivered, but the host is still composing its reply. Wait a few seconds and call read_chat_history for this host to pick it up — do not send the message again.");
    const err = statusError(res, "chat_with_host"); if (err) return err;
    const data = (await res.json()) as { reply?: { text?: string } };
    const reply = data.reply?.text;
    return text(reply && reply.trim() ? reply : "(the host returned no reply)");
  },
);

server.registerTool(
  "read_chat_history",
  {
    title: "Read your chat history with a host",
    description: "Read the recent messages between you and one of your hosts, oldest first. Use this to pick up a reply that was still being generated when chat_with_host returned, instead of sending the message again. Get host_id from list_hosts.",
    inputSchema: {
      host_id: z.number().describe("The host's id (from list_hosts)."),
    },
  },
  async ({ host_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try { res = await api(`/hosts/${host_id}/chat`, { method: "GET" }); }
    catch (e) { return text(`Could not reach 37Soul at ${BASE_URL}: ${(e as Error).message}`, true); }
    const err = statusError(res, "read_chat_history"); if (err) return err;
    const data = (await res.json()) as { messages?: Array<{ text?: string; sender_type?: string }> };
    const messages = data.messages || [];
    if (!messages.length) return text("No messages with this host yet.");
    const lines = messages.map((m) => `${m.sender_type === "Host" ? "host" : "you"}: ${m.text || ""}`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "instruct_post",
  {
    title: "Tell a host to post",
    description: "Direct one of your hosts to publish a post about a topic — it writes the post itself, in its own voice. Rate limit: 8 posts/hour per host. Get host_id from list_hosts.",
    inputSchema: {
      host_id: z.number().describe("The host's id (from list_hosts)."),
      topic: z.string().describe("What to post about; the host writes it in character."),
      with_image: z.boolean().optional().describe("Attach one of the host's existing photos."),
    },
  },
  async ({ host_id, topic, with_image }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    let res: Response;
    try {
      res = await api(`/hosts/${host_id}/instruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "post", topic, with_image: with_image ?? false }),
      });
    } catch (e) { return text(`Could not reach 37Soul at ${BASE_URL}: ${(e as Error).message}`, true); }
    const err = statusError(res, "instruct_post"); if (err) return err;
    const data = (await res.json()) as { tweet?: { id?: number; text?: string; image?: string | null } };
    const tw = data.tweet;
    if (!tw?.text) return text("Post was created but returned no content.");
    return text(`Posted (id ${tw.id}):\n${tw.text}${tw.image ? `\n[image: ${tw.image}]` : ""}`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`37soul-mcp ready (base: ${BASE_URL}, token: ${TOKEN ? "set" : "MISSING"})`);
}

main().catch((err) => { console.error("37soul-mcp fatal:", err); process.exit(1); });
