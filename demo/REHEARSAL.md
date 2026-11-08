> **Draft** for Gary and Edward to edit (issue #11). Written 2026-11-07 against the repo as it stood that evening. `[VERIFY: …]` marks an item that depends on work still open; fill the run log as you go.

# Shift Memory — rehearsal plan

DESIGN.md §11 puts this on day 2 afternoon: "Five end-to-end rehearsals including the live beat. Backup recording." Each run is the full `DEMO_SCRIPT.md`, timed against its table, with the live beat included every time. Run 1 can happen as soon as the alert beat works end to end, before `ask` and `handoff` land, using the console fallbacks in the script; the later runs add beats as they ship. Record runs 3–5 and keep the best as the backup.

## Pre-flight checklist (before every run, and at T-60 on the day)

### Glasses
- [ ] Charged (aim for 50% or more; a day of shutter photos is untested, issue #10).
- [ ] Firmware updated in the Meta AI app. Developer Mode on (Meta AI app > Settings > App Info > tap the version number five times).
- [ ] Paired to the capture phone; the Meta AI app has granted our app the camera permission (registration flow).
- [ ] Hinges open. Closing them forces the session to STOPPED and reopening does not restart it.
- [ ] Real device selected, not MockDeviceKit.

### Phone and app
- [ ] Phone on cellular; uploads do not use the laptop or hotspot (CONTRACT.md).
- [ ] App open and in the foreground; auto-lock off; Do Not Disturb on.
- [ ] Settings: host `https://maincloud.spacetimedb.com`, database `wm-physical`, ingest token set (Keychain; the app shows whether a token is present, never the value).
- [ ] Wearer name and device id match the row in `demo/wearers.csv` that was seeded (otherwise the console and Slack show the raw device id).
- [ ] Glasses session started, standalone photo child started. Keep-in-background on (default).
- [ ] Blur faces on (default). Resolution `full`, quality `high` (defaults).
- [ ] Label and note fields empty. The label `PDU-A` is typed right before the alert photo and cleared after.
- [ ] Camera-roll import off during the talk so a sync burst does not hit the NVIDIA rate limit `[DECIDE: Edward]`.
- [ ] Test photo (anything but the fault panel) reaches `in graph`; note the seconds.

### Backend (Gary, from a logged-in laptop)
- [ ] `spacetime describe wm-physical env --server maincloud` lists `INGEST_TOKEN`, `NVIDIA_API_KEY`, `AZURE_AI_KEY`, `SLACK_WEBHOOK_URL` (values never in the repo).
- [ ] `slack_test` posted its check mark to the alerts channel (module README).
- [ ] Assets and wearers seeded: `ADMIN_TOKEN=… node module/scripts/seed.mjs demo/assets.csv demo/wearers.csv` with the real device ids in the CSV.
- [ ] `curl -X POST https://maincloud.spacetimedb.com/v1/database/wm-physical/call/ping -H 'Content-Type: application/json' -d '[]'` returns `serverT`.
- [ ] No event is `failed` or stub-perceived (`scene = 'unperceived'`); if any, run `reperceive` with `""` (module README) and wait for the 8 s-spaced retries.
- [ ] Every alert acknowledged (see Reset).

### Console laptop (the projector machine)
- [ ] `cd web && npm run dev` (or serve the built `dist/`); open the URL with `?db=wm-physical`. Header shows `wm-physical`, dot green, "live".
- [ ] Window set to "all time" for beats 1–3; "this shift (12 h)" is selected during beat 4.
- [ ] All wearer chips on, no asset filter (no tile highlighted), drawer closed.
- [ ] Theme decided for the projector (the console follows the OS light/dark setting); browser zoom set; Do Not Disturb on; power connected.
- [ ] Hotspot from a second phone tested as the fallback network.
- [ ] Slack alerts channel open in a second window, large text, sound on `[VERIFY: Gary — channel name]`.
- [ ] Claude Desktop connected to the MCP server; one warm-up question answered; conversation cleared `[VERIFY: Gary #9]`.

### Backup
- [ ] Backup recording file present on two machines (console laptop and Edward's Mac), opened once to confirm it plays, under 3 minutes.
- [ ] Open in a second tab or desktop on the console laptop, paused at 0:00.

## Run log

| Run | Date / time | Duration (target 3:30, stop 4:00) | What broke | Fix | Owner |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

Per run also note: seconds from shutter to `in graph` for the alert photo and the live photo; whether the alert landed on PDU-A (asset shown) or unattributed; Slack `slack_status`; which beats used a fallback; the event ids created (Provenance in the drawer shows the id).

## Reset between runs

1. **Acknowledge every alert** in "Needs attention". Reason: the module folds a new finding into any unacked alert on the same asset from the last 30 minutes and posts nothing new to Slack. An unacked rehearsal alert makes the next alert beat look dead.
2. **Decide which photos are demo data and which are rehearsal noise.** The day's real venue photos stay; they are the demo data. The rehearsal fault photos also stay: there is no delete reducer in the module, and republishing with `--delete-data` would wipe the day's photos too. Write the rehearsal event ids in the run log so nobody opens one by mistake during the talk, and keep the "this shift" window in mind when reading the handoff (it will list each rehearsal fault). If the clutter is unacceptable, options are a second database for rehearsals (`?db=…`) or a delete reducer; both are Gary's call `[DECIDE: Gary]`.
3. Clear the app's label and note fields. Confirm the session is still active (hinges open, app foregrounded).
4. Reload the console; reset Window to "all time", chips on, filter off, drawer closed.
5. Clear the Claude Desktop conversation `[VERIFY: Gary #9]`.
6. Check the alert row's `slack_status` is `posted` (console alert line, or Gary's `spacetime sql wm-physical "SELECT slack_status FROM alert"`); if not, fix the webhook before the next run.
7. Reset timers; the next run starts from beat 1 with the console in its beat-1 state.

## Backup recording procedure

Made from one of the good runs (3–5), on the console laptop, narrated live with the script. Under 3 minutes, so it can stand in for the whole talk if connectivity dies.

1. Console in a browser window at the projector resolution (1920×1080), theme and zoom as decided, Do Not Disturb on.
2. iPhone beside it: QuickTime Player > File > New Movie Recording, choose the iPhone as the camera (USB cable) to mirror the phone screen; or the macOS iPhone Mirroring window. Size it to a third of the screen next to the console. Both must be visible in one capture.
3. QuickTime Player > File > New Screen Recording, record the full screen with the built-in microphone, start narrating from beat 1.
4. Run beats 2–6 for real: the live capture, the alert arriving in the console and in the Slack window, the handoff, the supervisor questions (Claude Desktop if connected, else the console fallback), the live photo. Finish with the close.
5. Stop; Edit > Trim to under 3:00; export 1080p (File > Export As > 1080p). Name it `shift-memory-backup-YYYY-MM-DD.mov`.
6. Store on two machines: `~/Desktop/shift-memory-demo/` on the console laptop and the same folder on Edward's Mac via AirDrop; optionally a copy on the phone. Not in the git repo (large binary) `[DECIDE: Gary + Edward]`.
7. Play it back once on the projector laptop to confirm audio and legibility; note the timestamps of the alert segment and the supervisor segment in the file name's sidecar note, so they can be jumped to mid-talk.

## Day-of timeline

| T | Who | Do |
|---|---|---|
| T-60 | Both | Pre-flight checklist top to bottom. Glasses and phone on chargers until T-20. |
| T-55 | Gary | `describe env`, `slack_test`, `ping`, seed check, `reperceive ""` if anything is failed; acknowledge all alerts. |
| T-45 | Gary | Console laptop at the stage: projector test, theme, zoom, hotspot tested, Slack window placed. |
| T-40 | Edward | Session started; one test photo of the room reaches `in graph`; note the seconds. Diagnostics screen checked for the capture-to-bytes time. |
| T-30 | Gary | Claude Desktop warm-up question, then clear the conversation `[VERIFY #9]`. Acknowledge any alert the test photo raised. |
| T-20 | Both | Backup recording opened in a second tab, paused at 0:00. Props on the table: fault print face down on top of the OK print, laptop copy of the fault image ready. |
| T-15 | Edward | Phone: Do Not Disturb, auto-lock off, cellular confirmed, hotspot joined as the second path, battery noted. Label and note fields empty. |
| T-10 | Gary | `ping`; acknowledge every alert; console reset to beat-1 state (all time, chips on, no filter, drawer closed). |
| T-5 | Both | Positions. Glasses on and open. Edward types `PDU-A` into the label field when the previous team is wrapping up, not before. |
| T-1 | Gary | `ping` once more; look at the dot: green. |
| T-0 | Gary | Beat 1. |
| T+4 | Both | Done. Leave the console on the live card for questions; clear the label field. |
