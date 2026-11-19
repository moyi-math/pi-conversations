# pi-conversations

在浏览器里可视化管理这台机器上**所有** pi 会话：浏览、全文搜索、看对话树、重命名、删除、导出、看统计。

## 安装

```bash
pi install npm:pi-conversations
/reload
```

只想试一次、不写进配置：`pi -e npm:pi-conversations`。

升级：

```bash
pi update --extensions
```

不要固定版本号安装（`@0.1.0` 这种会被钉住，不再跟随更新）。更新到新版本后，下次启动 pi 会在 **Extension Updates** 里显示本文件（CHANGELOG.md）的变更摘要。

## 用法

```
/conversations           # 启动（后台常驻，自动打开浏览器）
/conversations stop      # 停止后台服务
```

服务只绑定 `127.0.0.1`，一直运行到 `/conversations stop` 或 pi 退出；切换会话、`/reload` 都不会关掉它。

## 功能

| 区域 | 能力 |
|---|---|
| 侧栏 | 按项目分组的全部会话；按项目筛选、只看已命名、按最近活动/消息数/成本/创建时间排序 |
| 搜索 | 跨全部会话的用户消息/助手回复/思考/压缩摘要全文检索，多关键词 AND，命中片段高亮 |
| 详情 | 用户、助手、思考、工具调用与结果（可折叠）、压缩摘要、分支摘要、模型切换 |
| 管理 | 重命名（写 `session_info`）、删除（移到 trash，可找回） |
| 导出 | 单会话自包含 HTML、原始 JSONL |
| 统计 | 总会话/项目/消息/Token/成本/磁盘；最近 26 周热力图；按项目、按模型汇总 |

## 打开历史会话

网页无法直接切换当前 pi 进程的会话（pi 只把 `switchSession` 暴露给命令执行期间），所以详情页的「在 pi 中恢复」给你的是可粘贴的命令，按终端选一条复制：

- **PowerShell / Git Bash**：`cd "<cwd>"; pi --session "<path>"`
- **cmd**：`cd /d "<cwd>" && pi --session "<path>"`

要点：

- 用 `--session` 而不是 `--resume`：前者直接打开指定会话，后者只弹出会话选择器。
- `pi --session` 会在会话自己记录的目录里工作；`cd` 那半句只影响你终端退出后的位置。
- 点过哪个终端的复制按钮会被记住，详情页顶部「复制启动命令」按钮沿用该选择。
- 会话没有记录工作目录（旧会话）时，命令自动退化为只有 `pi --session "<path>"`。

## 刷新同步

刷新页面（或点顶栏「同步」）会触发一次增量扫描：按 `(mtime, size)` 只重新解析变动的会话文件，通常几百毫秒内完成。页面本身也每 2.5 秒轮询索引版本，索引变了会自动重载列表。

## 实现

```
index.ts    扩展入口：命令、server 生命周期（挂在 globalThis 上跨会话存活）
indexer.ts  会话扫描 + 增量索引缓存 + 全文搜索 + 统计聚合
server.ts   本地 HTTP API（token 校验、路径越界保护、软删除、refresh 节流、静态资源按 mtime 校验）
public/     前端（原生 JS，无构建步骤）
```

`SERVER_VERSION` 用来让常驻服务在扩展 `/reload` 后自动重建，避免旧实例继续服务旧代码。

### 索引缓存

```
~/.pi/agent/cache/pi-conversations/
├── index.json          # 元数据：cwd / 名称 / 消息数 / token / 成本 / 按天活动
├── text/<hash>.txt     # 每个会话的可搜索文本（用户 + 助手 + 思考 + 摘要）
└── trash/              # 删除的会话文件（软删除，可手动找回）
```

首次建索引需要把每个会话读一遍，会话多、体积大时会花几秒；之后只处理变动的文件。全文搜索走落盘的纯文本缓存，通常一两百毫秒。

会话目录解析顺序：`PI_CODING_AGENT_SESSION_DIR` → `settings.json` 的 `sessionDir` → `~/.pi/agent/sessions`。

### 安全

- 只监听 `127.0.0.1`，每次启动生成随机 token，所有 API 都要带 token（页面从 URL 的 `?t=` 取）。
- 所有会话路径都必须在 session root 内，读取、下载、重命名、删除都做越界校验。
- 删除是**软删除**：文件移动进 `trash/`，不是 `unlink`。
- 只改两种东西：重命名追加一条 `session_info` 行，删除移动文件；其余操作只读。

## 已知限制

- 服务随 pi 进程存活；pi 退出后需要重新 `/conversations`。
- 网页不能直接切换当前 pi 会话，只能给出启动命令。
- 单会话详情最多渲染 4000 条记录，超出会提示截断。
- 按模型的 Token/成本是按消息数估算分摊的；会话级别的 Token/成本是精确的。
- 不索引 `toolResult` 正文（体积大且很少被搜索），但详情页能看到。

## 发布（维护者）

发版走 npm **Trusted Publishing**（OIDC），仓库与 secrets 里都没有长期令牌：

1. 改 `package.json` 的 `version`，并在 `CHANGELOG.md` 顶部加一节 `## [x.y.z] - 日期`
2. 提交并推送
3. 打 tag 推送：`git tag v0.2.0 && git push origin v0.2.0`
4. GitHub Actions（`.github/workflows/publish.yml`）校验 tag/版本/CHANGELOG 后执行 `npm publish --provenance`

首次需要绑定一次：npm 包页面 → Settings → **Trusted Publisher** 选 GitHub Actions，仓库填 `moyi-math/pi-conversations`，workflow 填 `publish.yml`（environment 留空）。

用户侧更新：`pi update --extensions`，下次启动 pi 会在 **Package Updates Available** 里看到本包。

## 卸载

```bash
rm -rf ~/.pi/agent/extensions/pi-conversations ~/.pi/agent/cache/pi-conversations
```

然后 `/reload`。

## 敏感信息

这个插件没有硬编码凭证，也不访问任何外部网络（只有 `127.0.0.1`），没有遥测。但有两处需要你知道：

**1. 缓存里有对话全文**

```
~/.pi/agent/cache/pi-conversations/text/*.txt    # 用户消息 + 助手回复 + 思考 + 摘要
~/.pi/agent/cache/pi-conversations/trash/        # 你删除的会话（完整 jsonl）
```

搜索之所以快，是因为全文落盘了。这意味着：你在对话里粘贴过的密钥、内网地址、私人内容，都会以明文躺在这些文件里。

- 目录权限建为 `0700`、文件 `0600`（POSIX 平台生效；Windows 继承用户目录 ACL）
- 清空：`/conversations reset`（只删索引与全文缓存，会话文件本身不动，`trash/` 保留）
- 连 `trash/` 一起清：手动删掉 `~/.pi/agent/cache/pi-conversations`
- 不要把 `~/.pi/agent` 放进同步盘（OneDrive/Dropbox/iCloud）

**2. 访问 token 在 URL 里**

页面地址是 `http://127.0.0.1:<port>/?t=<random>`，token 每次启动重新生成、pi 退出即失效。为防泄漏已加 `Referrer-Policy: no-referrer` 和 CSP；不要把这个 URL 贴给别人或提交到仓库。

另外，「导出 HTML / 下载 JSONL」会把会话全文和绝对路径写进文件——那是你自己主动导出的产物，分享前先看一眼。
