/**
 * Local HTTP server for the conversations UI.
 *
 * Binds to 127.0.0.1 only and requires a per-run bearer token, so no other
 * machine (and no unrelated local page) can read or mutate sessions.
 */
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteSession,
  dropFromIndex,
  indexStatus,
  readIndex,
  readSessionDetail,
  refreshIndex,
  renameSession,
  searchSessions,
  sessionsRoot,
  type DayBucket,
  type SessionMeta,
} from "./indexer.ts";

/** Bump when the extension ships new server code so a live server rebuilds itself. */
export const SERVER_VERSION = 4;

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  version: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function extensionDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Guard every mutating/lookup path against escaping the session root. */
function resolveSessionPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const root = sessionsRoot();
  const resolved = path.resolve(value);
  if (!resolved.endsWith(".jsonl")) return undefined;
  if (!isInside(root, resolved)) return undefined;
  return resolved;
}

export function aggregateStats(sessions: SessionMeta[]): {
  totals: {
    sessions: number;
    messages: number;
    tokens: number;
    cost: number;
    sizeBytes: number;
    projects: number;
  };
  byDay: Array<{ date: string } & DayBucket>;
  byModel: Array<{ model: string; sessions: number; messages: number }>;
  byProject: Array<{ project: string; cwd: string; sessions: number; messages: number; tokens: number; cost: number }>;
} {
  const byDay = new Map<string, DayBucket>();
  const byModel = new Map<string, { sessions: number; messages: number }>();
  const byProject = new Map<
    string,
    { project: string; cwd: string; sessions: number; messages: number; tokens: number; cost: number }
  >();
  const totals = { sessions: sessions.length, messages: 0, tokens: 0, cost: 0, sizeBytes: 0, projects: 0 };

  for (const session of sessions) {
    totals.messages += session.messageCount;
    totals.tokens += session.usage.total;
    totals.cost += session.usage.cost;
    totals.sizeBytes += session.sizeBytes;

    const projectKey = session.cwd || session.project;
    const project = byProject.get(projectKey) ?? {
      project: session.project,
      cwd: session.cwd,
      sessions: 0,
      messages: 0,
      tokens: 0,
      cost: 0,
    };
    project.sessions += 1;
    project.messages += session.messageCount;
    project.tokens += session.usage.total;
    project.cost += session.usage.cost;
    byProject.set(projectKey, project);

    for (const [date, bucket] of Object.entries(session.byDay ?? {})) {
      const target = byDay.get(date) ?? { messages: 0, tokens: 0, cost: 0 };
      target.messages += bucket.messages;
      target.tokens += bucket.tokens;
      target.cost += bucket.cost;
      byDay.set(date, target);
    }

    // Attribute session tokens to models proportionally to message count would
    // be a guess; keep per-model session counts plus token totals on the
    // model that produced the most recent assistant turn.
    for (const model of session.models) {
      const entry = byModel.get(model) ?? { sessions: 0, messages: 0 };
      entry.sessions += 1;
      entry.messages += Math.round(session.messageCount / Math.max(1, session.models.length));
      byModel.set(model, entry);
    }
  }

  totals.projects = new Set(sessions.map((session) => session.cwd || session.project)).size;

  const dayList = [...byDay.entries()]
    .map(([date, bucket]) => ({ date, ...bucket }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals,
    byDay: dayList,
    byModel: [...byModel.entries()]
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.messages - a.messages),
    byProject: [...byProject.values()].sort((a, b) => b.messages - a.messages),
  };
}

export async function startServer(preferredPort = 7788): Promise<RunningServer> {
  const token = randomBytes(16).toString("hex");
  /** Throttles `refresh=1` scans so a page reload does not re-stat on every request. */
  let lastRefreshAt = 0;
  const publicDir = path.join(extensionDir(), "public");
  const staticCache = new Map<string, { mtimeMs: number; body: Buffer; mime: string }>();

  const authorize = (req: IncomingMessage, url: URL): boolean => {
    const queryToken = url.searchParams.get("t");
    const headerToken = req.headers["x-pi-token"];
    return queryToken === token || headerToken === token;
  };

      // The page carries the access token in its URL: never leak it through
      // Referer, and do not let a sniffed content type become executable.
      const securityHeaders = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
  const serveStatic = async (res: ServerResponse, name: string): Promise<void> => {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "");
    const file = path.join(publicDir, safe);
    try {
      // Revalidate by mtime: the server is long-lived, and editing app.js must
      // show up on the next browser reload instead of serving a stale bundle.
      const stat = await fsp.stat(file);
      const cached = staticCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        res.writeHead(200, { "content-type": cached.mime, ...securityHeaders });
        res.end(cached.body);
        return;
      }
      const body = await fsp.readFile(file);
      const entry = { mtimeMs: stat.mtimeMs, body, mime: MIME[path.extname(file)] ?? "application/octet-stream" };
      staticCache.set(file, entry);
      res.writeHead(200, { "content-type": entry.mime, ...securityHeaders });
      res.end(entry.body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      // The HTML page itself is served without a token; the page needs it to
      // read ?t= from the URL and then authorizes every API call.
      await serveStatic(res, "index.html");
      return;
    }
    if (pathname === "/app.js" || pathname === "/style.css" || pathname === "/favicon.svg") {
      await serveStatic(res, pathname.slice(1));
      return;
    }

    if (!authorize(req, url)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (pathname === "/api/status" && req.method === "GET") {
        const index = await readIndex();
        sendJson(res, 200, {
          status: indexStatus,
          builtAt: index.builtAt,
          root: index.root,
          count: index.sessions.length,
        });
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        // `refresh=1` re-scans session files (incrementally, throttled) so a
        // browser reload picks up conversations written since the last scan.
        if (url.searchParams.get("refresh") === "1") {
          const now = Date.now();
          if (now - lastRefreshAt > 1200) {
            lastRefreshAt = now;
            try {
              await refreshIndex(false);
            } catch {
              // keep serving the previous snapshot
            }
          }
        }
        const index = await readIndex();
        // Serve the cached snapshot immediately; callers can poll /api/status
        // for the background refresh.
        sendJson(res, 200, {
          sessions: index.sessions.map((session) => ({
            id: session.id,
            path: session.path,
            cwd: session.cwd,
            project: session.project,
            name: session.name,
            created: session.created,
            modified: session.modified,
            messageCount: session.messageCount,
            userMessageCount: session.userMessageCount,
            firstMessage: session.firstMessage,
            lastMessage: session.lastMessage,
            models: session.models,
            usage: session.usage,
            sizeBytes: session.sizeBytes,
            parentSessionPath: session.parentSessionPath,
          })),
          builtAt: index.builtAt,
          root: index.root,
          status: indexStatus,
          platform: process.platform,
        });
        return;
      }

      if (pathname === "/api/reindex" && req.method === "POST") {
        const index = await refreshIndex(true);
        sendJson(res, 200, { ok: true, count: index.sessions.length });
        return;
      }

      if (pathname === "/api/session" && req.method === "GET") {
        const filePath = resolveSessionPath(url.searchParams.get("path"));
        if (!filePath) {
          sendJson(res, 400, { error: "invalid session path" });
          return;
        }
        const detail = await readSessionDetail(filePath);
        sendJson(res, 200, detail);
        return;
      }

      if (pathname === "/api/raw" && req.method === "GET") {
        const filePath = resolveSessionPath(url.searchParams.get("path"));
        if (!filePath) {
          sendJson(res, 400, { error: "invalid session path" });
          return;
        }
        const body = await fsp.readFile(filePath);
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="${path.basename(filePath).replace(/"/g, "")}"`,
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      if (pathname === "/api/search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const index = await readIndex();
        const hits = await searchSessions(index.sessions, query);
        sendJson(res, 200, {
          query,
          hits: hits.map((hit) => ({
            session: {
              ...hit.session,
              textFile: undefined,
              byDay: undefined,
            },
            matches: hit.matches,
            snippets: hit.snippets,
          })),
        });
        return;
      }

      if (pathname === "/api/stats" && req.method === "GET") {
        const index = await readIndex();
        sendJson(res, 200, aggregateStats(index.sessions));
        return;
      }

      if (pathname === "/api/rename" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { path?: unknown; name?: unknown };
        const filePath = resolveSessionPath(body.path);
        if (!filePath) {
          sendJson(res, 400, { error: "invalid session path" });
          return;
        }
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
        await renameSession(filePath, name);
        await refreshIndex(false);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/delete" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { path?: unknown };
        const filePath = resolveSessionPath(body.path);
        if (!filePath) {
          sendJson(res, 400, { error: "invalid session path" });
          return;
        }
        const trashPath = await deleteSession(filePath);
        await dropFromIndex(filePath);
        sendJson(res, 200, { ok: true, trashPath });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  let server: Server | undefined;
  let port = preferredPort;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = preferredPort + attempt;
    const instance = createServer((req, res) => {
      void handle(req, res);
    });
    const ok = await new Promise<boolean>((resolve) => {
      instance.once("error", () => resolve(false));
      instance.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      server = instance;
      port = candidate;
      // Do not keep the pi process alive just because this server is listening.
      instance.unref();
      break;
    }
    instance.close();
  }

  if (!server) {
    throw new Error(`无法在 ${preferredPort}-${preferredPort + 19} 之间找到空闲端口`);
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return {
    url,
    port,
    token,
    version: SERVER_VERSION,
    close: () =>
      new Promise<void>((resolve) => {
        server?.close(() => resolve());
        server = undefined;
      }),
  };
}
