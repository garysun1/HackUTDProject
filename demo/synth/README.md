# Synthetic wearable-camera datasets

Photoreal sample shifts for demos beyond the venue: the NMC² data center plus four other
enterprise floors, to show the same memory working anywhere work is physical. **Every image
here is AI-generated.** Event ids start with `synth-` and the manifest says `"synthetic": true`;
keep them out of the real capture database and say so when showing them.

| Scenario | Shots | Alert beat |
|---|---|---|
| `nmc2-datacenter` | 9 | PDU-A `PSU2 OK` → `PSU2 FAULT` (true before/after edit) |
| `manufacturing-line` | 5 | CNC-07 `RUNNING` → `ALARM 1012 SPINDLE OVERTEMP` |
| `hospital-biomed` | 5 | Blood bank fridge BBR-2 `4.1C` → `ALARM 8.9C HIGH TEMP` |
| `utility-substation` | 4 | Breaker CB-12 `CLOSED` → `TRIPPED` |
| `warehouse-dc` | 5 | Racking upright bent by a forklift (anomaly, no status text) |

Images are in `out/<scenario>/`; `manifest.json` records prompt, model, seed, and the check.

## How it works

1. `scenarios/<id>.json`: wearers, an asset registry, and shots in shift order. Each shot has
   a prompt, the labels that must be readable (`read`), and optionally a `pair` + `edit`.
2. `generate.mjs`: FLUX.2-pro (deployed on the Azure resource as `flux-2-pro`) generates each
   shot. The second shot of a pair is an **edit of the first photo**, so only the state changes.
   `finish.mjs` applies a wearable-camera finish (1600 px, softness, white-balance cast, sensor
   noise, vignette, q82 JPEG). Nemotron VL then reads the image back; a shot is kept only if
   every `read` label is legible and no face is visible, else it retries with a new seed.
3. `replay.mjs`: seeds the scenario's assets and wearers, then sends the shots through
   `ingest_photo` in order, exactly like the phone.

## Run

```bash
cd demo/synth && npm install
# generate (skips shots that already passed; --force to redo)
AZURE_AI_KEY=... NVIDIA_API_KEY=... node generate.mjs nmc2-datacenter
# or with an Azure CLI login instead of a key:
AZURE_BEARER=$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv) \
  NVIDIA_API_KEY=... node generate.mjs
# replay into a separate database (ingest is idempotent on event_id)
INGEST_TOKEN=... ADMIN_TOKEN=... node replay.mjs nmc2-datacenter --db wm-demo --gap 10
```

`--provider nvidia` uses FLUX.1-dev on NVIDIA's API instead (no editing; pairs share a seed).
Prompts must not name the glasses brand: the image services return `CONTENT_FILTERED`.

Verified 2026-11-07: 28/28 shots pass the label check; replaying `nmc2-datacenter` into a local
module gives 9/9 events in the graph and exactly one alert, on PDU A, attributed to the wearer.

Note: the timeline is ordered by server receive time, so a replay compresses the shift into
the replay's duration; `client_t` carries the scenario's clock (e.g. 22:00–22:56).
