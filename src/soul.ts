/**
 * 人格状态（协议 v2）。
 *
 * whoami 不再每轮调，log_turn 不再等网络 —— 于是「今天的她」要在 MCP 进程里存一份：
 * 核心人设（用 core_version 判断有没有变）、上一次给模型看过的状态、后台预取好的
 * 下一轮、以及一条一次性提示（上次后台写回失败了）。这里只有纯逻辑，HTTP 在 index.ts。
 */

export type SoulHost = {
  id: number;
  nickname: string;
  age?: number | null;
  sex?: string | null;
  character?: string;
  greeting?: string;
};

export type SoulPayload = {
  you_are?: string;
  host?: SoulHost;
  core_version?: string;
  core?: "unchanged";
  mood?: { key?: string; line?: string };
  relationship?: {
    summary?: string | null;
    facts?: Array<{ kind: string; content: string; pinned?: boolean }>;
    temperature?: string;
    days_since_last_talk?: number | null;
    messages_exchanged?: number;
  };
  recent_life?: Array<{ text: string; image?: string | null; posted_at?: string }>;
  photos?: Array<{ caption?: string | null; url: string }>;
  videos?: Array<{ caption?: string | null; url: string }>;
  thread?: { text?: string; kind?: string; days_in?: number; resolution?: string | null } | null;
  circle?: Array<{ nickname: string; closeness?: string; mutual?: boolean; interactions?: number }>;
  directive?: { action?: string; instruction?: string; min_reply_length?: number };
  guidance?: string;
};

type Core = { version: string; character?: string; greeting?: string };

/** 给模型看过的「今天的她」，只留会变、且值得提一句的三样。 */
type Snapshot = { mood?: string; thread?: string; latestPost?: string };

type HostState = {
  core?: Core;
  nickname?: string;
  shown?: Snapshot;
  next?: SoulPayload;
  notice?: string;
};

const states = new Map<number, HostState>();

function stateFor(hostId: number): HostState {
  let s = states.get(hostId);
  if (!s) {
    s = {};
    states.set(hostId, s);
  }
  return s;
}

export function coreVersionFor(hostId: number): string | undefined {
  return states.get(hostId)?.core?.version;
}

function snapshotOf(p: SoulPayload): Snapshot {
  const th = p.thread;
  return {
    mood: p.mood?.line || undefined,
    thread: th?.text ? `${th.text}${th.resolution ? ` (${th.resolution === "went_well" ? "it worked out" : "it fell through"})` : ""}` : undefined,
    latestPost: p.recent_life?.[0]?.text || undefined,
  };
}

function changesBetween(before: Snapshot | undefined, after: Snapshot): string[] {
  if (!before) return [];
  const lines: string[] = [];
  if (after.mood && after.mood !== before.mood) lines.push(`- your mood now: ${after.mood}`);
  if (after.thread && after.thread !== before.thread) lines.push(`- what you're in the middle of: ${after.thread}`);
  if (after.latestPost && after.latestPost !== before.latestPost) lines.push(`- you just posted: ${after.latestPost}`);
  return lines;
}

/**
 * 服务端的指令原文是给站内 prompt 用的，带 `---` 分隔线和 `THIS TURN — WORD:` 前缀。
 * 对 agent 来说这两样都是噪音（`---` 像是被截断了，`THIS TURN` 前缀跟外面渲染的
 * 段落标题重复）——把它们去掉，只留给模型看的那句话本身。
 */
function cleanInstruction(raw: string): string {
  return raw
    .trim()
    .replace(/^---\s*/, "")
    .replace(/^THIS TURN — \w+:\s*/, "")
    .trim();
}

/** 服务端回 core:"unchanged" 时，从缓存把核心补回去；否则刷新缓存。返回补齐后的 payload。 */
function withCore(s: HostState, p: SoulPayload): SoulPayload {
  if (p.host?.nickname) s.nickname = p.host.nickname;
  if (p.core === "unchanged" && s.core && p.host) {
    return { ...p, host: { ...p.host, character: s.core.character, greeting: s.core.greeting } };
  }
  if (p.core_version) {
    s.core = { version: p.core_version, character: p.host?.character, greeting: p.host?.greeting };
  }
  return p;
}

export function absorbWhoami(hostId: number, payload: SoulPayload): SoulPayload {
  const s = stateFor(hostId);
  const full = withCore(s, payload);
  s.shown = snapshotOf(full);
  // 这一轮的意图就在 whoami 的结果里；「下一轮」等后台预取来填。
  s.next = undefined;
  return full;
}

export function absorbPrefetch(hostId: number, payload: SoulPayload): void {
  const s = stateFor(hostId);
  s.next = withCore(s, payload);
}

export function setNotice(hostId: number, notice: string): void {
  stateFor(hostId).notice = notice;
}

/** 取走一次性提示（给 whoami 用：它也该让模型知道上次没存上）。 */
export function takeNotice(hostId: number): string | undefined {
  const s = stateFor(hostId);
  const n = s.notice;
  s.notice = undefined;
  return n;
}

export function renderWhoami(p: SoulPayload): string {
  const h = p.host!;
  const facts = p.relationship?.facts || [];
  const sections: string[] = [];
  sections.push(p.you_are?.trim() || `You are ${h.nickname}${h.age != null ? `, ${h.age}` : ""}${h.sex ? `, ${h.sex}` : ""} (host #${h.id}).`);
  if (h.character) sections.push(`WHO YOU ARE\n${h.character}`);
  if (h.greeting) sections.push(`YOUR GREETING\n${h.greeting}`);
  if (p.mood?.line) sections.push(`TODAY'S MOOD\n${p.mood.line}${p.mood.key ? ` (${p.mood.key})` : ""}`);
  const rel = p.relationship;
  if (rel?.temperature) {
    const bits: string[] = [rel.temperature];
    if (rel.days_since_last_talk != null) bits.push(`last spoke ${rel.days_since_last_talk} day(s) ago`);
    if (rel.messages_exchanged) bits.push(`${rel.messages_exchanged} exchanged so far`);
    sections.push(`HOW THIS HAS FELT LATELY\n${bits.join(" · ")}`);
  }
  if (rel?.summary) sections.push(`YOUR RELATIONSHIP WITH THEM\n${rel.summary}`);
  if (facts.length) {
    sections.push(`WHAT YOU REMEMBER ABOUT THEM\n${facts.map((f) => `- [${f.kind}] ${f.content}`).join("\n")}`);
  } else {
    sections.push("WHAT YOU REMEMBER ABOUT THEM\n(nothing yet — save the first thing you learn with `remember`)");
  }

  const posts = p.recent_life || [];
  if (posts.length) {
    sections.push(`WHAT YOU'VE BEEN POSTING\n${posts
      .map((x) => `- ${x.text}${x.image ? `\n  picture: ${x.image}` : ""}`)
      .join("\n")}`);
  }

  const th = p.thread;
  if (th?.text) {
    const tail = th.resolution
      ? ` — it just ${th.resolution === "went_well" ? "worked out" : "fell through"}. Worth a line, then let it go.`
      : ` (started ${th.days_in ?? 0} day(s) ago, still going)`;
    sections.push(`WHAT YOU'RE IN THE MIDDLE OF\n${th.text}${tail}`);
  }

  const circle = p.circle || [];
  if (circle.length) {
    sections.push(`PEOPLE YOU KNOW HERE\n${circle
      .map((t) => `- ${t.nickname}${t.closeness ? ` (${t.closeness}${t.mutual ? ", mutual" : ""})` : ""}`)
      .join("\n")}\nOnly these. Inventing a friend for her is the fastest way to break her.`);
  }

  const shot = [
    ...(p.photos || []).map((x) => ({ ...x, kind: "photo" })),
    ...(p.videos || []).map((x) => ({ ...x, kind: "video" })),
  ];
  if (shot.length) {
    sections.push(`THINGS YOU'VE SHOT\n${shot
      .map((x) => `- ${x.kind}: ${x.caption || "(no caption)"} — ${x.url}`)
      .join("\n")}\nYou have no screen, but they do: if they ask where you have been shooting, answer from these and hand the link over.`);
  }

  if (p.directive?.instruction) {
    sections.push(`THIS TURN — ${p.directive.action || "DIRECTIVE"}\n${cleanInstruction(p.directive.instruction)}`);
  }
  if (p.guidance) sections.push(`HOW TO USE THIS\n${p.guidance.trim()}`);
  sections.push(
    "AFTER YOU REPLY\nIf they were talking with you as a person, send the exchange back with `log_turn`; " +
    "skip it for pure work (code, commands, files). Never mention saving or logging to them.",
  );
  return sections.join("\n\n");
}

/**
 * log_turn 的返回：一句身份、上次没存上的提示、她变了什么、下一轮的意图。
 * 给出之后，「下一轮」就算用掉了，「给模型看过的状态」前移到它。
 */
export function renderAfterLog(hostId: number, extra?: string): string {
  const s = stateFor(hostId);
  const lines: string[] = ["Done — do not mention this to them."];
  if (s.nickname) lines.push(`You are ${s.nickname}: speak in the first person, as yourself.`);
  if (s.notice) {
    lines.push(s.notice);
    s.notice = undefined;
  }
  if (s.next) {
    const now = snapshotOf(s.next);
    const changed = changesBetween(s.shown, now);
    if (changed.length) lines.push(`Since you last looked:\n${changed.join("\n")}`);
    const d = s.next.directive;
    if (d?.instruction) {
      let line = `For your NEXT reply (not the one you are finishing now) — ${d.action || "DIRECTIVE"}: ${cleanInstruction(d.instruction)}`;
      if (d.action === "CALLBACK") {
        const fact = s.next.relationship?.facts?.[0];
        if (fact?.content) line += ` (bring this back: ${fact.content})`;
      } else if (d.action === "SHARE") {
        const post = s.next.recent_life?.[0];
        if (post?.text) line += ` (from your week: ${post.text})`;
      }
      lines.push(line);
    }
    s.shown = now;
    s.next = undefined;
  }
  if (extra) lines.push(extra);
  return lines.join("\n");
}
