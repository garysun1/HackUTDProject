# Floor issues: proposal for the module (for Gary)

The phone now draws the floor geographically (rows of racks from `asset.location`) and burns every
open `alert` on its asset's tile; when the alert is acked the tile goes out (red → green check →
neutral). Today that only works for alerts perception happens to raise. Four module changes would
make the demo start with known, named problems and let photos close them on their own. The phone
reads tables only; nothing below requires a phone change except (a), which is one extra SELECT.

## (a) Seeded `issue` table (work orders), loaded like assets

`demo/issues.csv`, loaded by the same seeding path as `demo/assets.csv`:

| column | type | example |
|---|---|---|
| issue_id | string (pk) | `WO-1042` |
| title | string | `PDU A breaker tripped, R12 half dark` |
| asset_id | string (fk asset) | `PDU-A` |
| opened_by | string | `Night shift (Dana)` |
| opened_micros | u64 | shift start minus 3 h |
| status | `open` \| `in_progress` \| `resolved` | `open` |
| resolved_event_id | string? | event that closed it |
| resolution_note | string? | `reset breaker, load back on B feed` |

Seed 3 rows: PDU-A tripped (R12), CRAC-2 high return temp (Row 1 end), UPS-1 on bypass
(Electrical room). The floor opens with three fires in three places, each with a name.
Phone side: `FloorRepository` adds `SELECT ... FROM issue` and maps rows onto `FloorIssue`
(issue_id → id needs a stable u64, or FloorIssue.id becomes a string; either is fine).

## (b) Perception auto-resolves

After perceiving an event that INVOLVES an asset with an open issue/alert, resolve it when either:
- a CHANGES edge on that asset goes `FAULT → OK` (or the reading is back in range), or
- the wearer's note / transcript says it is fixed (`fixed`, `reset`, `back online`, `resolved`),
  scored by the same LLM call that writes the summary (`resolves: [issue_id]` in its JSON).

Set `status = resolved`, `resolved_event_id = event_id`, `resolution_note` from the note. Leave
`in_progress` when the photo shows work but not a fix. Never auto-resolve from a photo that only
mentions the asset.

## (c) Console floor shows the same transition

The web floor schematic subscribes to `issue`/`alert`; on open → resolved, animate the tile out the
same way (glow shrinks, red → green check, back to neutral after ~20 s) and show the resolving
photo's thumbnail on hover. Both screens then tell one story during the demo.

## (d) `ack_alert_with_evidence(alert_id: u64, event_id: string)`

Like `ack_alert`, plus stores `acked_event_id` (and the caller's device id). A resolution then
cites its photo; the phone's "Mark resolved" would pass the latest event on that asset, and the
asset sheet can show "resolved by <photo>". Keep `ack_alert` for compatibility.
