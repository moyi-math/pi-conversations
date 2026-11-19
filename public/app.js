/* pi-conversations web UI — no build step, plain ES2020. */
(() => {
  "use strict";

  const TOKEN = new URLSearchParams(location.search).get("t") || "";

  const state = {
    sessions: [],
    root: "",
    builtAt: 0,
    status: null,
    query: "",
    hits: null,
    tab: "sessions",
    project: "",
    namedOnly: false,
    sortBy: "modified",
    selectedPath: null,
    detail: null,
    stats: null,
    searchSeq: 0,
    platform: "win32",
  };

  const $ = (selector) => document.querySelector(selector);

  /* ------------------------------------------------------------ helpers */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtClock(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtTokens(n) {
    if (!n) return "0";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function fmtCost(n) {
    if (!n) return "$0";
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  }

  function isIndexing() {
    const phase = state.status && state.status.phase;
    return phase === "parsing" || phase === "scanning";
  }

  function isoDay(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function toast(message, isError) {
    const node = $("#toast");
    node.textContent = message;
    node.className = isError ? "err" : "";
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, 2600);
  }

  async function api(path, init) {
    const response = await fetch(path, {
      ...init,
      headers: { "x-pi-token": TOKEN, "content-type": "application/json", ...(init && init.headers) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /* -------------------------------------------------------------- state */

  async function loadSessions(forceRefresh) {
    const data = await api(`/api/sessions${forceRefresh ? "?refresh=1" : ""}`);
    state.sessions = data.sessions || [];
    state.platform = data.platform || state.platform;
    state.root = data.root || "";
    state.builtAt = data.builtAt || 0;
    state.status = data.status || null;
    renderProjectFilter();
    renderSidebar();
    if (state.tab === "stats") renderStats();
  }

  async function loadDetail(filePath) {
    state.selectedPath = filePath;
    renderSidebar();
    const main = $("#main");
    main.innerHTML = `<div class="empty">载入中…</div>`;
    try {
      const detail = await api(`/api/session?path=${encodeURIComponent(filePath)}`);
      if (state.selectedPath !== filePath) return;
      state.detail = detail;
      renderMain();
      main.scrollTop = 0;
    } catch (error) {
      main.innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`;
    }
  }

  async function runSearch(query) {
    const seq = ++state.searchSeq;
    if (!query.trim()) {
      state.hits = null;
      renderSidebar();
      return;
    }
    $("#status").textContent = "搜索中…";
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (seq !== state.searchSeq) return;
      state.hits = data.hits || [];
      $("#status").textContent = `${state.hits.length} 个会话命中`;
    } catch (error) {
      if (seq !== state.searchSeq) return;
      toast(`搜索失败：${error.message}`, true);
      state.hits = [];
    }
    renderSidebar();
  }

  /* ------------------------------------------------------------ sidebar */

  function renderProjectFilter() {
    const select = $("#projectFilter");
    const current = state.project;
    const projects = new Map();
    for (const session of state.sessions) {
      const key = session.cwd || session.project;
      const entry = projects.get(key) || { label: session.project, count: 0 };
      entry.count += 1;
      projects.set(key, entry);
    }
    const options = [...projects.entries()].sort((a, b) => b[1].count - a[1].count);
    select.innerHTML =
      `<option value="">全部项目 (${state.sessions.length})</option>` +
      options
        .map(([key, value]) => `<option value="${esc(key)}">${esc(value.label)} (${value.count})</option>`)
        .join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    else state.project = "";
  }

  function visibleSessions() {
    let list = state.sessions;
    if (state.project) list = list.filter((session) => (session.cwd || session.project) === state.project);
    if (state.namedOnly) list = list.filter((session) => Boolean(session.name));
    const sorters = {
      modified: (a, b) => b.modified - a.modified,
      created: (a, b) => b.created - a.created,
      messageCount: (a, b) => b.messageCount - a.messageCount,
      cost: (a, b) => (b.usage ? b.usage.cost : 0) - (a.usage ? a.usage.cost : 0),
    };
    return [...list].sort(sorters[state.sortBy] || sorters.modified);
  }

  function sessionTitle(session) {
    return session.name || session.firstMessage || "(空会话)";
  }

  function makeItem(session, extra) {
    const item = el("div", "item" + (session.path === state.selectedPath ? " active" : ""));
    item.dataset.path = session.path;
    const title = el("div", "item-title");
    if (session.name) {
      const named = el("span", "named", session.name);
      title.appendChild(named);
    } else {
      title.textContent = session.firstMessage || "(空会话)";
    }
    item.appendChild(title);

    const parts = [
      fmtTime(session.modified),
      `${session.messageCount} 条`,
      session.usage && session.usage.cost ? fmtCost(session.usage.cost) : "",
    ].filter(Boolean);
    item.appendChild(el("div", "item-meta", parts.join(" · ")));

    if (extra) item.appendChild(extra);
    return item;
  }

  function highlight(text, query) {
    const safe = esc(text);
    const terms = query
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    if (terms.length === 0) return safe;
    const pattern = terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length)
      .join("|");
    return safe.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
  }

  function renderSidebar() {
    const list = $("#list");
    list.innerHTML = "";

    if (state.hits) {
      if (state.hits.length === 0) {
        list.appendChild(el("div", "group-title", "没有匹配的会话"));
        return;
      }
      const header = el("div", "group-title");
      header.appendChild(el("span", null, `搜索结果 ${state.hits.length}`));
      list.appendChild(header);
      for (const hit of state.hits) {
        const snippet = hit.snippets && hit.snippets.length ? hit.snippets[0] : "";
        const extra = el("div", "item-snippet");
        extra.innerHTML = highlight(snippet, state.query);
        list.appendChild(makeItem(hit.session, extra));
      }
      return;
    }

    const sessions = visibleSessions();
    if (sessions.length === 0) {
      list.appendChild(el("div", "group-title", isIndexing() ? "正在建立索引…" : "没有会话"));
      return;
    }

    const groups = new Map();
    for (const session of sessions) {
      const key = session.cwd || session.project;
      const group = groups.get(key) || { label: session.project, cwd: session.cwd, items: [] };
      group.items.push(session);
      groups.set(key, group);
    }

    const ordered = [...groups.values()].sort((a, b) => {
      const aMax = Math.max(...a.items.map((item) => item.modified));
      const bMax = Math.max(...b.items.map((item) => item.modified));
      return bMax - aMax;
    });

    for (const group of ordered) {
      const title = el("div", "group-title");
      title.appendChild(el("span", null, group.label));
      title.appendChild(el("span", "count", String(group.items.length)));
      title.title = group.cwd || "";
      list.appendChild(title);
      for (const session of group.items) list.appendChild(makeItem(session));
    }
  }

  /* --------------------------------------------------------------- main */

  function renderMain() {
    if (state.tab === "stats") {
      renderStats();
      return;
    }
    if (!state.detail) {
      const indexing = state.sessions.length === 0 && isIndexing();
      $("#main").innerHTML = `<div class="empty">
        ${indexing ? "正在建立索引，稍候会自动刷新…" : "选择左侧会话查看内容"}<br />
        <span class="hint">按 <kbd>/</kbd> 搜索所有会话 · 按 <kbd>j</kbd>/<kbd>k</kbd> 移动</span>
      </div>`;
      return;
    }
    renderDetail(state.detail);
  }

  function entryBadge(entry) {
    switch (entry.kind) {
      case "user":
        return "你";
      case "assistant":
        return "助手";
      case "thinking":
        return "思考";
      case "tool_call":
        return `工具 ${entry.toolName || ""}`;
      case "tool_result":
        return `结果 ${entry.toolName || ""}`;
      case "compaction":
        return "压缩摘要";
      case "branch":
        return "分支摘要";
      case "note":
        return "备注";
      case "model":
        return "模型切换";
      case "system":
        return "系统提示";
      default:
        return entry.kind;
    }
  }

  function entryNode(entry) {
    if (entry.kind === "system" || entry.kind === "model") {
      const line = el("div", `entry ${entry.kind}`);
      const head = el("div", "entry-head");
      const text =
        entry.kind === "model"
          ? `模型切换 → ${entry.provider ? `${entry.provider}/` : ""}${entry.model || ""}`
          : "system prompt checkpoint";
      head.textContent = `${fmtClock(entry.ts)}  ${text}`;
      line.appendChild(head);
      return line;
    }

    const wrap = el("div", `entry ${entry.kind}` + (entry.isError ? " error" : ""));
    const head = el("div", "entry-head");
    head.appendChild(el("span", "badge", entryBadge(entry)));
    const meta = [fmtClock(entry.ts), entry.model || "", entry.tokens ? fmtTokens(entry.tokens) : ""]
      .filter(Boolean)
      .join(" · ");
    if (meta) head.appendChild(el("span", "meta", meta));
    wrap.appendChild(head);

    const text = entry.text || "";
    const isCode = entry.kind === "tool_call" || entry.kind === "tool_result";
    const long = text.length > 1200 || text.split("\n").length > 18;

    if (isCode) {
      const details = document.createElement("details");
      details.open = entry.kind === "tool_call" ? !long : false;
      const summary = document.createElement("summary");
      summary.textContent =
        entry.kind === "tool_call"
          ? `${text.split("\n")[0].slice(0, 90)}${text.length > 90 ? " …" : ""}`
          : `${text.split("\n")[0].slice(0, 90)}${text.length > 90 ? " …" : ""} （${text.length} 字符）`;
      details.appendChild(summary);
      const pre = el("pre", long ? "clamped" : "", text || "(空)");
      details.appendChild(pre);
      wrap.appendChild(details);
      return wrap;
    }

    if (entry.kind === "thinking") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `思考 ${text.length} 字符`;
      details.appendChild(summary);
      details.appendChild(el("pre", "clamped", text));
      wrap.appendChild(details);
      return wrap;
    }

    if (long) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `展开全文（${text.length} 字符）`;
      details.appendChild(summary);
      details.appendChild(el("pre", "clamped", text));
      wrap.appendChild(details);
      const preview = el("div", "entry-body", text.slice(0, 900) + "…");
      wrap.appendChild(preview);
      return wrap;
    }

    wrap.appendChild(el("div", "entry-body", text));
    return wrap;
  }

  function renderDetail(detail) {
    const meta = detail.meta || {};
    const main = $("#main");
    main.innerHTML = "";

    const head = el("div", "detail-head");
    head.appendChild(el("h1", "detail-title", meta.name || meta.firstMessage || "(空会话)"));

    const grid = el("div", "meta-grid");
    const push = (label, value) => {
      const span = el("span");
      span.appendChild(el("span", null, `${label} `));
      const bold = el("b", null, value);
      span.appendChild(bold);
      grid.appendChild(span);
    };
    push("项目", meta.project || "—");
    push("消息", `${meta.messageCount || 0} 条`);
    push("创建", fmtTime(meta.created));
    push("活动", fmtTime(meta.modified));
    if (meta.usage) {
      push("Token", fmtTokens(meta.usage.total));
      push("成本", fmtCost(meta.usage.cost));
    }
    push("大小", fmtBytes(meta.sizeBytes));
    if (detail.branches) push("分叉点", String(detail.branches));
    if (meta.models && meta.models.length) push("模型", meta.models.slice(-2).join(", "));
    head.appendChild(grid);

    const pathLine = el("div", "meta-grid");
    pathLine.appendChild(el("span", "path", meta.path || ""));
    head.appendChild(pathLine);

    const actions = el("div", "actions");
    const button = (label, className, handler) => {
      const node = el("button", `action ${className || ""}`.trim(), label);
      node.addEventListener("click", handler);
      actions.appendChild(node);
      return node;
    };

    button("在 pi 中恢复", "primary", () => resumeSession(meta.path, meta.cwd));
    button("复制启动命令", "", () => copyLaunchCommand(meta.cwd, meta.path));
    button("重命名", "", () => renameSession(meta.path, meta.name));
    button("导出 HTML", "", () => exportHtml(detail));
    button("下载 JSONL", "", () => {
      location.href = `/api/raw?path=${encodeURIComponent(meta.path)}&t=${encodeURIComponent(TOKEN)}`;
    });
    button("删除", "danger", () => deleteSession(meta.path, meta.name || meta.firstMessage));
    head.appendChild(actions);
    main.appendChild(head);

    if (detail.truncated) {
      const warn = el("div", "entry compaction");
      warn.appendChild(el("div", "entry-body", "会话过大，仅显示前 4000 条记录。"));
      main.appendChild(warn);
    }

    const fragment = document.createDocumentFragment();
    for (const entry of detail.entries || []) fragment.appendChild(entryNode(entry));
    main.appendChild(fragment);
  }

  /* --------------------------------------------------------- operations */

  /*
   * Resume commands are shell-specific: cmd needs `cd /d` + `&&`, while
   * PowerShell 5.1 rejects `&&` and treats `cd /d` as two paths.
   */
  const SHELL_KEY = "pi-conversations.shell";

  function launchCommands(cwd, filePath) {
    const resume = `pi --session "${filePath}"`;
    if (state.platform !== "win32") {
      return [{ shell: "posix", label: "bash / zsh", command: cwd ? `cd "${cwd}" && ${resume}` : resume }];
    }
    return [
      {
        shell: "pwsh",
        label: "PowerShell 5.1 / PowerShell 7 / Git Bash",
        command: cwd ? `cd "${cwd}"; ${resume}` : resume,
      },
      {
        shell: "cmd",
        label: "cmd",
        command: cwd ? `cd /d "${cwd}" && ${resume}` : resume,
      },
    ];
  }

  function preferredShell() {
    try {
      const saved = localStorage.getItem(SHELL_KEY);
      if (saved) return saved;
    } catch {
      // storage unavailable
    }
    return state.platform === "win32" ? "pwsh" : "posix";
  }

  function launchCommand(cwd, filePath) {
    const commands = launchCommands(cwd, filePath);
    const preferred = preferredShell();
    const match = commands.find((entry) => entry.shell === preferred) ?? commands[0];
    return match ? match.command : "";
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
      return true;
    } catch {
      toast("复制失败，请手动选中命令文本", true);
      return false;
    }
  }

  async function copyLaunchCommand(cwd, filePath) {
    const commands = launchCommands(cwd, filePath);
    const preferred = preferredShell();
    const match = commands.find((entry) => entry.shell === preferred) ?? commands[0];
    if (!match) return false;
    return copyText(match.command, `已复制 ${match.label.split(" / ")[0]} 启动命令`);
  }

  /** Show copyable launch commands; the browser cannot switch the pi session itself. */
  function resumeSession(filePath, cwd) {
    const commands = launchCommands(cwd, filePath);
    const blocks = commands
      .map(
        (entry, index) => `<div class="cmd-row">
        <span class="cmd-label">${esc(entry.label)}</span>
        <button class="action" data-copy="${index}">复制</button>
      </div>
      <pre>${esc(entry.command)}</pre>`,
      )
      .join("");

    const overlay = $("#overlay");
    overlay.hidden = false;
    overlay.innerHTML = `<div class="box">
      <div class="big">在终端里启动这个会话</div>
      <div style="color:var(--fg-dim)">按你用的终端选一条复制，粘贴执行即可进入该会话：</div>
      ${blocks}
      <div class="overlay-actions"><button class="action" id="overlayClose">关闭</button></div>
    </div>`;

    overlay.querySelector("#overlayClose").addEventListener("click", () => {
      overlay.hidden = true;
    });
    overlay.querySelectorAll("[data-copy]").forEach((node) => {
      node.addEventListener("click", () => {
        const entry = commands[Number(node.dataset.copy)];
        if (!entry) return;
        try {
          localStorage.setItem(SHELL_KEY, entry.shell);
        } catch {
          // ignore storage failures
        }
        void copyText(entry.command, `已复制 ${entry.label.split(" / ")[0]} 启动命令`);
      });
    });
  }

  async function renameSession(filePath, current) {
    const next = window.prompt("新的会话名称（留空则清除名称）", current || "");
    if (next === null) return;
    try {
      await api("/api/rename", { method: "POST", body: JSON.stringify({ path: filePath, name: next }) });
      toast("已重命名");
      await loadSessions();
      if (state.selectedPath === filePath) await loadDetail(filePath);
    } catch (error) {
      toast(`重命名失败：${error.message}`, true);
    }
  }

  async function deleteSession(filePath, label) {
    if (!window.confirm(`删除会话「${label || filePath}」？\n\n文件会移到缓存目录的 trash/ 下，可手动找回。`)) return;
    try {
      await api("/api/delete", { method: "POST", body: JSON.stringify({ path: filePath }) });
      toast("已删除到 trash");
      if (state.selectedPath === filePath) {
        state.selectedPath = null;
        state.detail = null;
      }
      await loadSessions();
      renderMain();
    } catch (error) {
      toast(`删除失败：${error.message}`, true);
    }
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  function exportHtml(detail) {
    const meta = detail.meta || {};
    const rows = (detail.entries || [])
      .map((entry) => {
        if (entry.kind === "system" || entry.kind === "model") {
          return `<div class="ev ${entry.kind}"><div class="hd">${esc(entryBadge(entry))}</div></div>`;
        }
        return `<div class="ev ${entry.kind}${entry.isError ? " err" : ""}">
  <div class="hd"><b>${esc(entryBadge(entry))}</b> <span>${esc(entry.model || "")}</span> <span>${esc(entry.ts || "")}</span></div>
  <pre>${esc(entry.text || "")}</pre>
</div>`;
      })
      .join("\n");

    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(meta.name || meta.firstMessage || "pi session")}</title>
<style>
body{background:#0b0d12;color:#d7dde9;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;margin:0;padding:28px;max-width:980px}
h1{font-size:19px;margin:0 0 10px}
.meta{color:#8590a6;font-size:12px;margin-bottom:18px;display:flex;gap:6px 18px;flex-wrap:wrap}
.meta code{color:#5c667a;word-break:break-all}
.ev{border:1px solid #1a2130;border-left:2px solid #333;border-radius:8px;background:#11151f;margin:0 0 10px;overflow:hidden}
.ev .hd{padding:5px 10px;font-size:11.5px;color:#5c667a;border-bottom:1px solid #1a2130;display:flex;gap:10px}
.ev pre{margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.ev.user{border-left-color:#7aa2f7}.ev.user b{color:#7aa2f7}
.ev.assistant{border-left-color:#9ece6a}.ev.assistant b{color:#9ece6a}
.ev.thinking{border-left-color:#bb9af7;opacity:.85}.ev.thinking b{color:#bb9af7}
.ev.tool_call,.ev.tool_result{background:#0e121a;border-left-color:#3a4459}
.ev.tool_call b{color:#7dcfff}
.ev.tool_result pre{font:12px/1.5 ui-monospace,Consolas,monospace;color:#8590a6}
.ev.tool_result.err{border-left-color:#f7768e}.ev.tool_result.err b{color:#f7768e}
.ev.compaction{border-left-color:#e0af68}.ev.compaction b{color:#e0af68}
.ev.branch{border-left-color:#bb9af7}
.ev.note{border-left-color:#3a4459}
.ev.system,.ev.model{border:0;background:transparent;color:#5c667a;font-size:11.5px}
.ev.system pre,.ev.model pre{display:none}
</style></head><body>
<h1>${esc(meta.name || meta.firstMessage || "(空会话)")}</h1>
<div class="meta">
  <span>项目 ${esc(meta.project || "—")}</span>
  <span>消息 ${meta.messageCount || 0}</span>
  <span>Token ${fmtTokens(meta.usage ? meta.usage.total : 0)}</span>
  <span>成本 ${fmtCost(meta.usage ? meta.usage.cost : 0)}</span>
  <span>导出 ${esc(new Date().toISOString())}</span>
</div>
<div class="meta"><code>${esc(meta.path || "")}</code></div>
${rows}
</body></html>`;

    const base = (meta.name || meta.firstMessage || "session").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    download(`${base || "session"}.html`, html, "text/html;charset=utf-8");
  }

  /* --------------------------------------------------------------- stats */

  function buildHeatmap(byDay) {
    const map = new Map(byDay.map((day) => [day.date, day]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 181);
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);

    let max = 1;
    for (const day of byDay) max = Math.max(max, day.messages);

    const cells = [];
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const key = isoDay(cursor);
      const bucket = map.get(key);
      const level = bucket ? Math.min(4, Math.max(1, Math.ceil((bucket.messages / max) * 4))) : 0;
      cells.push({ key, level, bucket });
    }
    return cells;
  }

  async function renderStats() {
    const main = $("#main");
    main.innerHTML = `<div class="empty">统计载入中…</div>`;
    try {
      if (!state.stats) state.stats = await api("/api/stats");
    } catch (error) {
      main.innerHTML = `<div class="empty">统计加载失败：${esc(error.message)}</div>`;
      return;
    }
    const stats = state.stats;
    main.innerHTML = "";

    const cards = el("div", "card-row");
    const card = (label, value) => {
      const node = el("div", "card");
      node.appendChild(el("div", "label", label));
      node.appendChild(el("div", "value", value));
      cards.appendChild(node);
    };
    card("会话", String(stats.totals.sessions));
    card("项目", String(stats.totals.projects));
    card("消息", String(stats.totals.messages));
    card("成本", fmtCost(stats.totals.cost));
    card("Token", fmtTokens(stats.totals.tokens));
    card("磁盘", fmtBytes(stats.totals.sizeBytes));
    main.appendChild(cards);

    main.appendChild(el("h2", null, "最近 26 周活动"));
    const heat = el("div", "heat");
    for (const cell of buildHeatmap(stats.byDay || [])) {
      const node = el("div", "cell");
      node.dataset.level = String(cell.level);
      if (cell.bucket) {
        node.title = `${cell.key} · ${cell.bucket.messages} 条消息 · ${fmtCost(cell.bucket.cost)}`;
      } else {
        node.title = `${cell.key} · 无活动`;
      }
      heat.appendChild(node);
    }
    main.appendChild(heat);
    main.appendChild(el("div", "heat-legend", "颜色越亮表示当天消息越多；悬停查看当天统计。"));

    main.appendChild(el("h2", null, "按项目"));
    const projectTable = el("table");
    projectTable.innerHTML = `<thead><tr>
      <th>项目</th><th>路径</th><th class="num">会话</th><th class="num">消息</th><th class="num">Token</th><th class="num">成本</th>
    </tr></thead><tbody>${(stats.byProject || [])
      .map(
        (row) => `<tr>
          <td>${esc(row.project)}</td>
          <td style="color:var(--fg-faint);font-size:11.5px">${esc(row.cwd)}</td>
          <td class="num">${row.sessions}</td>
          <td class="num">${row.messages}</td>
          <td class="num">${fmtTokens(row.tokens)}</td>
          <td class="num">${fmtCost(row.cost)}</td>
        </tr>`,
      )
      .join("")}</tbody>`;
    main.appendChild(projectTable);

    main.appendChild(el("h2", null, "按模型"));
    const modelTable = el("table");
    modelTable.innerHTML = `<thead><tr><th>模型</th><th class="num">会话</th><th class="num">消息（估算）</th></tr></thead>
      <tbody>${(stats.byModel || [])
        .slice(0, 40)
        .map(
          (row) =>
            `<tr><td>${esc(row.model)}</td><td class="num">${row.sessions}</td><td class="num">${row.messages}</td></tr>`,
        )
        .join("")}</tbody>`;
    main.appendChild(modelTable);
  }

  /* ------------------------------------------------------------- wiring */

  function selectSession(filePath) {
    state.tab = "sessions";
    document.querySelectorAll(".tabs button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === "sessions");
    });
    loadDetail(filePath);
  }

  function moveSelection(delta) {
    const items = [...document.querySelectorAll("#list .item")];
    if (items.length === 0) return;
    const index = items.findIndex((item) => item.dataset.path === state.selectedPath);
    const next = Math.max(0, Math.min(items.length - 1, (index < 0 ? -1 : index) + delta));
    const target = items[next];
    if (!target) return;
    target.scrollIntoView({ block: "nearest" });
    selectSession(target.dataset.path);
  }

  function bindEvents() {
    let searchTimer;
    $("#search").addEventListener("input", (event) => {
      const value = event.target.value;
      state.query = value;
      $("#clearSearch").hidden = !value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (!value.trim()) state.hits = null;
        runSearch(value);
      }, 260);
    });

    $("#clearSearch").addEventListener("click", () => {
      $("#search").value = "";
      state.query = "";
      state.hits = null;
      $("#clearSearch").hidden = true;
      $("#status").textContent = "";
      renderSidebar();
    });

    $("#projectFilter").addEventListener("change", (event) => {
      state.project = event.target.value;
      renderSidebar();
    });

    $("#namedOnly").addEventListener("change", (event) => {
      state.namedOnly = event.target.checked;
      renderSidebar();
    });

    $("#sortBy").addEventListener("change", (event) => {
      state.sortBy = event.target.value;
      renderSidebar();
    });

    $("#syncBtn").addEventListener("click", async () => {
      try {
        await loadSessions(true);
        toast("已同步最新会话");
      } catch (error) {
        toast(`同步失败：${error.message}`, true);
      }
    });

    document.querySelectorAll(".tabs button").forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab;
        document.querySelectorAll(".tabs button").forEach((node) => node.classList.toggle("active", node === button));
        if (state.tab === "stats") {
          state.stats = null;
          renderStats();
        } else {
          renderMain();
        }
      });
    });

    $("#list").addEventListener("click", (event) => {
      const item = event.target.closest(".item");
      if (item && item.dataset.path) selectSession(item.dataset.path);
    });

    document.addEventListener("keydown", (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        $("#search").focus();
        return;
      }
      if (event.key === "Escape" && document.activeElement === $("#search")) {
        $("#search").blur();
        return;
      }
      if (typing) return;
      if (event.key === "j") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k") {
        event.preventDefault();
        moveSelection(-1);
      }
    });
  }

  async function pollStatus() {
    try {
      const data = await api("/api/status");
      const phase = data.status && data.status.phase;
      const wasIndexing = isIndexing();
      state.status = data.status;
      if (phase === "parsing" || phase === "scanning") {
        const total = data.status.total || 0;
        $("#status").textContent = `索引中 ${data.status.loaded}/${total}`;
      } else if (phase === "error") {
        $("#status").textContent = `索引出错：${data.status.message || ""}`;
      } else if (!state.hits) {
        $("#status").textContent = `${data.count} 个会话 · 更新于 ${fmtTime(data.builtAt)}`;
      }
      if (wasIndexing !== isIndexing() && !state.detail) {
        renderSidebar();
        renderMain();
      }
      if (phase === "done" && data.builtAt !== state.builtAt) {
        await loadSessions();
        if (state.tab === "stats") {
          state.stats = null;
          renderStats();
        }
      }
    } catch {
      $("#status").textContent = "与 pi 的连接已断开";
    }
    setTimeout(pollStatus, 2500);
  }

  async function boot() {
    bindEvents();
    try {
      await loadSessions(true);
    } catch (error) {
      $("#main").innerHTML = `<div class="empty">无法连接：${esc(error.message)}<br />请确认 pi 中的 /conversations 仍在运行。</div>`;
      return;
    }
    renderMain();
    pollStatus();
  }

  boot();
})();
