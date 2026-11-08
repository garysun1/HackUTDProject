# Real-glasses measurements (issue #10)

The protocol for the five numbers only real Ray-Ban Meta glasses can give us. Run it in order:
measurement 1 decides the capture architecture, so it goes first and gets its own `#log` post.

## Purpose

Issue #10 asks: do shutter-button photos reach the app while it is backgrounded; then
capture-to-bytes latency at full/high, HEIC vs JPEG, startup failure rate, and battery over a day
of button photos. `docs/DESIGN.md` §4 carries the first as open question T7, `docs/CONTRACT.md`
"Open points for Edward" 2–3 wait on it and on the image format, and §14 risks 2–3 are the same
facts. The app measures everything itself (`DiagnosticsStore`: one row per capture plus session
counters and battery samples); this page says what to do with the glasses and where each number
shows up. Nothing is uploaded; the numbers leave the phone as the CSV you attach in Slack.

## Setup (5 min)

1. **Developer Mode** in the Meta AI app: Settings > App Info > tap the version number five times.
2. **Connect** in Shift Memory (Meta AI opens for the camera permission and comes back), then
   **Start shift** and wait for the "session active" pill.
3. **Settings**: Keep session in background **ON**. Camera-roll import **OFF** while you test (it
   would mask measurement 1). Capture resolution/quality as each measurement says.
4. **Diagnostics** is its own screen in the app: the summary card on top, one row per capture below
   (newest first). **Reset** once now so today's numbers stand alone. **Export CSV** / **Export JSON**
   open the share sheet: AirDrop to the laptop or Save to Files. CSV times are UTC (`Z`); the
   venue is UTC−6.

## 1. Shutter-button delivery while backgrounded (the decision test, 5 min)

**Steps.** Start shift. Take one shutter photo with the app in front and check its row says
`appStateAtArrival = active`. Press the home button, then lock the phone. Over 2 minutes take 5
shutter photos (the button on the right temple), spaced out. Unlock, open the app, open Diagnostics
and the event list.

**Record.** For each of the 5: did a row appear at all, its `appStateAtArrival` (`background`,
`inactive`, `active`), and how far it got (`accepted`, `in_graph`; check the web console too). If
rows appear only after you foreground the app, their `bytesAt` is the unlock time, not the press.

**Where.** Summary: shutter photos backgrounded / foreground. Rows and CSV: `appStateAtArrival`,
`bytesAt`, `acceptedAt`, `inGraphAt`.

| Photo | Pressed at | Row? | appStateAtArrival | Reached | Notes |
|---|---|---|---|---|---|
| 0 (app in front) | 18:50:48 CST | yes `b640d072` | active | in_graph 18:51:43 | bytes 18:51:37 (48.0 s, full/high, 1.03 MB HEIC) |
| 1 | 18:51:45 | yes `62cb95ad` | background | in_graph 18:52:33 | bytes 18:52:28 (41.7 s); phone locked since 18:51:41 |
| 2 | 18:52:35 | yes `c464866e` | background | in_graph 18:53:22 | bytes 18:53:17 (40.9 s) |
| 3 | 18:53:18 | yes `67619eb8` | background | in_graph 18:54:02 | bytes 18:53:57 (38.1 s) |
| 4 | 18:53:53 | **no** | — | — | pressed while photo 3 was still transferring; one capture in flight, press dropped (now queued instead, commit after `9266b9f`) |
| 5 | 18:53:57 | yes `fd70df44` | active | in_graph 18:54:51 | pressed locked; transfer ran in the background, bytes landed 18:54:44, 32 s after unlock |

Run on 2026-11-07, iPhone 17 (iOS 26) + Ray-Ban Meta "016N", DAT 1.0.1, Settings full/high, Keep
session in background ON, camera-roll import OFF. Session start 89 ms, Photo child started 1804 ms
after `addCamera`. Source of truth: `debug.log` in the app container (`[Glasses] input: capture
shortPress`, `photo arrived … appState=…`) and the Diagnostics rows; perception summaries came
back from Maincloud on every photo.

**How shutter photos actually reach the app.** On this unit a shutter press under a live session
delivers nothing on `photoDataPublisher` by itself (session `started`, Photo `started`, zero bytes
over a full minute of pressing). The camera-capture guide says otherwise; Meta's own DAT 1.0.1
sample (BirdSpotter) instead attaches the experimental `Inputs` capability and gets the press as
`InputEvent.capture(.shortPress, source: .captureButton)`, then calls `capturePhoto` itself. The
app does the same since `9266b9f`, and that is the path measured above. Consequence: a shutter
photo costs the same ~40 s full/high transfer as an app capture, so medium/medium is the sensible
default for a day of button photos (measurement 2 gives the numbers).

**Decision rule.** Photos arrive while backgrounded (`background` or `inactive`, bytes within
seconds of the press) → the shutter path is the bulk path and camera-roll import stays **off**.
Photos arrive only after foregrounding, or not at all → turn camera-roll import **on** in Settings
and post it in `#log` right away, because it changes how everyone captures demo data.

Result: arrived while backgrounded **4 of 5** (3 with bytes landing while locked, 1 whose transfer started locked and landed after unlock; the 5th press hit the one-capture-in-flight limit and is the reason presses are now queued). Camera-roll import: **off**. Decision rule → the shutter path is the bulk path.

## 2. Capture-to-bytes latency (10 min)

**Steps.** Settings > Capture: resolution **full**, quality **high**. Tap **Capture** 10 times,
waiting for each photo to reach *accepted* before the next (one capture in flight). Switch to
**medium / medium** and take 10 more. A capture silent for 30 s fails: leave it, it counts.

**Record.** Median and p90 `captureToBytesMs` per setting, typical `bytes`, `originalPixels`, and
how many of the 10 failed or timed out.

**Where.** Summary: capture → bytes median / p90 grouped by resolution/quality (app captures
only). CSV: `captureToBytesMs`, `bytes`, `originalPixels`, `requestedResolution`,
`requestedQuality`, `error`.

| Setting | n | median ms | p90 ms | typical bytes | originalPixels | failed / timed out |
|---|---|---|---|---|---|---|
| full / high | | | | | | |
| medium / medium | | | | | | |

## 3. HEIC vs JPEG (no extra captures)

**Steps.** Nothing new: the 26 photos above are the sample. Compare shutter photos (1) with app
captures (2).

**Record.** The container the glasses deliver per source (`heic` / `jpeg`) and `pipelineMs`, where
a HEIC decode shows up as extra time before upload.

**Where.** Summary: by format. CSV: `format`, `pipelineMs`, `source`.

| Source | format(s) seen | pipelineMs median | Notes |
|---|---|---|---|
| shutter_button | heic | ~400 (5 photos) | 0.87–1.03 MB HEIC at full/high → 1600 px JPEG ≈ 450 KB |
| sdk_capture | heic | 329 / 410 (2 photos) | same container; the glasses deliver HEIC regardless of who asked |

## 4. Startup failure rate (10 min)

**Steps.** 10 cold starts: **End shift**, close the hinges, wait 5 s, open them, **Start shift**,
wait for the pill or the error. DESIGN §4 says startup is the most common failure and to retry once
with a fresh camera setup; if the app retries by itself, count the attempt as failed only when the
pill never comes.

**Record.** Failures out of 10, time to a working session, and the error text verbatim.

**Where.** Summary: session start failure rate, last session error, last session start ms. The
photo start failure rate next to it covers capture starts inside a session (measurement 2).

| Attempt | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Started? | | | | | | | | | | |
| ms | | | | | | | | | | |

Failures: ____ / 10. Error text: ____

## 5. Battery over a day of button photos (wear them)

**Steps.** Charge glasses and phone; note both levels and the time. Wear the glasses with the
shift running and Keep session in background ON; take shutter photos as you go, one every 10–15
minutes is plenty. The app samples both batteries on every capture (repeats within a minute are
dropped). Note when the glasses go in the case or disconnect.

**Record.** Start and end levels with times for both devices, photo count, and the summary's
glasses drain per hour (percent points per hour from a straight-line fit; it appears once the
samples span 10 minutes and two levels).

**Where.** Summary: glasses drain per hour. CSV: `glassesBattery`, `phoneBattery` on every row.
JSON export: every battery sample.

| Device | Start % / time | End % / time | Photos | Drain %/h |
|---|---|---|---|---|
| Glasses | | | | |
| Phone | | | | |

## Reporting

Export CSV, then post in `#log` (one top-level message, details in the thread):

> `[DONE] #10 real-glasses measurements` — shutter while backgrounded: __/5 (camera-roll import
> off/on); capture→bytes full/high __/__ ms (median/p90), medium/medium __/__; format: __;
> session start failures __/10 (error: "__"); glasses drain __ %/h over __ h. CSV attached.

If measurement 1 turns camera-roll import on, say so in the same post with `[DECISION]`. The
sweeper folds the facts into `docs/DESIGN.md` §4 (T7) and §14 risks 2–3 and closes
`docs/CONTRACT.md` open points 2–3.
