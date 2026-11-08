# Working Memory for the Physical World — Design

> **Framing (decision 0026):** enterprise operational memory, not a personal assistant.
> Enterprise AI retrieves over documents, tickets, and chat; nothing captures what happens
> on the floor, at the bench, or in the field. This system turns that into an evidence-backed
> event graph that people and agents can query. NMC² (data center shifts) is one application
> shown in the demo, not the product boundary.

Living design document. Edit in place; add a line to the changelog at the bottom. Where this
file and a newer `#log` `[DECISION]` disagree, the newer `#log` post wins until the sweeper
folds it in (see `CLAUDE.md`). Individual decisions with their reasons live in
`docs/decisions/`.

## 1. What this is

An organization's memory of physical work. Operators photograph discrete moments with Meta
Ray-Ban glasses as they work. Each photo becomes an event in a shared, time-anchored graph
attributed to a wearer and a shift and resolved against the organization's assets. The
system interprets the graph into timelines, shift handoffs, and alerts, and exposes it to
people and to the agents the organization already runs, through MCP. Every answer cites the
photo, time, and wearer it came from.

**Pitch:** the missing modality in enterprise knowledge. Retrieval today covers documents,
tickets, and chat. The floor, the bench, and the field are undocumented until someone
writes it up after the fact, and that knowledge leaves with the shift.

**Shown application (NMC²):** data center operators do physical rounds that no system
records. A missed warning, an unclear handoff, or the wrong information at the wrong time
becomes an outage. The next shift, or a supervisor who was never on the floor, gets a
queryable memory: what was touched, what changed, what looked wrong, with the photo for
each claim, and an alert the moment a photo shows a fault. Labs, field service, facilities,
and manufacturing are the same system with different photos.

**Scope for the hackathon:** image-only, physical-only, Spacetime-hosted.
- Image-only: no audio, no continuous stream, no on-phone triggers. One photo per event.
- Physical-only: no laptop screen capture. Cross-modal linking is designed in but not built.
- Spacetime: the backend is a SpacetimeDB module on Maincloud. No Postgres, no Neo4j, no
  separate API server.

**Sponsor tracks:** NVIDIA (Nemotron as the multi-step agent), NMC² (data center teams),
Spacetime (majority of backend on Spacetime).

## 2. Capabilities

| Class | Capability | Status |
|---|---|---|
| A. Recall | Episodic timeline, semantic search, notes attached to photos | MVP |
| B. Object and state tracking | Find an object, state history, what changed since a time | MVP |
| D. Live context | `get_current_context`: what the latest photo shows | MVP |
| F. Handoff | `summarize_handoff(since)`: shift summary with evidence, posted to a channel | MVP (NMC² demo beat) |
| E'. Alerts | Rule in `perceive`: fault/alarm text or OK→FAULT change raises an `alert` row and a channel post | MVP (enterprise beat) |
| Attribution | Every event carries `wearer` and `shift`; queries and handoffs filter by them | MVP |
| Assets | `asset` registry seeded from CSV; text read in the scene is matched to canonical asset IDs | MVP |
| Timeline | Generated episodes of the shift with evidence per segment | MVP (the demo artifact) |
| C. Cross-modal provenance | Physical event ↔ screen artifact | Deferred (no screen capture) |
| E. Consistency and diagnosis | Mismatch alerts, causal "why" | Deferred (needs C) |
| F. Procedure | Protocol compliance, checklist verification | Stretch |
| G. Excluded | Identifying people in photos, SSO, multi-tenancy, admin console | Never this weekend |

## 3. Architecture

```
[Meta Ray-Ban glasses]
   | shutter button or in-app Capture → photo bytes on the SDK photo listener
   v
[iOS app]  resize to 1600 px long edge, blur faces, base64
   |  POST https://maincloud.spacetimedb.com/v1/database/<db>/call/ingest_photo   (JSON args)
   v
┌──────────────────────── SpacetimeDB module (TypeScript, Maincloud) ────────────────────────┐
│ tables:   event, photo, entity, edge, episode, handoff, job                                 │
│ procedure ingest_photo(event_json, photo_b64)  → insert event+photo, schedule perceive     │
│ procedure perceive(job)  → ctx.http.fetch Azure OpenAI gpt-4o (structured JSON)             │
│                           → ctx.http.fetch Azure AI Vision (image embedding)                │
│                           → withTx: entities, edges, event.summary, status=in_graph         │
│                           → schedule segment                                                 │
│ procedure segment()      → episode boundaries; Nemotron titles/summaries                     │
│ procedure ask(question)  → Nemotron tool loop over tables (search, timeline, changes, …)     │
│ procedure handoff(since) → Nemotron shift summary with event citations                      │
│ reducers: set_label, set_note, mark_duplicate                                               │
└──────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                       │ WebSocket subscriptions (TypeScript SDK)
            ┌──────────────────────────┼──────────────────────────────┐
            v                          v                              v
   [Live graph + timeline web page]  [MCP server (Node, stdio)]  [iOS app status]
                                       ^
                               [Claude Desktop / Claude Code = demo client]
```

Clock: the phone sends `client_t`; the module stamps `server_t` on receipt and records the
skew. For camera-roll imports `client_t` is the photo's original creation time.

## 4. Capture (iOS, Edward)

Meta Wearables Device Access Toolkit 1.0 (stable since 2026-09-30, no approval gate).
Requires Xcode 26.4+, iOS 17.2+, Developer Mode in the Meta AI app (Settings > App Info >
tap the version number five times). MockDeviceKit / MockCameraCaptureKit for development.

Three ways a photo reaches the backend, all through the same procedure call. The first two
go through our app's SDK session; the third needs no session.

1. **Shutter button (primary bulk path).** While our app holds an active device session,
   presses of the glasses' physical button reach the app as input events from the
   `MWDATInputs` capability and the app takes the photo itself (verified on real glasses
   2026-11-07: the photo capability does not deliver button photos on its own). Uploaded as
   `source: shutter_button`. Works while backgrounded (4 of 5 in measurement 1); presses during
   a transfer are queued. A spoken note recorded while the photo transfers goes into `note`
   (decision 0027).
2. **Capture button in our app (live demo path).** Standalone photo capture, no stream:
   session started → `capturePhoto(resolution: .full, quality: .high)` → bytes on the
   listener → upload as `source: sdk_capture`. The app subscribes to its own event row and
   shows `accepted → perceived → in_graph`.
3. **Camera-roll import (fallback).** Photos taken while our app was not running sync via the
   Meta AI app to the Photos library; the app uploads new items with original timestamps as
   `source: camera_roll`.

Before upload the app resizes to 1600 px on the long edge (JPEG q85, ~300–500 KB), blurs
faces (Vision face rectangles), converts HEIC to JPEG, and base64-encodes. Optional typed
`note` and `label`. Upload is a JSON POST to the module's `ingest_photo` procedure with a
small bounded on-disk retry queue; `event_id` makes retries idempotent.

Toolkit facts for the capture code (from the 1.0 docs; verify names against the docs MCP,
never guess): modules `MWDATCore`, `MWDATCamera`, `MWDATMockDevice`; registration opens
the Meta AI app, which grants the `.camera` permission; standalone photo is beta and
competes with streaming for the camera, so we never stream; keep one capture in flight;
a capture silent for 30 s fails; startup is the most common failure, retry once with a
fresh camera setup; closing the hinges forces the session to STOPPED and reopening does
not restart it. No custom tap input, no motion data, no Meta AI hooks; one session per
device; the toolkit cannot ship to the App Store (development builds only, fine for us).
Continuous streaming is limited to roughly 30 minutes by thermals, which is why there is
no sentinel stream. Docs MCP: `https://mcp.developer.meta.com/wearables`
(`search_dat_docs`) or the `mwdat-ios` plugin.

## 5. Backend: the Spacetime module (Gary)

One TypeScript module published to Maincloud (`spacetime publish <db> --server maincloud`).
TypeScript because procedures are stable there (C# and C++ procedures are marked unstable)
and because the web UI and MCP server share the language and generated bindings.

**Tables**

| Table | Key fields | Notes |
|---|---|---|
| `event` | `event_id` (pk), `client_t`, `server_t`, `source`, `status`, `summary`, `scene`, `activity`, `people_count`, `confidence`, `thumb` (bytes, ~320 px), `embedding` (f32[]), `note`, `label` | Subscribed by UI and MCP. Public. |
| `photo` | `event_id` (pk), `jpeg` (bytes, 1600 px) | Not subscribed; fetched on demand by `event_id`. Public read. |
| `entity` | `entity_id` (pk), `canonical_name`, `aliases`, `kind` (object, place, asset) | Assets are entities with `kind: asset`, seeded from the registry. |
| `asset` | `asset_id` (pk), `name`, `type`, `location`, `patterns` (strings/regex matched against `text_in_scene`) | Seeded by an admin reducer from `demo/assets.csv`. |
| `wearer` | `device_id` (pk), `name`, `role`, `shift` | Attribution; set by an admin reducer. |
| `alert` | `alert_id` (pk), `event_id`, `kind`, `text`, `t_micros`, `acked` | Written by `perceive`; posted to Slack via webhook. |
| `edge` | `edge_id` (pk), `from_id`, `to_id`, `type` (NEXT, INVOLVES, CHANGES, EVIDENCED_BY, SIMILAR_TO), `props` (JSON string: role, attr, from, to, score) | The graph. |
| `episode` | `episode_id` (pk), `t_start`, `t_end`, `title`, `summary`, `event_ids` | Timeline output. |
| `handoff` | `handoff_id` (pk), `since`, `generated_t`, `text`, `event_ids` | Cached shift summaries. |
| `job` | schedule table | one-shot rows drive `perceive` and `segment`. |

Reserved for later, unused: `screen_event`, edge types `RELATED_TO` and `BOUND_TO`.

**Procedures and reducers**

- `ingest_photo(event_json: string, photo_b64: string)`: validate; idempotent on `event_id`
  (return existing `server_t`); `withTx` insert `event` (status `accepted`) and `photo`;
  insert a one-shot `job` row so `perceive` runs immediately. Returns `{event_id, server_t}`.
  Called by the phone over HTTP: `POST /v1/database/<db>/call/ingest_photo` with body
  `["<event_json>", "<photo_b64>"]`. Auth: a shared `INGEST_TOKEN` inside `event_json`
  checked by the procedure (anonymous HTTP callers are allowed on public tables); upgrade
  to a Spacetime identity token if time allows.
- `perceive(job)`: scheduled. `ctx.http.fetch` to Azure OpenAI `vlm-gpt-4o` with the image
  and the previous event's summary; `ctx.http.fetch` to Azure AI Vision `vectorizeImage`;
  `withTx` write perception fields, upsert entities (name normalization, `label` wins),
  insert `INVOLVES`, `CHANGES`, `NEXT`, `EVIDENCED_BY` edges, `SIMILAR_TO` for top cosine
  neighbours, set status `in_graph`; schedule `segment`. Procedures cannot hold a
  transaction across an HTTP call, so each step is its own `withTx`. Default HTTP timeout
  is 30 s, max 180 s.
- `segment()`: scheduled after each perception. Episode boundary on place change, gap over a
  threshold, or embedding jump; Nemotron titles and summarizes the affected episode only.
- `ask(question: string)`: the Nemotron tool loop. Tools are plain functions over the tables:
  `search_memory`, `get_timeline`, `what_changed`, `find_object`, `get_current_context`,
  `explain_change`, `get_provenance`, `summarize_handoff`. Returns `{answer, citations[]}`
  where citations are `event_id`s. Up to N tool rounds, each round one `ctx.http.fetch` to
  Nemotron with OpenAI-style tool calling.
- `handoff(since: string)`: Nemotron summary of events since a time, grouped by place and
  entity, with citations; cached in `handoff`.
- Reducers `set_label`, `set_note`, `mark_duplicate`, `ack_alert`: small state edits from the
  UI or app. Admin reducers `upsert_asset`, `upsert_wearer` (owner only) seed the registry.
- Alert rule inside `perceive` (after the model call): if `text_in_scene` matches a warning
  pattern (FAULT, ALARM, DO NOT, OVERTEMP, …) or a `changes_since_previous` entry goes to a
  fault-like state, insert an `alert` row and `ctx.http.fetch` a Slack incoming webhook
  (`SLACK_WEBHOOK_URL` in the module env). `handoff` posts the same way at shift end.

**Why this satisfies "majority of backend on Spacetime":** ingestion, storage, perception
orchestration, graph building, timeline, the agent loop, and the handoff all run inside the
module. The only code outside it is the MCP stdio adapter, the web page, and the iOS app.

## 6. Perception

Per photo, inside `perceive`:

1. Perceptual hash against the previous few photos; near-duplicates get a `SIMILAR_TO` edge
   and skip the VLM (status `in_graph`, summary copied).
2. **Nemotron 3.5 Super VL** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, reasoning disabled
   via `chat_template_kwargs: {enable_thinking: false}`) with the image and the previous
   event's summary as context, returning JSON: `scene`, `location_guess`, `objects[]` (name,
   attributes, position), `people_count` (no identity), `activity`, `text_in_scene[]`,
   `changes_since_previous[]` (`{entity, attr, from, to}`), `summary`, `confidence`. Text in
   the scene (rack labels, panel readouts, cable tags) is read by the VLM; no separate OCR.
   Fallback on 429 or timeout: Azure gpt-4o (`vlm-gpt-4o`) with the same prompt and
   `response_format: json_object`. Bake-off 2026-11-07 on a rack-label scene: both read all
   eight strings and detected all three changes; Nemotron 4.7 s vs gpt-4o 7.3 s.
3. Azure AI Vision image embedding (1024-d) stored on the event for `search_memory` and the
   episode boundary test. Query text is embedded with the same Vision text endpoint so image
   and text vectors are comparable. Cosine similarity is a loop over events; at hundreds of
   rows this is fast enough.
4. With reasoning left on, the VL model spends most of its token budget thinking and can
   truncate the JSON; keep `enable_thinking: false` for perception and give the agent loop
   a budget if reasoning is wanted there.

Target under 15 seconds from upload to `in_graph`.

## 7. Graph model

Same model as before, stored as `entity` and `edge` rows:

```
Event -NEXT-> Event                      // chronology
Event -INVOLVES{role}-> Entity           // subject | tool | target | setting
Event -CHANGES{attr,from,to}-> Entity    // from perception.changes_since_previous
Event -EVIDENCED_BY-> Photo              // event_id = photo_id
Event -SIMILAR_TO{score}-> Event         // embeddings
(Entity -BOUND_TO-> DigitalArtifact, Event -RELATED_TO-> Event: reserved, unused)
```

Entity resolution for MVP, in priority order: (1) a `label` typed by the wearer; (2) a match
between `text_in_scene` and an `asset.patterns` entry, which links the event to the canonical
asset; (3) the VLM's object names, normalized and alias-merged. Places come from
`location_guess` plus clustering of consecutive events. No visual re-identification.

## 8. Timeline and handoff

`segment` splits the shift into episodes: a new episode on a place change, a gap longer than
a threshold, or a large embedding jump. Each episode gets a title and summary from Nemotron
over its events, a time span, its thumbnails, and its entities. `handoff(since)` produces the
NMC² artifact: "since the last shift: rows visited, equipment touched, changes observed,
anything that looked abnormal," each line citing an `event_id`.

## 9. Agent and MCP

**Agent = Nemotron inside the `ask` procedure.** Model via NVIDIA's OpenAI-compatible endpoint
`https://integrate.api.nvidia.com/v1` with a Developer Program key. Default
`nvidia/nemotron-3.5-lightning-30b-a3b` for latency; `nvidia/nemotron-3-ultra-550b-a55b` if answer quality
needs it. It is a reasoning model: `chat_template_kwargs: {enable_thinking: false}` turns
thinking off (verified), otherwise allow several hundred tokens of budget or the content
comes back empty. With perception also on Nemotron, the pipeline is Nemotron end to end:
perception, episode summaries, the agent loop, and the handoff. Verify exact IDs on build.nvidia.com; free-tier lists change. The loop: system
prompt with the tool schema → model → tool calls executed against tables → model → final
answer with citations. This is the NVIDIA "multi-step workflow with tool integration."

**MCP server** (`mcp/`, Node, stdio): exposes the eight tools below. Each tool calls the
corresponding module function via the TypeScript SDK (or `ask` for free-form questions) and
turns `event_id` citations into image URLs served from the `photo` table. Client for the
demo: Claude Desktop or Claude Code.

| Tool | Returns |
|---|---|
| `search_memory(query, time_range?)` | ranked events with summaries and photo URLs |
| `get_timeline(range)` | episodes with spans, titles, thumbnails |
| `what_changed(entity, since)` | `CHANGES` edges for the entity, with evidence |
| `find_object(name)` | last-seen event, place, photo |
| `get_current_context()` | latest event's structured description and photo |
| `explain_change(entity)` | narrative over the change chain |
| `get_provenance(id)` | events and photos behind an entity or claim |
| `summarize_handoff(since)` | shift handoff text with citations |

**Live view** (`web/`): one page using the TypeScript SDK (`DbConnection.builder()
.withUri('wss://maincloud.spacetimedb.com').withDatabaseName(<db>)`), subscribed to `event`,
`entity`, `edge`, `episode`. Timeline on the left, force graph on the right, new rows animate
in. This is the Spacetime "multiplayer by default" beat and the NMC² wall display.

## 10. Demo

Framed as a data center floor across a shift change (the hackathon venue stands in). Two
wearers if the second pair of glasses is available.

1. Operators photograph their shift from the first hour: racks, panels, cable work, a
   conversation, a snack run. Shutter button, glasses used normally. One photographed event
   is a deliberate asset change (a label moved, a cable re-routed).
2. Show the live timeline and graph for the floor, attributed by wearer.
3. **Alert beat:** a photo of a panel showing a fault state fires an alert in the web view
   and in Slack within seconds of the shutter press.
4. **Handoff beat:** the shift ends; `summarize_handoff` posts the handoff to the channel,
   grouped by asset, each line citing a photo.
5. **Supervisor beat:** from Claude connected to our MCP server, someone who was not on the
   floor asks "what happened to PDU-A today," "who was last at rack R12," "what changed
   since the morning shift." Every answer shows its photo, time, and wearer.
6. **Live beat:** take a photo on stage; it appears in the view within seconds; ask about it.

The pitch names the general product once (enterprise memory for physical work) and spends
the rest of the time on this application.

Record a backup walkthrough in case venue connectivity fails.

## 11. Build plan and ownership

Edward + agents: capture app (issues 1, 2, 10). Gary + agents: Spacetime module, MCP server,
web view (3–9, 12). Both: demo (11).

| Phase | Goal |
|---|---|
| Hour 0–2 | Repo up. Spacetime module scaffolded and published to Maincloud with `event` + `photo` tables and `ingest_photo`; web page subscribing and showing rows. Capture app posting a MockDeviceKit photo. Start photographing the day. |
| Day 1 afternoon | `perceive` with Azure calls against fixtures and real photos. Real glasses on the shutter path. |
| Day 1 night | Graph edges, `segment`, Nemotron `ask` loop, `handoff`. |
| Day 2 morning | MCP server, Claude Desktop connected, web view polished. |
| Day 2 afternoon | Five end-to-end rehearsals including the live beat. Backup recording. Submission text covering all three tracks. |

## 12. Infrastructure

- **Spacetime Maincloud**: database `<db>` (name decided at publish). Free tier auto-pauses
  when idle and resumes in under a second. HTTP API for the phone; WebSocket for subscribers.
  Redeem the HACKUTD2026 credit at the booth.
- **Azure** (sponsored subscription `bef2f3be-…dfe0`): resource group `hackutd-wm`, East US,
  multi-service resource `hackutd-wm-garysun`. Deployments `vlm-gpt-4o` (200K TPM),
  `text-embedding-3-small` (unused if Vision text embeddings suffice), `agent-gpt-5`
  (fallback agent if Nemotron is unavailable). Speech is provisioned, unused.
- **NVIDIA**: Developer Program key for `integrate.api.nvidia.com` (free tier, about 40
  requests per minute per model; perception plus agent traffic stays well under that).
  Brev credits unused. Optional: `nvidia/llama-nemotron-embed-vl-1b-v2` could replace Azure
  Vision embeddings to make the stack all-NVIDIA; untested.
- Secrets: the module reads keys from its own config table written by an admin reducer, or
  from publish-time environment if supported; never in the repo. Laptop `.env` for the MCP
  server and scripts. Cloud agent sessions: proxy-injected keys, set the variable to
  `proxy-injected`.

## 13. Privacy defaults

Governance language for the pitch, all true of the build: capture is deliberate (one photo
per event), not passive; faces are blurred on the device before upload; people are counted,
never identified; no audio; every claim is traceable to a photo, a time, and a wearer;
retention is a configuration choice; the module runs on Maincloud for the demo and on a
self-hosted SpacetimeDB for a customer who needs data to stay in the building. Not built
this weekend: role-based access (Spacetime row-level security would be the mechanism), SSO,
multi-tenancy.

## 14. Risks

1. Spacetime is new to the team. Mitigation: hour 0–2 is a vertical slice (table, procedure,
   subscription, publish); if it is not working by 14:30 the fallback is Postgres + Neo4j on a
   laptop as previously designed, and the Spacetime track is dropped.
2. Shutter-button delivery to our app while backgrounded is not documented (T7 first test).
3. Standalone photo capture is beta: startup failures and the 30 s transfer timeout are
   documented. Measure capture-to-bytes latency on real glasses early.
4. Procedure HTTP calls block for up to 30 s by default; a slow VLM call delays `in_graph`.
   Set explicit timeouts and keep the phone's upload path (`ingest_photo`) free of HTTP calls.
5. Entity resolution from VLM names alone will merge or split things wrongly; keep answers
   evidence-first so a wrong merge is visible rather than silent.
6. Venue connectivity: phone uploads over cellular; laptop needs Wi-Fi or hotspot for the
   web view and MCP. Backup recording is mandatory.

## 15. Future work (designed in, not built)

Audio capture and transcripts with voice commands; a sentinel stream with on-phone triggers;
laptop screen capture with `RELATED_TO` scoring and the consistency rule; versioned state
nodes; learned bindings; multi-shift consolidation; row-level security per wearer.

## Changelog

- 2026-11-08 v4.3: location on every photo and a shift track from the phone (`event_location`,
  `track_point`, `ingest_track`, contract v3.1); the console's canvas is the site map with the
  relationship graph as the lens; spoken notes into `note`; shutter path corrected. Decisions
  0027, 0028.
- 2026-11-07 v4.2: enterprise operational-memory framing; wearer attribution, asset
  registry, alert rule, channel posting; demo rewritten around alert, handoff, supervisor
  beats. Decision 0026.
- 2026-11-07 v4.1: Nemotron 3.5 Super VL is the primary perception model after a bake-off;
  gpt-4o is the fallback. Exact model IDs recorded. Decision 0025.
- 2026-11-07 v4: Spacetime module replaces Postgres, Neo4j, API server and LangGraph;
  Nemotron is the agent; NMC² shift-handoff framing; `summarize_handoff` added; phone uploads
  base64 JSON to a procedure; hosting moves to Maincloud. Decisions 0021–0024.
- 2026-11-07 v3: Consolidated from the seed document, SHARED CONTEXT messages, and
  `#log` decisions 0001–0020. Image-only, physical-only, own backend, GitHub Issues board.
