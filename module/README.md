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
3. Graph: `EVIDENCED_BY`, `NEXT`, `INVOLVES` (label → subject, registry assets read in the scene →
   asset, object names → target, location → setting), `CHANGES`, and `SIMILAR_TO` (top 3 earlier
   events with cosine ≥ 0.85).
4. Alert rule: fault words in `text_in_scene` (FAULT, FAIL, ALARM, CRITICAL, OVERTEMP, OVERLOAD,
   DEGRADED, TRIPPED, LEAK, OFFLINE, DOWN, ERROR), a change from a healthy value into one, or a
   `high`-severity anomaly. Findings are grouped into **one alert per asset**. While that alert is
   unacked (30 min window), later findings on the same asset are appended to it instead of
   posting again.
5. New alerts post to Slack through `SLACK_WEBHOOK_URL`; the result is in `alert.slack_status`.

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

## Admin and UI reducers

| Name (HTTP) | Args | Notes |
|---|---|---|
| `upsert_asset` | token, asset_id, name, type, location, patterns[] | |
| `delete_asset` | token, asset_id | |
| `upsert_wearer` | token, device_id, name, role, shift | |
| `reperceive` | token, event_id | `""` re-runs every failed or stub-perceived event, oldest first, 8 s apart |
| `slack_test` (procedure) | token | posts a test message |
| `ack_alert` | alert_id (u64) | for the web view |
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
