> **Draft** for Gary and Edward to edit (issue #11). Written 2026-11-07 against the repo as it stood that evening. `[VERIFY: …]` marks a claim to confirm before the talk; "when #N lands" marks a beat whose backend piece is still an open issue. Nothing below claims a behavior the repo does not show.

# Shift Memory — demo script

**Length.** 3:30 target, 4:00 hard stop. The timing table is the contract; rehearse against it.

**Frame.** A data center floor across a shift change. The hackathon venue stands in for the floor; printed rack and PDU plates stand in for equipment. The day's real photos are the demo data (CLAUDE.md), so capture starts in the first hour.

**Roles.** Edward wears the glasses, carries the phone, and takes every photo. Gary drives the console, Slack, and Claude Desktop, and does most of the talking. Stand so the judges see the glasses and the projector at once.

**Rule for the whole talk.** Say what the screen shows, then point at the photo behind it. Never claim something the screen is not showing.

---

## 0. Setup (done before the talk)

### What was captured earlier in the day

- From the first hour, the "floor" as it is walked: tables as rows, the printed `RACK R12` and `PDU-A` plates, cable work at the team table, a conversation (people are counted, never identified), a snack run. Shutter button, glasses worn normally, source `shutter_button` (or `camera_roll` if the shutter path needs the app in the foreground, issue #10).
- The **OK panel** (`capture-app/ShiftMemory/Resources/Fixtures/rack-panel-ok.jpg`, printed) photographed once in the morning, so the fault on stage is a change from a known good state and the timeline has a "before".
- One deliberate asset change (DESIGN.md §10 step 1): a plate moved to another table or a cable re-routed, photographed before and after, with a typed label on the "after" photo so the `CHANGES` line names the asset.
- Two wearers if both pairs of glasses work. Per `demo/wearers.csv` Gary is Day shift and Edward is Night shift; the handoff is Day to Night. With one pair, Edward's device captures everything and the story is "the night shift's own record, read by the people who were not there". `[DECIDE: Gary + Edward]`
- Registry seeded. `demo/assets.csv` lists PDU-A, PDU-B, R12, R13, SW-CORE-1, CRAC-2, UPS-1. `module/README.md` says to replace these with the labels actually photographed at the venue; print a plate for each asset you keep so the floor schematic has tiles to draw. Seed with `ADMIN_TOKEN=… node module/scripts/seed.mjs demo/assets.csv demo/wearers.csv` after the `REPLACE-WITH-…` device ids are filled in from each phone's Settings screen.
- Every alert acknowledged before walking on (REHEARSAL.md, "Reset between runs"). The module folds a new finding into any unacked alert on the same asset from the last 30 minutes and posts nothing to Slack, so a leftover rehearsal alert silently kills the alert beat.

### Props and screens

| Item | Why |
|---|---|
| Printed `rack-panel-fault.jpg`, letter size, matte paper | The alert prop. Paper beats a laptop screen: no glare, no moiré, no notifications. Keep the file open on a laptop as the backup prop. |
| Printed `rack-panel-ok.jpg` | Photographed in the morning. Face down on the table during the talk. |
| Projector laptop | Console from `web/` (`npm run dev`, or the built `dist/`) with `?db=wm-physical` in the URL, connection dot green. Slack alerts channel in a second window `[VERIFY: Gary — channel name; it is whatever SLACK_WEBHOOK_URL posts to]`. Claude Desktop connected to the MCP server `[VERIFY: Gary #9]`. |
| Phone on cellular | App open and in the foreground, glasses session started, keep-in-background on, ingest token set, label field empty until the alert beat. |
| Backup recording | Open in a second tab or desktop, paused at 0:00 (REHEARSAL.md has the procedure). |

---

## Timing table

| # | Beat | Who | Start | Length | Ends |
|---|---|---|---|---|---|
| 1 | Open: the product in two sentences, then the application | Gary | 0:00 | 0:25 | 0:25 |
| 2 | Console tour: timeline, floor schematic, wearer chips | Gary | 0:25 | 0:30 | 0:55 |
| 3 | **Alert**: photograph the fault panel; alert in console and Slack | Edward captures, Gary narrates | 0:55 | 0:45 | 1:40 |
| 4 | **Handoff**: the shift ends; the handoff writes itself | Gary | 1:40 | 0:35 | 2:15 |
| 5 | **Supervisor**: three questions from Claude over MCP | Gary | 2:15 | 0:45 | 3:00 |
| 6 | **Live**: a photo on stage appears in seconds; ask about it | Edward captures, Gary asks | 3:00 | 0:30 | 3:30 |
| 7 | Close: governance, three tracks in one sentence | Edward, then Gary | 3:30 | 0:20 | 3:50 |

If beat 3 runs long (a retake), drop the second supervisor question. If beat 5 is unavailable, the fallback below fits the same 45 seconds.

---

## Beat 1 — Open (Gary, 0:00–0:25)

**Say.** "Enterprise AI can search documents, tickets, and chat. It cannot see the floor. We built enterprise operational memory for physical work, the missing modality in enterprise knowledge. Today we show it as one application: a data center shift change. Edward is on shift, wearing Meta Ray-Ban glasses. One photo per thing he does, nothing passive. Every photo becomes an event that the next shift, a supervisor, or an agent can ask about."

**On screen.** The console, already live, with today's photos in the timeline.

**Action.** None. Edward stands up, glasses on, phone in hand.

**Expect.** Nothing has to happen yet. This is the only time the general product is named; the rest of the talk is the application.

**If it fails.** Nothing can fail here. If the console is not connected (red dot, "Connection error" band), Gary says "the venue Wi-Fi is fighting us" and switches the laptop to the hotspot while talking; the beat is 25 seconds of speech.

## Beat 2 — Console tour (Gary, 0:25–0:55)

**Say.** "This is Shift Memory, the floor's live memory. Left, the timeline: every photo from today, who took it, when, and what the model read in it. Middle, the floor: places as zones, assets as tiles, each mark one photo, and the line is Edward's path. Right: what needs attention, the handoff, and questions. Nothing here was typed by a person."

**On screen.** Timeline column, floor schematic, rail. Wearer chips in the header, one per device that has sent a photo; with two wearers, toggle one off and on to show attribution.

**Action.** Click one morning card: the drawer opens with the photo, Summary, Status `in graph`, Place, Assets, People count, and under "Text read" the strings the model read off the plate. Click Close. If there are two wearers, click Gary's chip off and back on.

**Expect.** Thumbnails load lazily over the SQL endpoint, so a cold page takes a second or two to fill with images. The schematic draws zones from `location_guess`, so the zone names are whatever the model called the venue rooms.

**If it fails.** If the drawer photo is blank, the SQL fetch is slow: talk over it and move on, the next card will be cached. If the schematic is empty but the timeline is not, no event has a place or a registry asset yet: skip the middle column and say "the schematic fills as assets are read".

## Beat 3 — ALERT (Edward captures, Gary narrates, 0:55–1:40)

**Say (Edward).** "I'm on rounds. Rack 12." Hold the printed fault panel at arm's length, plate filling the frame, steady for a second.

**Say (Gary, while the phone uploads).** "The photo is in the database in under a second. Perception runs inside the database module: Nemotron reads the panel, the rule checks what it read."

**Say (Gary, when the alert lands).** "PSU2 fault, on PDU A in rack 12, seen by Edward, with the photo. And it is already in the channel the shift lead watches. Nobody typed anything."

**On screen.** Console (projector). Slack alerts channel visible beside it or on a second screen. The phone screen does not need to be seen; the glasses do.

**Action.**
1. Before this beat, Edward typed `PDU-A` in the app's label field so the alert attaches to the asset. The fixture shows three registry assets (R12, PDU-A, SW-CORE-1); the module attributes an alert to the one asset in view, else to an asset named in the fault text, else to the wearer's label. Without the label the alert is still raised and posted, but shows no asset and no red tile. `[VERIFY in rehearsal run 1: the fault text alone fires the rule; the label makes it land on PDU-A]`
2. Edward taps Capture in the app (`sdk_capture`) or presses the glasses' shutter button (`shutter_button`, same listener). One press. Never two: the toolkit allows one capture in flight.
3. Gary watches the timeline. Edward clears the label field afterwards.

**Expect, in order, with timing.**
- Phone: `processing` → `uploading` → `accepted` (ingest returns in well under a second) → `in graph`.
- Console: a new card slides in at the top with "reading the photo…", halo breathes once. 6–10 s later (Nemotron VL measured at 4.7 s in the bake-off, plus the Azure Vision embedding) the card shows the summary and the status chip reads `in graph`. Target under 15 s from upload to `in graph`; the gpt-4o fallback path (triggered by a 429, a timeout, or bad JSON) adds up to 25 s more and will miss the target.
- "Needs attention": one line, `PSU2 FAULT · HH:MM · PDU A (Rack R12) · Edward · fault text`, red icon, Acknowledge button. The PDU-A tile gets a red border and halo on the schematic. If the model also reported the change from the morning photo, the kind reads `state change` and the text includes `OK → FAULT`.
- Slack, within a second of the alert row: `:rotating_light: *FAULT* — PDU A (Rack R12) · Row 1 / Rack R12`, then `> PSU2 FAULT`, then `Seen by Edward at HH:MM CT · event …`. ("STATE CHANGE" instead of "FAULT" if the change rule fired first.)
- Capture-to-bytes on the glasses is not yet measured (issue #10). Budget 2–5 s for it until the Diagnostics screen says otherwise.

**If it fails.**
- No card after 10 s: the phone is still uploading (cellular). Gary keeps narrating the pipeline ("the phone resizes to 1600 pixels, blurs faces, and posts to the module"); Edward checks the phone shows `uploading`, not `queued`.
- Card arrives, no summary after 25 s: the model call is slow or fell back. Gary opens the card; the drawer shows Status `accepted`. Say "perception is still running; let's look at the handoff and come back", go to beat 4, and glance back when the chip turns `in graph`.
- Card shows `failed` ("could not read this photo"): both models failed. Gary runs `reperceive` for that event id from the laptop (module README) and moves on; the retry lands during beat 4.
- Summary arrives but no alert: the model did not read `FAULT`. Gary opens the drawer, points at "Text read", says "the rule needs the word; let's retake", Edward retakes once with the plate closer. Second miss: play the alert segment of the backup recording (REHEARSAL.md) and continue.
- Alert in console, nothing in Slack: `slack_status` on the alert row says why (`http_<code>`, `error`, `no_webhook`). Say "the console is the source of truth; the channel post is a mirror", continue.
- Alert text appended to an older alert, count unchanged, no Slack post: a rehearsal alert on PDU-A was never acknowledged. Acknowledge it now and retake.
- Glasses dead or session stopped: Edward uses the phone camera and the app's camera-roll import if that control shipped `[VERIFY: Edward #2]`, else Gary posts the fixture from the laptop with the fallback script in REHEARSAL.md. The console and Slack behave identically.

## Beat 4 — HANDOFF (Gary, 1:40–2:15)

**Say.** "Edward's shift ends. The next operator should not need Edward in the room. Here is the handoff: what needs attention, what changed, where people were, the notes they left. Every line cites a photo. Click it and there is the evidence."

**On screen.** Set Window to "this shift (12 h)". The Handoff panel in the rail.

**Action.** Point down the sections: "Needs attention" (the PSU2 fault), "What changed" (the deliberate asset change from the day, and `OK → FAULT` if the model reported it), "Where people were" (places with photo counts and time spans), "Notes left by the shift", "Uncertain" (low-confidence reads, if any). Click one cite button (time + wearer) to open its photo. When #8 lands: press **Generate** → "Writing…" → a Nemotron narrative appears above the facts, and the module posts the same handoff to the alerts channel `[VERIFY: Gary #8 — the Slack post for handoffs is in DESIGN §5, not in the module yet]`.

**Expect.** The facts are derived from the graph in the browser and are always present. Today the Generate button is disabled with the tooltip "Narrative generation not deployed yet" and the panel says the written summary is not enabled; that line disappears when the `handoff` procedure exists in the schema (the page checks).

**If it fails.** Generate errors: the panel prints "The summary could not be written right now. The facts below are still current." Read the facts instead; the beat loses nothing visible. If the window filter hides everything (wrong Window or a wearer chip off), the timeline empty state names the cause and offers "Show everything"; click it.

## Beat 5 — SUPERVISOR (Gary, 2:15–3:00)

**Say.** "Now someone who was never on the floor. This is Claude Desktop, talking to our memory over MCP, the same way any agent the company already runs would." Ask each question aloud as you type it.

**On screen.** Claude Desktop, large font, connected to the MCP server `[when #7 ask and #9 MCP land; VERIFY: Gary]`. The console stays visible on the other half of the screen so the cited photos can be opened.

**Action and expected answers.**
1. "What happened to PDU-A today?" → the agent calls `what_changed` / `search_memory`; the answer lists the morning OK reading and the PSU2 fault, each with time, wearer, and a photo link. Gary opens one photo.
2. "Who was last at rack R12?" → `find_object` / `get_timeline`; "Edward at HH:MM" with the photo. Point at the wearer chip color on the console card.
3. "What changed since the morning shift?" → `what_changed` over the shift window; the deliberate asset change and the fault, each cited.

**Say (after the third answer).** "Every answer cites the photo, the time, and the person. No photo, no claim. That is the whole point of a memory you can trust."

**Expect.** One tool round trip per question is a few seconds; Nemotron Lightning is the agent model (`nvidia/nemotron-3.5-lightning-30b-a3b`, reasoning off). Budget 10–12 s per question including reading the answer aloud.

**If it fails, or until #7 and #9 land: the same three questions from the console (fits the same 45 s).**
1. Click the **PDU-A tile** on the schematic: the timeline filters to events involving PDU-A: the morning OK photo and the fault photo, each with time, wearer, and summary. Open the latest one.
2. Click the **R12 tile**: the top card is the last visit, with the wearer dot and name. Open it.
3. Window "this shift (12 h)" and read the Handoff's **What changed** list; click a cite.
Gary says the same closing line. Click the active tile again to clear the filter before beat 6.
If Claude Desktop hangs mid-question, switch to the console fallback for the remaining questions rather than waiting.

## Beat 6 — LIVE (Edward captures, Gary asks, 3:00–3:30)

**Say (Edward).** "And right now." Photograph something in the room that was not staged: the judges' table, the projector cable, a laptop. Not the fault panel (that alert is already open, and the module would fold the finding into it). Not a close-up of a face; faces are blurred on the phone before upload anyway, which is worth saying.

**Say (Gary).** "Taken two seconds ago. Here it comes." When the summary fills: "Ask it." When #7 lands, type in Ask the floor: "What did Edward just photograph?" and read the answer with its citation. Until then, open the card and read Summary and "Text read" aloud.

**On screen.** Console, timeline top. The new card slides in, the floor schematic gets a new mark at the "now" edge of its time axis.

**Action.** One capture, label field empty. Gary clicks the card as soon as the chip reads `in graph`.

**Expect.** Card within 2–3 s of the bytes arriving on the phone; summary 6–10 s after that. The Ask panel today prints "Questions are not enabled on this floor yet" if the `ask` procedure is absent; do not type a question unless #7 is deployed.

**If it fails.** Slow: Edward starts the close while the card fills, and Gary opens it when it does. Failed: Gary says "the photo is stored; perception retries", runs `reperceive` later, and the close continues. Capture itself fails (toolkit 30 s silence timeout, or startup failure): press once more; if the second attempt fails, skip the live photo and point at the alert photo's timestamp as "the live beat you already saw".

## Beat 7 — Close (Edward, then Gary, 3:30–3:50)

**Say (Edward).** "What you did not see matters. Capture is deliberate: one photo per event, nothing passive, no audio. Faces are blurred on the phone before anything is uploaded. People are counted, never identified. Every claim traces to a photo, a time, and a wearer. Retention is a setting. Today it runs on Maincloud; a customer who needs the data to stay in the building runs the same module on their own SpacetimeDB."

**Say (Gary).** "Nemotron reads every photo and answers every question `[VERIFY: 'answers' when #7 lands; until then say 'reads every photo and writes the handoff' only if #8 landed, else 'reads every photo']`, one Spacetime module is the entire backend, and the first customer is a data center shift that never loses what it saw. That is the NVIDIA, Spacetime, and NMC² tracks in one build. Thank you."

**On screen.** The console with the live card open.

---

## Things that can go wrong on stage

| Risk | What you will see | Mitigation |
|---|---|---|
| Venue Wi-Fi drops or throttles | Console dot amber/red, band "Reconnecting · showing data as of HH:MM"; Slack and Claude Desktop stall | Laptop on a hotspot from a second phone (not the capture phone), tested at T-15. Reload the page if it does not reconnect on its own. Backup recording open in another tab. |
| Phone cellular weak | App stuck at `queued`/`uploading`; retries with backoff (queue holds about the last 50) | Edward stands near the aisle or a window; join the hotspot Wi-Fi as a second path. `event_id` makes retries idempotent, so a late duplicate is harmless. |
| Maincloud free tier auto-paused | First call after idle is slower (docs say resume under a second) | Keep the console connected (live WebSocket); the app pings before the beat; Gary hits `ping` from the laptop at T-10 and T-1. |
| NVIDIA rate limit (about 40 requests/min per model) or Azure 429 | Perception falls back to gpt-4o (slower) or the event ends `failed` | No bulk camera-roll import in the hour before the talk; `reperceive` spaces retries 8 s apart; one photo per beat. |
| Glasses session stops when the hinges close | App shows the session stopped; capture does nothing | Never fold the glasses on stage; wear them or lay them open. Restart the session in the app (registration persists); if startup fails, retry once with a fresh camera setup, then use shutter-button or camera-roll. |
| Beta photo capture: 30 s silence timeout, startup failure | Capture spinner, then a failure | One capture in flight, ever. Retry once. Shutter button is the same listener; camera-roll import is the fallback path. |
| Leftover unacked alert on PDU-A | New finding appended to the old alert; no new Slack post; count unchanged | Acknowledge every alert before walking on (T-10) and after every rehearsal run. |
| Model misreads the plate | Summary arrives, no alert, "Text read" lacks `FAULT` | Plate fills the frame, held steady, matte print, room light on it. Retake once. Then backup recording. |
| Slack webhook fails | Alert in console, `slack_status` `http_…` or `error` | Say the console is the source; continue. Gary checks `slack_test` at T-60. |
| Projector contrast | Hairlines and 12px metadata vanish | Decide light vs dark theme in rehearsal (the console follows the OS setting); browser zoom 125–150%; Do Not Disturb on. |
| Claude Desktop or MCP server not connected | No tools listed, or a hang | Console fallback for beat 5 (above). Warm up Claude Desktop with one question at T-20 `[VERIFY: Gary #9]`. |
| Phone auto-locks or app backgrounded | Session kept alive by keep-in-background, but the capture button is off screen | Auto-lock off, Do Not Disturb on, app in the foreground the whole talk. |
| Battery | Glasses or phone die mid-demo | Both charged at T-60; cable and battery pack on the table. |

---

## Appendix — what the repo does today vs. what the script assumes

| Piece | State on 2026-11-07 | Script handling |
|---|---|---|
| `ingest_photo`, scheduled `perceive`, Nemotron VL → gpt-4o fallback, Azure Vision embeddings, graph edges, asset matching, alert rule, Slack post, wearer attribution | Built, in `module/spacetimedb/src/index.ts` | Beats 2, 3, 6 as written |
| Console: live subscriptions, timeline, floor schematic, wearer chips, alerts with Acknowledge, handoff facts, event drawer with provenance | Built, in `web/` (issue #12 closed) | Beats 2–4 and the beat 5 fallback as written |
| Capture app: standalone capture, shutter listener, 1600 px resize, on-device face blur, upload with retry, status polling, label/note | Contracts in the repo; UI, model, and glasses controller being built in parallel (issue #1 open) | Beats 3 and 6; phone-side labels in this script come from `CaptureEvent.EventStage` |
| `segment` / episodes (#6) | Open; `episode` table exists and is empty | Timeline is a flat list; the script never says "episodes" |
| `ask` Nemotron tool loop (#7) | Open; the console hides questions until the procedure exists | Beat 5 and beat 6 "ask" have console fallbacks |
| `handoff` procedure and its Slack post (#8) | Open; Generate is disabled until the procedure exists | Beat 4 reads the facts; narrative "when #8 lands" |
| MCP server and Claude Desktop config (#9) | Closed on GitHub, but no `mcp/` directory in this checkout | `[VERIFY: Gary]` everywhere beat 5 depends on it |
| Fixtures replay, shift-hour (#4) | Open; `demo/fixtures/` is empty | Rehearsal uses the day's real photos and the two panel fixtures |
| Real-glasses measurements (#10) | Open | Capture-to-bytes budgeted at 2–5 s until measured |
