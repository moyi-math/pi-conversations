# Changelog

Format matches Pi's own changelog: version headings are compared against
`version` in `package.json`, and Pi shows entries newer than the last version it
saw under "Extension Updates" on the next fresh launch.

## [0.1.0] - 2026-11-19

Initial release.

- `/conversations` starts a local web UI (127.0.0.1, per-run token) that keeps
  running in the background until `/conversations stop` or pi exits.
- Browse all sessions grouped by project; filter by project, named-only, and
  sort by activity, message count, cost, or creation time.
- Full-text search across user messages, assistant replies, thinking, and
  summaries, with highlighted snippets.
- Session detail view: messages, thinking, tool calls and results, compaction
  and branch summaries, model changes.
- Rename sessions (appends `session_info`), soft-delete to a local trash folder,
  export to standalone HTML or raw JSONL.
- Statistics: totals, 26-week activity heatmap, per-project and per-model
  summaries.
- Copyable `pi --session <path>` launch commands for PowerShell/Git Bash and cmd.
- Incremental index cache under `~/.pi/agent/cache/pi-conversations`, refreshed
  on page reload or via the header "sync" button.
