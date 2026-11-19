/**
 * pi-conversations — visual manager for every pi session on this machine.
 *
 * `/conversations` starts a local web UI that keeps running in the background
 * until `/conversations stop` or pi exits. The browser can browse, search,
 * rename, delete, export, and copy a `pi --session <path>` launch command for
 * any session.
 *
 * The server lives on globalThis so it survives session switches, `/reload`,
 * and extension re-instantiation.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

import { clearCache, refreshIndex } from "./indexer.ts";
import { SERVER_VERSION, startServer, type RunningServer } from "./server.ts";

const SHARED_KEY = Symbol.for("pi-conversations.shared");

interface SharedState {
  server?: RunningServer;
  starting?: Promise<RunningServer>;
}

const shared: SharedState = ((globalThis as Record<PropertyKey, unknown>)[SHARED_KEY] ??= {} as SharedState) as SharedState;

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
        : process.platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort: the URL is also shown in the notification
  }
}

async function stopServer(): Promise<boolean> {
  const instance = shared.server;
  shared.server = undefined;
  shared.starting = undefined;
  if (!instance) return false;
  try {
    await instance.close();
  } catch {
    // already closed
  }
  return true;
}

async function ensureServer(): Promise<RunningServer> {
  if (shared.server) {
    if (shared.server.version === SERVER_VERSION) return shared.server;
    // Extension was reloaded with new server code: drop the old instance so the
    // browser gets fresh assets and API behaviour.
    await stopServer();
  }
  if (!shared.starting) {
    shared.starting = startServer().then((instance) => {
      shared.server = instance;
      return instance;
    });
  }
  try {
    return await shared.starting;
  } catch (error) {
    shared.starting = undefined;
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  // The server outlives sessions on purpose: only an explicit stop or process
  // exit shuts it down.
  pi.on("session_shutdown", async () => {
    // nothing to tear down per session
  });

  pi.registerCommand("conversations", {
    description: "可视化浏览/搜索/管理所有 pi 会话（本地 Web 界面，后台常驻）",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { value: "stop", label: "stop — 停止后台服务" },
        { value: "reset", label: "reset — 清空索引与全文缓存（含对话正文）" },
      ];
      const filtered = options.filter((option) => option.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = (args || "").trim().toLowerCase();

      if (sub === "stop" || sub === "off" || sub === "close") {
        const stopped = await stopServer();
        ctx.ui.setStatus("conversations", undefined);
        ctx.ui.notify(stopped ? "会话管理服务已停止" : "会话管理服务当前没有运行", "info");
        return;
      }

      if (sub === "reset" || sub === "purge" || sub === "clear") {
        await clearCache();
        void refreshIndex(false).catch(() => {});
        ctx.ui.notify("已清空索引与全文缓存（会话文件本身未改动，索引会自动重建）", "info");
        return;
      }

      const instance = await ensureServer().catch((error: unknown) => {
        ctx.ui.notify(`启动会话管理界面失败：${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
      });
      if (!instance) return;

      ctx.ui.setStatus("conversations", `对话管理 :${instance.port}`);
      openBrowser(instance.url);
      void refreshIndex(false).catch(() => {});
      ctx.ui.notify(`会话管理已在后台运行：${instance.url}\n停止服务：/conversations stop`, "info");
    },
  });
}
