# Working Memory for the Physical World (HackUTD 2026)

Two humans (Gary, Edward) and several coding agents. This file is the agent entry point.

## What this is

Enterprise operational memory for physical work: the missing modality in enterprise
knowledge. Operators take one photo per discrete event with Meta Ray-Ban glasses (image-only:
no audio, no stream, no triggers); events are attributed to a wearer and shift and resolved
against an asset registry. The shown application is a data center shift change (NMC² track);
it is one application, not the product boundary. A SpacetimeDB module on Maincloud stores the photos, runs
perception (Azure gpt-4o), builds the event graph, generates the timeline and shift handoff,
and runs a Nemotron tool-calling agent (NVIDIA track). An MCP server exposes it to any agent.
Physical-only: no laptop screen capture; cross-modal hooks are reserved, unused.
Sponsor tracks: NVIDIA, NMC², Spacetime (majority of backend on Spacetime).

Demo: the wearer photographs their "shift" at the venue; judges query it through Claude
Desktop over MCP and see the live timeline/graph web view. Live beat: take a photo on stage,
it appears in the web view within seconds, ask about it immediately, then generate the
handoff. The day's real photos are the demo data, so capture starts early.

## Read first, every session

1. `docs/DESIGN.md` — the living design. `docs/CONTRACT.md` — phone ↔ module interface.
2. `docs/decisions/` — one file per decision, newest number wins.
3. GitHub Issues — the task board. `gh issue list` shows what is open and who owns it.
4. Slack `#log`, every message newer than the last commit to `docs/`. A newer `#log`
   `[DECISION]` overrides the docs until the sweeper folds it in.

If Slack is unreachable, say so and continue from the repo alone.

## Where things live

| Need | Place | Latency |
|---|---|---|
| Claim, blocker, question, completion, decision announcement | Slack `#log` | seconds |
| Task status, assignee, notes | GitHub Issues (`gh issue …`), no commit needed | seconds |
| Design, contract, decision records | `docs/` in this repo | minutes, batched |

Humans and agents never commit docs just to send an update. Post in `#log`; one sweeper
agent (Gary's Claude session) folds `[DECISION]` posts into `docs/decisions/NNNN-slug.md`
and `DESIGN.md` and commits. Appends are one file per decision, so they never conflict.

## Slack conventions

- `#general`: humans, plus one pinned pointer message to this repo. Nothing else pinned.
- `#log`: one top-level message per event, details in thread. Prefixes `[CLAIMED]`,
  `[DONE]`, `[BLOCKED]`, `[DECISION]`. Agents prefix with their name in parentheses:
  `[DONE] (Claude) #12 …`. Humans use no parenthetical. Reference the issue number.
- `#ideas`: human brainstorming; agents read only when asked.

## Tasks and branches

- Every task is a GitHub Issue. Claim by assigning yourself and posting `[CLAIMED]` in `#log`.
- Branch `area/<issue>-short-task`, e.g. `capture/1-photo-button`, `module/5-perceive`.
- Small commits, issue number in the message. Pull requests close issues at integration
  points; direct pushes to `main` are fine for docs and for work inside your own area.

## Ownership

Capture + iOS app: Edward + agents. Spacetime module, MCP server, web view: Gary + agents.
Ask before touching the other side's area, changing `CONTRACT.md` or the table schema, or
adding a service or dependency.

## Decided stack (see `docs/decisions/` for reasons)

- Phone: iOS, Swift, Meta Wearables Device Access Toolkit 1.0 (Xcode 26.4+, iOS 17.2+,
  Developer Mode on in the Meta AI app). Standalone photo capture; shutter-button photos
  arrive on the same listener. MockDeviceKit first, then real glasses (in hand).
- Backend: one SpacetimeDB module in TypeScript on Maincloud. Tables event, photo, entity,
  edge, episode, handoff, job. Procedures ingest_photo, perceive, segment, ask, handoff
  (procedures make the outbound HTTP calls). No Postgres, Neo4j, or API server. The phone
  calls ingest_photo over HTTP with JSON args; the web view and MCP server subscribe via
  the TypeScript SDK. Spacetime docs: https://spacetimedb.com/docs (verify API names there,
  never guess).
- Models: NVIDIA Nemotron end to end via integrate.api.nvidia.com (OpenAI-compatible):
  `nvidia/nemotron-3.5-super-vl-120b-a12b` for perception, `nvidia/nemotron-3.5-lightning-30b-a3b`
  for the agent loop, episode titles, and handoff; pass `chat_template_kwargs:
  {enable_thinking: false}` unless you want reasoning and give it budget. Azure gpt-4o is
  the perception fallback and Azure gpt-5 the agent fallback. Azure AI Vision multimodal
  embeddings for image search. Azure Speech is
  provisioned, unused. Claude Desktop is the MCP client in the demo.
- Azure resource (created 2026-11-07): resource group `hackutd-wm`, East US, multi-service
  resource `hackutd-wm-garysun`. Deployments `vlm-gpt-4o`, `agent-gpt-5`,
  `text-embedding-3-small`. Endpoints and variable names in `.env.example`.
- MCP tools: `search_memory`, `get_timeline`, `what_changed`, `find_object`,
  `get_current_context`, `explain_change`, `get_provenance`, `summarize_handoff`.
- Capability scope: A recall, B object/state tracking, D live context, F handoff summary,
  alerts from fault-like text or changes, wearer attribution, asset registry matching, plus
  the generated timeline are MVP. C cross-modal provenance and full E consistency are
  deferred (physical-only). Protocol compliance is stretch. Excluded: identifying people in
  photos, SSO, multi-tenancy, admin console.
- Time box: if the Spacetime vertical slice is not working by 14:30 on day 1, fall back to
  Postgres + Neo4j on a laptop and drop the Spacetime track (decision 0022).

## Hard rules

- **Never guess Meta SDK API names.** Docs MCP: `https://mcp.developer.meta.com/wearables`
  (tool `search_dat_docs`), or `claude plugin marketplace add facebook/meta-wearables-dat-ios`
  then `claude plugin install mwdat-ios@mwdat-ios-marketplace`.
- **Never guess Spacetime API names.** Read https://spacetimedb.com/docs for the module
  language you are in; generated bindings come from the `spacetime` CLI.
- Read docs before writing against any other unfamiliar API.
- Secrets: never in the repo or Slack. The module reads Azure, NVIDIA, and ingest_token from
  a private config table set by an admin reducer. Laptop tooling uses `.env` from
  `.env.example`. Cloud agent sessions: keys are proxy-injected; set the variable to
  `proxy-injected`.
- Privacy: faces are blurred on the phone before upload; count people, never identify them.
- Hackathon pace: the simplest thing that supports the demo. Flag debt in `#log`.

## Layout

```
capture-app/   iOS: Capture button, shutter listener, camera-roll watcher, upload
module/        SpacetimeDB TypeScript module: tables, reducers, procedures
web/           live timeline + graph page (TypeScript SDK subscriptions)
mcp/           MCP server (Node, stdio) over module procedures
demo/          fixtures, replay script, demo script, rehearsal checklist, backup recording
docs/          DESIGN.md, CONTRACT.md, decisions/
```
