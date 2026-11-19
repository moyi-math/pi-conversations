/**
 * Session indexer: scans ~/.pi/agent/sessions/**\/*.jsonl, builds a small
 * metadata index, and stores per-session plain text in sidecar files for
 * full-text search.
 *
 * Design notes:
 * - A full parse of a large session history takes seconds, so results are
 *   cached by (mtimeMs, size) and only changed files are re-parsed.
 * - Conversation text lives in cache/text/<hash>.txt so index.json stays small.
 * - The index never mutates session files; see renameSession/deleteSession for
 *   the two explicit mutating operations.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CACHE_VERSION = 3;

/** Search text uses readable role markers so searching "user" does not match every session. */
const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  thinking: "思考",
  compaction: "压缩摘要",
  branch: "分支摘要",
  note: "备注",
};

const TEXT_PER_MESSAGE_LIMIT = 8_000;
const TEXT_PER_SESSION_LIMIT = 2_000_000;
const PARSE_CONCURRENCY = 6;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface DayBucket {
  messages: number;
  tokens: number;
  cost: number;
}

export interface SessionMeta {
  id: string;
  /** Absolute path to the .jsonl file. */
  path: string;
  cwd: string;
  /** Display name for the project group. */
  project: string;
  name?: string;
  /** ms since epoch. */
  created: number;
  /** ms since epoch, from file mtime. */
  modified: number;
  messageCount: number;
  userMessageCount: number;
  firstMessage: string;
  lastMessage: string;
  models: string[];
  usage: UsageTotals;
  byDay: Record<string, DayBucket>;
  sizeBytes: number;
  /** Absolute path to the cached text file. */
  textFile: string;
  parentSessionPath?: string;
}

interface CacheFile {
  version: number;
  builtAt: number;
  sessions: SessionMeta[];
  files: Record<string, { mtimeMs: number; size: number; textFile: string }>;
}

export interface IndexStatus {
  phase: "idle" | "scanning" | "parsing" | "done" | "error";
  loaded: number;
  total: number;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
}

export function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".pi", "agent");
}

export function sessionsRoot(): string {
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env && env.trim()) return path.resolve(env);
  try {
    const raw = fs.readFileSync(path.join(piAgentDir(), "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { sessionDir?: unknown };
    if (typeof settings.sessionDir === "string" && settings.sessionDir.trim()) {
      return path.resolve(settings.sessionDir);
    }
  } catch {
    // no settings or unreadable: fall through to default
  }
  return path.join(piAgentDir(), "sessions");
}

export function cacheDir(): string {
  return path.join(piAgentDir(), "cache", "pi-conversations");
}

export function trashDir(): string {
  return path.join(cacheDir(), "trash");
}

export function indexFilePath(): string {
  return path.join(cacheDir(), "index.json");
}

function textDir(): string {
  return path.join(cacheDir(), "text");
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…`;
}

function projectLabel(cwd: string): string {
  if (!cwd) return "未知目录";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return cwd;
  const base = path.basename(trimmed);
  if (base) return base;
  return trimmed;
}

function addUsage(target: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const total = num(u.totalTokens) || input + output + cacheRead + cacheWrite;
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.total += total;
  const cost = u.cost;
  if (cost && typeof cost === "object") {
    target.cost += num((cost as Record<string, unknown>).total);
  }
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** ANSI SGR sequences leak in from terminal output and would render as noise. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Extract displayable text from a message content field. */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content.replace(ANSI_PATTERN, "");
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
    else if (b.type === "image") parts.push("[图片]");
  }
  return parts.join("\n").replace(ANSI_PATTERN, "");
}

function dayKey(timestamp: unknown): string {
  if (typeof timestamp === "string") {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } else if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return "";
}

interface ParseResult {
  meta: Omit<SessionMeta, "modified" | "sizeBytes" | "textFile">;
  text: string;
}

function parseSessionContent(raw: string, filePath: string): ParseResult {
  const id = path.basename(filePath).replace(/\.jsonl$/, "");
  const sessionId = id.replace(/^.*?_/, "") || id;
  let cwd = "";
  let parentSessionPath: string | undefined;
  let created = 0;
  let name: string | undefined;
  let firstMessage = "";
  let lastMessage = "";
  let messageCount = 0;
  let userMessageCount = 0;

  const models = new Set<string>();
  const usage = emptyUsage();
  const byDay: Record<string, DayBucket> = {};
  const textParts: string[] = [];
  let textBudget = TEXT_PER_SESSION_LIMIT;

  const pushText = (label: string, text: string): void => {
    if (!text || textBudget <= 0) return;
    const clipped = clip(text.replace(/\r/g, "").trim(), TEXT_PER_MESSAGE_LIMIT);
    if (!clipped.trim()) return;
    const chunk = `\n〔${ROLE_LABEL[label] ?? label}〕\n${clipped}\n`;
    textParts.push(chunk);
    textBudget -= chunk.length;
  };

  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      if (typeof entry.parentSession === "string") parentSessionPath = entry.parentSession;
      if (typeof entry.timestamp === "string" && !created) {
        const t = new Date(entry.timestamp);
        if (!Number.isNaN(t.getTime())) created = t.getTime();
      }
      continue;
    }


    const ts = entry.timestamp;
    const day = dayKey(ts) || dayKey((entry.message as Record<string, unknown> | undefined)?.timestamp);

    if (entry.type === "session_info") {
      if (typeof entry.name === "string") name = entry.name;
      else if (entry.name === undefined) name = undefined;
      continue;
    }

    if (entry.type === "model_change") {
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
      if (modelId) models.add(provider ? `${provider}/${modelId}` : modelId);
      continue;
    }

    if (entry.type === "usage") {
      addUsage(usage, entry.usage);
      continue;
    }

    if (entry.type === "compaction") {
      if (typeof entry.summary === "string") pushText("compaction", entry.summary);
      addUsage(usage, entry.usage);
      continue;
    }

    if (entry.type === "branch_summary") {
      if (typeof entry.summary === "string") pushText("branch", entry.summary);
      addUsage(usage, entry.usage);
      continue;
    }

    if (entry.type === "custom_message") {
      const text = textOfContent(entry.content);
      if (text) pushText("note", text);
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const role = message.role;
    const text = textOfContent(message.content);

    if (role === "user") {
      messageCount += 1;
      userMessageCount += 1;
      if (!firstMessage && text.trim()) firstMessage = clip(text.trim(), 200);
      if (text.trim()) lastMessage = clip(text.trim(), 240);
      pushText("user", text);
      const bucket = day ? (byDay[day] ??= { messages: 0, tokens: 0, cost: 0 }) : undefined;
      if (bucket) bucket.messages += 1;
      continue;
    }

    if (role === "assistant") {
      messageCount += 1;
      const provider = typeof message.provider === "string" ? message.provider : "";
      const model = typeof message.model === "string" ? message.model : "";
      if (model) models.add(provider ? `${provider}/${model}` : model);
      const beforeCost = usage.cost;
      addUsage(usage, message.usage);
      const bucket = day ? (byDay[day] ??= { messages: 0, tokens: 0, cost: 0 }) : undefined;
      if (bucket) {
        bucket.messages += 1;
        bucket.cost += usage.cost - beforeCost;
      }
      if (text.trim()) {
        lastMessage = clip(text.trim(), 240);
        pushText("assistant", text);
      }
      continue;
    }

    if (role === "custom") {
      const customText = textOfContent(message.content);
      if (customText) pushText("note", customText);
      continue;
    }
    // toolResult and system messages stay out of the search text on purpose:
    // they dominate size and are rarely what a user searches for.
  }

  // Recompute per-day tokens from totals is not possible; keep message counts
  // and cost (accurate) plus an apportioned token estimate by message volume.
  const totalMessages = Object.values(byDay).reduce((sum, bucket) => sum + bucket.messages, 0);
  if (totalMessages > 0) {
    for (const bucket of Object.values(byDay)) {
      bucket.tokens = Math.round((usage.total * bucket.messages) / totalMessages);
    }
  }

  const headerIdCandidate = (() => {
    const first = raw.slice(0, raw.indexOf("\n"));
    try {
      const header = JSON.parse(first) as Record<string, unknown>;
      return typeof header.id === "string" ? header.id : "";
    } catch {
      return "";
    }
  })();

  return {
    meta: {
      id: headerIdCandidate || sessionId,
      path: filePath,
      cwd,
      project: projectLabel(cwd),
      name,
      created,
      messageCount,
      userMessageCount,
      firstMessage: firstMessage || name || "(空会话)",
      lastMessage,
      models: [...models],
      usage,
      byDay,
      parentSessionPath,
    },
    text: textParts.join(""),
  };
}

async function walkJsonl(dir: string, out: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

async function readCache(): Promise<CacheFile> {
  try {
    const raw = await fsp.readFile(indexFilePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.sessions)) {
      return { version: CACHE_VERSION, builtAt: 0, sessions: [], files: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, builtAt: 0, sessions: [], files: {} };
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, file);
}

export interface IndexState {
  sessions: SessionMeta[];
  builtAt: number;
  root: string;
}

export const indexStatus: IndexStatus = { phase: "idle", loaded: 0, total: 0 };

export async function readIndex(): Promise<IndexState> {
  const cache = await readCache();
  const sessions = cache.sessions
    .filter((session) => session && typeof session.path === "string")
    .sort((a, b) => b.modified - a.modified);
  return { sessions, builtAt: cache.builtAt, root: sessionsRoot() };
}

let refreshPromise: Promise<IndexState> | undefined;

/** Refresh the index. Concurrent callers share one run. */
export function refreshIndex(force = false): Promise<IndexState> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = runRefresh(force).finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}

async function runRefresh(force: boolean): Promise<IndexState> {
  const startedAt = Date.now();
  indexStatus.phase = "scanning";
  indexStatus.loaded = 0;
  indexStatus.total = 0;
  indexStatus.startedAt = startedAt;
  indexStatus.message = undefined;

  try {
    const root = sessionsRoot();
    const cache = await readCache();
    const files = await walkJsonl(root);
    indexStatus.total = files.length;
    indexStatus.phase = "parsing";

    // Cached transcripts contain whatever the conversations contain, so keep
    // them owner-only where the platform supports POSIX modes.
    await fsp.mkdir(textDir(), { recursive: true, mode: 0o700 });
    await fsp.chmod(textDir(), 0o700).catch(() => {});

    const nextFiles: CacheFile["files"] = {};
    const byPath = new Map(cache.sessions.map((session) => [session.path, session]));
    const results: SessionMeta[] = [];

    const queue = [...files];
    const worker = async (): Promise<void> => {
      for (;;) {
        const filePath = queue.shift();
        if (!filePath) return;
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          indexStatus.loaded += 1;
          continue;
        }
        const cached = cache.files[filePath];
        const cachedSession = byPath.get(filePath);
        const rel = path.relative(root, filePath);
        const textFile = path.join(textDir(), `${hash(rel)}.txt`);

        if (
          !force &&
          cached &&
          cachedSession &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size &&
          cached.textFile === textFile &&
          fs.existsSync(textFile)
        ) {
          nextFiles[filePath] = cached;
          results.push({ ...cachedSession, modified: stat.mtimeMs, sizeBytes: stat.size, textFile });
          indexStatus.loaded += 1;
          continue;
        }

        try {
          const raw = await fsp.readFile(filePath, "utf8");
          const parsed = parseSessionContent(raw, filePath);
          await fsp.writeFile(textFile, parsed.text, { encoding: "utf8", mode: 0o600 });
          const meta: SessionMeta = {
            ...parsed.meta,
            modified: stat.mtimeMs,
            sizeBytes: stat.size,
            textFile,
          };
          results.push(meta);
          nextFiles[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, textFile };
        } catch (error) {
          indexStatus.message = `解析失败: ${path.basename(filePath)}`;
          const fallback = cachedSession;
          if (fallback) {
            results.push(fallback);
            nextFiles[filePath] = cached ?? { mtimeMs: stat.mtimeMs, size: stat.size, textFile };
          }
        } finally {
          indexStatus.loaded += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, files.length || 1) }, worker));

    // Drop cache entries for deleted files.
    const liveTextFiles = new Set(Object.values(nextFiles).map((file) => file.textFile));
    try {
      const stale = await fsp.readdir(textDir());
      await Promise.all(
        stale.map(async (file) => {
          const full = path.join(textDir(), file);
          if (!liveTextFiles.has(full)) await fsp.rm(full, { force: true });
        }),
      );
    } catch {
      // cache dir may not exist on first run
    }

    const sessions = results.sort((a, b) => b.modified - a.modified);
    await writeJsonAtomic(indexFilePath(), {
      version: CACHE_VERSION,
      builtAt: Date.now(),
      sessions,
      files: nextFiles,
    } satisfies CacheFile);

    textCache.clear();
    indexStatus.phase = "done";
    indexStatus.finishedAt = Date.now();
    return { sessions, builtAt: Date.now(), root };
  } catch (error) {
    indexStatus.phase = "error";
    indexStatus.message = error instanceof Error ? error.message : String(error);
    indexStatus.finishedAt = Date.now();
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Full-text search                                                            */
/* -------------------------------------------------------------------------- */

interface TextCacheEntry {
  mtimeMs: number;
  text: string;
}

const textCache = new Map<string, TextCacheEntry>();
let textCacheBytes = 0;
const TEXT_CACHE_BUDGET = 96 * 1024 * 1024;

async function loadSessionText(session: SessionMeta): Promise<string> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fsp.stat(session.textFile)).mtimeMs;
  } catch {
    return "";
  }
  const cached = textCache.get(session.textFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  try {
    const text = await fsp.readFile(session.textFile, "utf8");
    if (cached) textCacheBytes -= cached.text.length;
    textCache.set(session.textFile, { mtimeMs, text });
    textCacheBytes += text.length;
    while (textCacheBytes > TEXT_CACHE_BUDGET && textCache.size > 1) {
      const oldest = textCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = textCache.get(oldest);
      if (entry) textCacheBytes -= entry.text.length;
      textCache.delete(oldest);
    }
    return text;
  } catch {
    return "";
  }
}

export interface SearchHit {
  session: SessionMeta;
  score: number;
  matches: number;
  snippets: string[];
}

function buildSnippets(text: string, terms: string[], maxSnippets: number): { snippets: string[]; matches: number } {
  if (!text) return { snippets: [], matches: 0 };
  const lower = text.toLowerCase();
  const snippets: string[] = [];
  let matches = 0;
  const seen = new Set<number>();
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      matches += 1;
      from = at + term.length;
      if (snippets.length >= maxSnippets) continue;
      if ([...seen].some((position) => Math.abs(position - at) < 120)) continue;
      seen.add(at);
      const start = Math.max(0, at - 70);
      const end = Math.min(text.length, at + term.length + 90);
      snippets.push(text.slice(start, end).replace(/\s+/g, " ").trim());
    }
  }
  return { snippets, matches };
}

export async function searchSessions(
  sessions: SessionMeta[],
  query: string,
  limit = 120,
): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  const queue = [...sessions];
  const worker = async (): Promise<void> => {
    for (;;) {
      const session = queue.shift();
      if (!session) return;
      const haystack = [
        session.name ?? "",
        session.firstMessage,
        session.lastMessage,
        session.cwd,
        session.project,
      ]
        .join("\n")
        .toLowerCase();
      let metaHit = terms.every((term) => haystack.includes(term));
      const text = await loadSessionText(session);
      const { snippets, matches } = text ? buildSnippets(text, terms, 3) : { snippets: [], matches: 0 };
      if (!metaHit && matches === 0) continue;
      if (!metaHit) {
        // every term must still appear somewhere in the corpus
        const lower = text.toLowerCase();
        if (!terms.every((term) => lower.includes(term))) continue;
        metaHit = true;
      }
      const score =
        matches + (session.name?.toLowerCase().includes(terms[0] ?? "") ? 40 : 0) + (session.modified / 1e13);
      hits.push({ session, score, matches, snippets });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, sessions.length || 1) }, worker));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Session detail                                                              */
/* -------------------------------------------------------------------------- */

export type DetailKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "branch"
  | "note"
  | "model"
  | "system";

export interface DetailEntry {
  id: string;
  parentId: string | null;
  ts: string;
  kind: DetailKind;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  model?: string;
  provider?: string;
  tokens?: number;
}

export interface SessionDetail {
  meta: SessionMeta;
  entries: DetailEntry[];
  truncated: boolean;
  branches: number;
  leafId: string | null;
}

const DETAIL_ENTRY_LIMIT = 4000;

export async function readSessionDetail(filePath: string, metaHint?: SessionMeta): Promise<SessionDetail> {
  const raw = await fsp.readFile(filePath, "utf8");
  const stat = await fsp.stat(filePath);
  const meta = metaHint ?? (await readIndex()).sessions.find((session) => session.path === filePath);
  const entries: DetailEntry[] = [];
  const children = new Map<string | null, number>();
  let truncated = false;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") continue;
    if (entries.length >= DETAIL_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    children.set(parentId, (children.get(parentId) ?? 0) + 1);

    if (entry.type === "message") {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const role = message.role;
      const tsMs = message.timestamp;
      const iso = typeof tsMs === "number" ? new Date(tsMs).toISOString() : ts;
      if (role === "user") {
        entries.push({ id, parentId, ts: iso, kind: "user", text: textOfContent(message.content) });
      } else if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        const textParts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            entries.push({ id: `${id}:think`, parentId, ts: iso, kind: "thinking", text: b.thinking });
          }
        }
        const text = textParts.join("\n");
        if (text.trim()) {
          const usage = message.usage as Record<string, unknown> | undefined;
          entries.push({
            id,
            parentId,
            ts: iso,
            kind: "assistant",
            text,
            model: typeof message.model === "string" ? message.model : undefined,
            provider: typeof message.provider === "string" ? message.provider : undefined,
            tokens: usage ? num(usage.totalTokens) || num(usage.input) + num(usage.output) : undefined,
          });
        }
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type !== "toolCall") continue;
          const args = b.arguments ?? b.input;
          let argText = "";
          try {
            argText = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 2);
          } catch {
            argText = String(args);
          }
          entries.push({
            id: `${id}:call:${typeof b.id === "string" ? b.id : entries.length}`,
            parentId: id || parentId,
            ts: iso,
            kind: "tool_call",
            toolName: typeof b.name === "string" ? b.name : "tool",
            toolCallId: typeof b.id === "string" ? b.id : undefined,
            text: argText,
          });
        }
      } else if (role === "toolResult") {
        entries.push({
          id,
          parentId,
          ts: iso,
          kind: "tool_result",
          toolName: typeof message.toolName === "string" ? message.toolName : "tool",
          toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
          isError: message.isError === true,
          text: textOfContent(message.content),
        });
      } else if (role === "custom") {
        entries.push({ id, parentId, ts: iso, kind: "note", text: textOfContent(message.content) });
      } else if (role === "system") {
        // prompt checkpoint; keep only a marker to avoid dumping the whole prompt
        entries.push({ id, parentId, ts: iso, kind: "system", text: "(system prompt)" });
      }
      continue;
    }

    if (entry.type === "compaction") {
      entries.push({
        id,
        parentId,
        ts,
        kind: "compaction",
        text: typeof entry.summary === "string" ? entry.summary : "",
        tokens: num(entry.tokensBefore),
      });
      continue;
    }
    if (entry.type === "branch_summary") {
      entries.push({
        id,
        parentId,
        ts,
        kind: "branch",
        text: typeof entry.summary === "string" ? entry.summary : "",
      });
      continue;
    }
    if (entry.type === "model_change") {
      entries.push({
        id,
        parentId,
        ts,
        kind: "model",
        provider: typeof entry.provider === "string" ? entry.provider : "",
        model: typeof entry.modelId === "string" ? entry.modelId : "",
      });
      continue;
    }
    if (entry.type === "custom_message") {
      entries.push({ id, parentId, ts, kind: "note", text: textOfContent(entry.content) });
      continue;
    }
  }

  const leafId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  const branches = [...children.values()].filter((count) => count > 1).length;

  const resolvedMeta: SessionMeta =
    meta ??
    ({
      id: path.basename(filePath),
      path: filePath,
      cwd: "",
      project: "未知目录",
      created: stat.mtimeMs,
      modified: stat.mtimeMs,
      messageCount: entries.filter((entry) => entry.kind === "user" || entry.kind === "assistant").length,
      userMessageCount: entries.filter((entry) => entry.kind === "user").length,
      firstMessage: "",
      lastMessage: "",
      models: [],
      usage: emptyUsage(),
      byDay: {},
      sizeBytes: stat.size,
      textFile: "",
    } satisfies SessionMeta);

  return { meta: resolvedMeta, entries, truncated, branches, leafId };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

function randomEntryId(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest("hex")
    .slice(0, 8);
}

export async function renameSession(filePath: string, name: string): Promise<void> {
  const raw = await fsp.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  let parentId: string | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (typeof entry.id === "string") {
        parentId = entry.id;
        break;
      }
    } catch {
      continue;
    }
  }
  const truncated = raw.length > 0 && !raw.endsWith("\n");
  const record = {
    type: "session_info",
    id: randomEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    name: name.trim() || undefined,
  };
  await fsp.appendFile(filePath, `${truncated ? "\n" : ""}${JSON.stringify(record)}\n`, "utf8");
}

/** Soft-delete: move the session file into the plugin trash directory. */
export async function deleteSession(filePath: string): Promise<string> {
  const dir = trashDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `${stamp}_${path.basename(filePath)}`);
  await fsp.rename(filePath, target);
  return target;
}

/**
 * Drop the index and the cached transcripts. The trash directory is kept: those
 * are user-deleted sessions, not derived data.
 */
export async function clearCache(): Promise<void> {
  await fsp.rm(indexFilePath(), { force: true });
  await fsp.rm(textDir(), { recursive: true, force: true });
  textCache.clear();
  textCacheBytes = 0;
}

/** Remove a session from the index after it was deleted or renamed. */
export async function dropFromIndex(filePath: string): Promise<void> {
  const cache = await readCache();
  cache.sessions = cache.sessions.filter((session) => session.path !== filePath);
  delete cache.files[filePath];
  await writeJsonAtomic(indexFilePath(), cache);
}
