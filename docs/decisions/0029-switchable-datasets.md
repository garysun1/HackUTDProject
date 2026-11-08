# 0029 switchable demo datasets, one database each, switched from the database

- Date: 2026-11-08
- Status: active
- Source: Gary, chat

**Decision.** The demo can show the real capture or any of the five synthetic enterprise floors,
and the switch is a value in the database, not a control in the UI. Each dataset is its own
Maincloud database running the same module: `wm-physical` (real: our photos, Edward's walk),
`wm-nmc2` (data center night shift), `wm-plant` (automotive plant), `wm-hospital` (biomed
rounds), `wm-substation` (utility substation), `wm-warehouse` (distribution center). The
directory database `wm-physical` holds a `demo_config` table; the row `active_dataset` names the
database the console and the MCP server read. The console subscribes to that row and swaps its
data connection live when it changes; the MCP server re-reads it every ten seconds. `?db=` in the
console URL, or `SPACETIME_DB_NAME` for the MCP server, pins one database and ignores the switch.
Switch with `module/scripts/dataset.mjs <name>` (admin token), which calls the `set_config`
reducer; no redeploy, no reload.

**Reason.** Separate databases give full isolation for free: entities, registry, alerts and
perception context never mix between a real rack and a synthetic one, and the synthetic sets can
be rebuilt without touching the real capture. A single switch value keeps the stage simple: one
command flips every screen, and nothing in the UI hints that the data is selectable.

**Synthetic location.** Replaying a scenario places its photos on a deterministic synthetic walk
around a plausible site for that industry (coordinates marked `synthetic` in the scenario file)
and uploads a matching shift track through `ingest_track`, so the map works for every dataset.
Those positions are illustrative, not where any image was made.

**Keys.** Each dataset database carries the same ingest token and model keys, copied through the
CLI at creation; `spacetime env` is the only place they live.
