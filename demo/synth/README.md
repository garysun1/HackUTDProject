# Synthetic wearable-camera datasets

Photoreal sample shifts for demos beyond the venue: the NMC² data center plus four other
enterprise floors, to show the same memory working anywhere work is physical. **Every image
here is AI-generated.** Event ids start with `synth-` and the manifest says `"synthetic": true`;
keep them out of the real capture database and say so when showing them.

| Scenario | Shots | Site (3D map) | The day |
|---|---|---|---|
| `nmc2-datacenter` | 10 | random walk (0029) | PDU-A `PSU2 OK` → `PSU2 FAULT` → swapped, `OK` |
| `manufacturing-line` | 14 | Arlington Assembly Plant | CNC-07 spindle overtemp → kinked coolant hose → spare from the crib → running; HP-2 leak and CV-3 lockout left for third shift |
| `hospital-biomed` | 15 | Mercy General Hospital (2 floors) | BBR-2 fridge alarm → units to BBR-1 → torn gasket replaced → 4.0C; pump 10442 fails its test, tagged out |
| `utility-substation` | 15 | Northlake Substation | CB-12 trips → relay target → scorched insulator → guards fitted, CB-12 closed; T2 oil low left open |
| `warehouse-dc` | 15 | DFW Distribution Center | Aisle 22 upright hit by FL-12 → taped, red-tagged → upright replaced; FZ-1 evaporator iced, contractor tomorrow |

The four non-nmc2 scenarios each run a 6–7 hour shift with two wearers. Every shot names the
`room` it was taken in, on a generated floor plan (decision 0032).

Images are in `out/<scenario>/`; `manifest.json` records prompt, model, seed, and the check.

## How it works

1. `scenarios/<id>.json`: wearers, an asset registry, and shots in shift order. Each shot has
   a prompt, the labels that must be readable (`read`), and optionally a `pair` + `edit`.
2. `generate.mjs`: FLUX.2-pro (deployed on the Azure resource as `flux-2-pro`) generates each
   shot. The second shot of a pair is an **edit of the first photo**, so only the state changes.
   `finish.mjs` applies a wearable-camera finish (1600 px, softness, white-balance cast, sensor
   noise, vignette, q82 JPEG). Nemotron VL then reads the image back; a shot is kept only if
   every `read` label is legible and no face is visible, else it retries with a new seed.
3. `sites.mjs`: writes the generated floor plans (`web/src/site3d/data/sites/<id>.json`, also
   copied for the standalone `site3d` app) that the 3D map draws and the walks follow. Re-run it
   after changing a plan.
4. `replay.mjs`: seeds the scenario's assets, wearers and pre-existing work orders, then sends
   the shots through `ingest_photo` in order, exactly like the phone.
   - **Work orders with `opened_t`** are opened when the replay reaches that minute.
   - **Scenarios with `site.scene`:** each photo gets a fix inside its `room`, and every wearer's
     walk between rooms (`walk.mjs`: corridors, lifts, walking pace) goes up through
     `ingest_track` after each photo.
   - **`--dry out.json`** prints the plan and writes the positions without calling anything.

## Run

```bash
cd demo/synth && npm install
# generate (skips shots that already passed; --force to redo)
AZURE_AI_KEY=... NVIDIA_API_KEY=... node generate.mjs nmc2-datacenter
# cloud agent sessions (keys proxy-injected on the openai.azure.com host of the same resource):
AZURE_AI_FOUNDRY_ENDPOINT=https://hackutd-wm-garysun.openai.azure.com AZURE_AI_KEY=proxy-injected \
  NVIDIA_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 node generate.mjs warehouse-dc
# or with an Azure CLI login instead of a key:
AZURE_BEARER=$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv) \
  NVIDIA_API_KEY=... node generate.mjs
# replay into a separate database (ingest is idempotent on event_id)
INGEST_TOKEN=... ADMIN_TOKEN=... node replay.mjs nmc2-datacenter --db wm-demo --gap 10
```

`--provider nvidia` uses FLUX.1-dev on NVIDIA's API instead (no editing; pairs share a seed).
Prompts must not name the glasses brand: the image services return `CONTENT_FILTERED`.

Shots that already passed are kept. The later shot of a pair is edited from the earlier photo.

Verified 2026-11-07: 28/28 shots pass the label check; replaying `nmc2-datacenter` into a local
module gives 9/9 events in the graph and exactly one alert, on PDU A, attributed to the wearer.

Note: the timeline is ordered by server receive time, so a replay compresses the shift into
the replay's duration; `client_t` carries the scenario's clock (e.g. 22:00–22:56).
