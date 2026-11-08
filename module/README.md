# wm-physical module

SpacetimeDB TypeScript module on Maincloud, database `wm-physical`. Source in
`spacetimedb/src/index.ts`. Pure rules (alert rule, asset matching) live in `spacetimedb/src/rules.ts`
and are tested with Node, no Spacetime runtime needed:

```bash
cd module && node --experimental-strip-types --test test/rules.test.ts
```

## Pipeline per photo

`ingest_photo` → scheduled `perceive`:

1. Azure AI Vision `vectorizeImage` gives a 1024-d embedding (`event.embedding`). Optional.
2. Perception: Nemotron VL (`nvidia/nemotron-3.5-super-vl-120b-a12b`, 25 s timeout). Any failure
   (HTTP error, timeout, bad JSON) falls back to Azure `vlm-gpt-4o` (30 s). With no keys at all, a
   stub is written so the slice still works. `event.perception_json._meta` records the model, the
   latency, and the fallback reason.
3. Graph: `EVIDENCED_BY`, `NEXT` (capture order), `INVOLVES` (label → subject, registry assets read in the scene →
   asset, object names → target, location → setting), `CHANGES`, and `SIMILAR_TO` (top 3 earlier
   events with cosine ≥ 0.85). The model sees the last 6 perceived events tagged with their assets and
   compares equipment only with its own earlier sighting; a `CHANGES` edge needs an asset seen in an
   earlier photo, a real difference, and the asset in this photo. Anomalies about a registry asset the
   photo does not show are dropped as restated history.
4. Alert rule: fault words in `text_in_scene` (FAULT, FAIL, ALARM, CRITICAL, OVERTEMP, OVERLOAD,
   DEGRADED, TRIPPED, LEAK, OFFLINE, DOWN, ERROR), a change from a healthy value into one, or a
   `high`-severity anomaly. Findings are grouped into **one alert per asset**. While that alert is
   unacked (30 min window), later findings on the same asset are appended to it instead of
   posting again.
5. New alerts post to Slack through `SLACK_WEBHOOK_URL`; the result is in `alert.slack_status`.

## Datasets and workspaces (decisions 0029, 0031)

Six databases run this module: `wm-physical` (the real capture) and five synthetic floors,
`wm-nmc2`, `wm-plant`, `wm-hospital`, `wm-substation`, `wm-warehouse`, replayed from
`demo/synth/`. Which one the console and MCP server show is the row `active_dataset` in
`wm-physical`'s `demo_config` table. Switch it with the admin token; every open console follows
within a second, no reload:

```bash
ADMIN_TOKEN=... node module/scripts/dataset.mjs            # current dataset and photo counts
ADMIN_TOKEN=... node module/scripts/dataset.mjs wm-nmc2    # show the data center shift
ADMIN_TOKEN=... node module/scripts/dataset.mjs live       # back to the real capture
```

Rebuild a synthetic database from its scenario (seeds registry and wearers, ingests the photos
with a synthetic walk and shift track, waits for perception):

```bash
INGEST_TOKEN=... node demo/synth/replay.mjs nmc2-datacenter --db wm-nmc2
```

The console also has a workspace switcher in its top bar (names, vocabulary and type words in
`web/src/workspaces.ts`) that swaps databases client-side; `demo_config` remains the default for
any console that has not chosen. Questions asked over MCP land in the `question` table through
`log_question` (ingest token) and appear on the shift line under the photos that answered them.

Publishing a new module version goes to all six (`spacetime publish <db> -s maincloud`); each
database keeps its own env, so pass the keys on the first publish of a new database.

## Secrets and config (#14)

Secrets are the database's environment variables, declared in the schema and never in the repo.
From a logged-in laptop (`spacetime login` first), in `module/`. `spacetime publish` reads every
declared variable from the shell (CLI 2.14.1), so one command publishes the code and sets the keys;
unspecified variables keep their stored values:

```bash
NVIDIA_API_KEY=... AZURE_AI_KEY=... SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... ADMIN_TOKEN=... \
  spacetime publish wm-physical --server maincloud
```

Change values later without uploading code with `--env-only`, remove one with `--unset-env KEY`.
Tested locally: publishing this version over a database running the #3 slice keeps its data.

Verify with `spacetime describe wm-physical env --server maincloud` (lists the declared env).

| Variable | Required | Use |
|---|---|---|
| `INGEST_TOKEN` | yes (already set) | checked by `ingest_photo` |
| `ADMIN_TOKEN` | no | admin reducers; falls back to `INGEST_TOKEN` |
| `NVIDIA_API_KEY` | for real perception | Nemotron VL |
| `NVIDIA_VL_MODEL` | no | override the VL model ID |
| `AZURE_AI_KEY` | for fallback + embeddings | one key for Azure OpenAI and AI Vision |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_VLM_DEPLOYMENT`, `AZURE_AI_SERVICES_ENDPOINT` | no | default to the `hackutd-wm-garysun` resource and `vlm-gpt-4o` |
| `SLACK_WEBHOOK_URL` | for alert posting | Slack incoming webhook for the alerts channel |
| `NVIDIA_AGENT_MODEL` | no | text model for handoff and ask; default `nvidia/nemotron-3.5-lightning-30b-a3b` |
| `AZURE_AGENT_DEPLOYMENT` | no | gpt-5 fallback for handoff and ask; default `agent-gpt-5` |

Check the webhook end to end (module HTTP calls to private addresses are refused, so this needs
the real Slack URL):

```bash
curl -X POST https://maincloud.spacetimedb.com/v1/database/wm-physical/call/slack_test \
  -H 'Content-Type: application/json' -d '["<ADMIN_TOKEN>"]'
```

## Registry and wearers (#15, #16)

```bash
ADMIN_TOKEN=... node module/scripts/seed.mjs demo/assets.csv demo/wearers.csv
```

`demo/assets.csv`: `asset_id,name,type,location,patterns`. `patterns` is `;`-separated; each
matches when its letters and digits appear in a string read in the scene ("PDU-A" matches
"PDU A RACK R12"). Wrap a pattern in slashes for a case-insensitive regex. Replace the sample
rows with the labels actually photographed at the venue.

`demo/wearers.csv`: `device_id,name,role,shift`. The phone's `device_id` comes from the capture
app's event JSON; rows starting with `REPLACE` are skipped.

## Handoff (#8)

`handoff(since)` returns the shift handoff as text and caches it in the `handoff` table. `since` is
`""` (since the last handoff, else the whole record), `"0"` (whole record), micros, millis, seconds,
`"2h"`, or ISO-8601. The console's Generate button and the MCP `summarize_handoff` tool call it.

```bash
curl -X POST https://maincloud.spacetimedb.com/v1/database/wm-physical/call/handoff \
  -H 'Content-Type: application/json' -d '[""]'
```

How it is written: the window's events (assets, place, summary, note, change edges), alerts (open
ones however old, resolved ones in the window, with the photo that closed them) and work orders
become an evidence log. Nemotron lightning writes only the SUMMARY paragraph (two or three
sentences for the incoming shift), gpt-5 on any failure; each sentence must cite a known event
`[event:<id>]` or work order `[wo:<id>]`, unknown citations are removed and uncited sentences
dropped, and if nothing cited survives a plain count stands in. Every other section comes
straight from the record, never the model: NEEDS ATTENTION (open alerts, open and in-progress
work orders), WHAT CHANGED (change edges in time order, alerts and work orders resolved in the
window), ROUNDS (one line per wearer: photos, span, assets and places), NOTES FROM THE SHIFT
(`Handoff:` notes first) and QUIET. The last line names the model that wrote the summary. Posted
to Slack when `SLACK_WEBHOOK_URL` is set. Earlier versions let the model write the fact sections;
it invented a note, copied example text as facts, and misnumbered items, so the facts moved out
of its hands.

## Episodes (#6)

`perceive` schedules one `segment_job` row 12 s after a photo lands (one pending at a time); the
scheduled `segment` procedure recomputes the episodes of the whole record and writes the `episode`
table, which the console timeline and the MCP `get_timeline` tool read. The rule (`segmentEvents`
in `rules.ts`, shared with the agent's fallback): a new episode on a place change, a gap over
20 minutes, or an image-embedding jump between consecutive photos (cosine below 0.45). Episodes
are matched to existing rows by their first event, so ids are stable while a shift grows; new or
changed episodes get a title (at most 7 words) and a one-sentence summary from Nemotron lightning
in one batched call, gpt-5 on failure, and a plain "place, wearers" title if both fail.
`resegment(adminToken)` forces a full pass, for example after `reperceive`.

## Work orders and fires going out (#23)

`issue` is the work-order table, seeded from `demo/issues.csv` (`issue_id,title,asset_id,opened_by,
opened_at,status`; `opened_at` ISO or empty for three hours ago) by the seed script or
`upsert_issue`. In `perceive`, after the alert rule: a photo that involves an asset with an open
work order moves it to `in_progress`; a photo that shows the asset healthy again (a `CHANGES`
edge out of a fault state, `PSU2 FAULT -> PSU2 OK`) or carries a wearer note that says it was
fixed (`swapped`, `reset`, `back to normal`, ...) acknowledges the asset's open alerts, writes an
`alert_resolution` row (`alert_id, event_id, device_id, t_micros, how`:
`photo_shows_recovery | wearer_note | manual`) and resolves its work orders with the photo and the
note. Never from the photo that raised the finding. `ack_alert_with_evidence(alert_id, event_id)`
and `set_issue_status(issue_id, status, note, event_id)` do the same by hand. The handoff lists
open and in-progress work orders under NEEDS ATTENTION (cited as `[wo:<id>]`) and resolved ones
under WHAT CHANGED; the agent's `list_open_alerts` returns them too.

## Admin and UI reducers

| Name (HTTP) | Args | Notes |
|---|---|---|
| `upsert_asset` | token, asset_id, name, type, location, patterns[] | |
| `delete_asset` | token, asset_id | |
| `upsert_wearer` | token, device_id, name, role, shift | |
| `reperceive` | token, event_id | `""` re-runs every failed or stub-perceived event, oldest first, 8 s apart |
| `resegment` (procedure) | token | recompute and retitle episodes now |
| `slack_test` (procedure) | token | posts a test message |
| `ack_alert` | alert_id (u64) | for the web view |
| `ack_alert_with_evidence` | alert_id (u64), event_id | ack plus an `alert_resolution` row citing the photo |
| `upsert_issue` | token, issue_id, title, asset_id, opened_by, opened_at, status | seed a work order |
| `set_issue_status` | issue_id, status, note, event_id | open, in_progress or resolved by hand |
| `set_label`, `set_note` | event_id, value | |

After setting the keys, re-run the events that only got the stub:

```bash
curl -X POST https://maincloud.spacetimedb.com/v1/database/wm-physical/call/reperceive \
  -H 'Content-Type: application/json' -d '["<ADMIN_TOKEN>", ""]'
```

## Local testing

```bash
spacetime start                      # in another terminal
INGEST_TOKEN=test ADMIN_TOKEN=test NVIDIA_API_KEY=... AZURE_AI_KEY=... \
  spacetime publish wm-local --server local --yes
SPACETIME_HOST=http://127.0.0.1:3000 SPACETIME_DB_NAME=wm-local ADMIN_TOKEN=test node scripts/seed.mjs ../demo/assets.csv
spacetime sql wm-local --server local "SELECT event_id, status, summary FROM event"
```

Verified locally on 2026-11-07 with the real models: healthy panel → faulted panel → repeat photo
gives one alert on PDU A (`PSU2 status: OK → FAULT · temperature: 27C → 41C OVERTEMP · …`), the
repeat photo folds into it, a "DO NOT PROP DOOR OPEN" sign raises nothing, Nemotron 3–4.5 s warm
(9.5 s cold), and a broken Nemotron model ID falls back to gpt-4o in 6.1 s.
