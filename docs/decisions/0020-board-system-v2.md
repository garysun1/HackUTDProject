# 0020 board system v2

- Date: 2026-11-07
- Status: active
- Source: Gary

**Decision.** Repo is the state store (DESIGN.md, CONTRACT.md, decisions/), Slack #log is the event stream, GitHub Issues are the task board, one pinned pointer in #general, one sweeper agent commits decisions. Newer #log beats docs until swept.

**Reason.** Immutable Slack messages went stale; git latency is fine for docs and absent for Issues.
