# Floor calibration — ECSW, 2026-11-08 (issue #19)

`ecsw-2026-11-08.csv` is the per-second `calibration.csv` from Edward's walk (shift `fe2282d3`, 08:31:56–08:44:18 UTC,
733 rows; the two earlier shift ids in the file are desk tests). Columns are documented in `capture-app/HANDOFF.md`.
Route: Axxess Atrium (floor 1, app floor 0) → ground-floor loop → east stairs up to floor 2 → **elevator** up to
floor 3 → stairs up to floor 4 → End shift (Edward never came back down). ECSW numbers its floors 1–4; the app's floor is relative to Start
shift, so app 0/1/2/3 = ECSW 1/2/3/4. No notes were typed; stations are read off the altitude plateaus.

## What the data says

| Station (ECSW floor) | Plateau `rel_alt_m` | Step | App floor shown (h = 4.0 m) |
|---|---|---|---|
| 1, atrium at start | 0.0 | — | 0 |
| 1, after a 6-min walking loop | −1.45 | drift | 0 |
| 2, top of east stairs (pedometer +2) | 5.65–5.74 | +5.7 (≈ +7.1 from the drifted baseline) | 1 |
| 3, after the elevator (pedometer +0) | 10.85–10.98 | +5.2 | **3** (should be 2) |
| 4, stairs (pedometer +2, 6 s after the barometer) | 16.27–16.46 | +5.5 | 4 (should be 3) |

- **Floor height ≈ 5.5 m** (5.7 / 5.2 / 5.5), not the 4.0 m default. With h = 4 the 2nd flight quantised as two
  floors. `FloorQuantizer.Config.defaultFloorHeightM` is now **5.5**.
- **Pedometer and elevator behave**: CMPedometer counts **2 floors per ECSW floor** (Apple's floor unit is ~3 m),
  4 s before the first accept and 6 s after the third step was first seen (one rejection, then accepted). The
  elevator ride produced **no pedometer change** and was accepted through the elevator exception ("west elevator at
  19 m, pedometer not required") — rule (a) worked as designed. `pedometerWindow` stays 60 s.
- **Indoor GPS is 10–35 m off** (`h_acc_m` 6–35 m): the first flight was rejected for 16 s because the east stairs
  read 24–35 m away. `siteRadiusM` is now **40 m**.
- **Barometric drift** while walking the ground floor: −1.45 m over 6 min (0.26 floor at h = 5.5). The baseline
  re-zero (rule c) never ran because CMMotionActivity never reported `stationary` at ≥ medium confidence — the
  "stand still 30 s" stations were not long/quiet enough, or the phone in hand keeps it at `unknown (high)`.
  Worth a second look: re-zero on a low pedometer step rate instead of the activity class.
- **Shutter photos at full/high** take 41–50 s to transfer; six presses were queued or ignored during the walk.
  Use medium/medium for walks; the capture times are not needed for calibration (the plateaus are).

## Not yet measured
- An elevator ride *down*, and rule (b) at the elevator with a worse fix.
- A long stationary period for the baseline re-zero.
- A second building (`FloorSites.bySite` has ECSW only).
