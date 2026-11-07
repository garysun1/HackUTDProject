# Interface contract: phone app <-> Spacetime module (issue 3)

Status: v3, Spacetime-hosted. Supersedes the HTTP-service contract acked by Edward's side on
2026-11-07; the items from that ack (idempotency, optional dimensions, bounded retry queue,
phone-side face blur, clock offset) carry over. Changes go through `#log` as `[DECISION]`.

## Transport

- Target: the SpacetimeDB module on Maincloud. The phone calls one procedure over HTTP:

  `POST https://maincloud.spacetimedb.com/v1/database/<DB_NAME>/call/ingest_photo`

  Body is a JSON array of the procedure's arguments: `["<event_json>", "<photo_b64>"]`.
  Header `Content-Type: application/json`. Anonymous calls are permitted; the procedure
  checks `ingest_token` inside `event_json` against the module's config. (If we move to
  Spacetime identity tokens, the phone adds `Authorization: Bearer <token>` from
  `POST /v1/identity`; the body does not change.)
- All timestamps ISO-8601 with UTC offset. The phone sends `client_t`; the module stamps
  `server_t` on receipt and records `server_t - client_t`.
- Phone uploads over cellular or Wi-Fi; no laptop or hotspot is involved in ingestion.

## `ingest_photo(event_json, photo_b64)`

`event_json` (string containing this object):

```json
{
  "event_id": "uuid4, generated on the phone; idempotency key",
  "device_id": "stable id for the glasses/phone pair",
  "client_t": "2026-11-08T14:41:03.120-06:00",
  "source": "shutter_button | sdk_capture | camera_roll | manual_upload",
  "photo": {"mime": "image/jpeg", "width": 1600, "height": 1200},
  "note": null,
  "label": null,
  "clock_offset_ms": 0,
  "wearer": "optional display name; otherwise resolved from device_id via the wearer table",
  "ingest_token": "shared secret from the app's local config",
  "app_version": "0.1.0"
}
```

`photo_b64`: base64 of a JPEG, long edge 1600 px, quality about 85, faces already blurred,
HEIC converted on the phone. Typical size 300–500 KB (about 650 KB as base64).

Field rules:
- `client_t`: for `shutter_button` and `sdk_capture`, the capture timestamp the SDK delivers
  with the photo (or EXIF DateTimeOriginal); for `camera_roll`, the original creation
  timestamp from the Photos library, not the import time.
- `photo.width/height`: optional; the module reads them from the JPEG if absent.
- `note`: optional free text typed in the app.
- `label`: optional `{"name": "PDU row 12"}`; the module binds the name to the main object in
  the photo. Replaces the spoken "this is [name]" binding.
- `clock_offset_ms`: optional; phone clock minus server clock as measured by the app against
  the module's `ping` procedure. Informational.
- Unknown fields are ignored, so audio or transcript fields can be added later.

Return value (JSON): `{"event_id": "...", "server_t": "...", "status": "accepted"}`.
A repeated `event_id` returns the existing row's `server_t` with `status: "duplicate"`.
Validation failure returns `{"error": "..."}` with the procedure failing; the app treats an
HTTP 4xx/5xx or an `error` field as retryable unless the error is `invalid_token`.

Processing: `ingest_photo` does no outbound HTTP itself, so it returns in well under a
second. It schedules `perceive`, which updates `event.status` to `perceived` and then
`in_graph`. Target under 15 s from upload to `in_graph`.

## Status and progress

The app subscribes to its own rows with the TypeScript SDK if available in Swift form, or
polls:

`POST https://maincloud.spacetimedb.com/v1/database/<DB_NAME>/sql`
body: `SELECT status, summary FROM event WHERE event_id = '<id>'`

The HTTP SQL endpoint is documented as intended for debugging and not performance-optimized;
one poll every 2 s for up to 20 s per photo is well within that. Status values:
`accepted | perceived | in_graph | duplicate | failed`.

## `ping()`

Procedure returning `{"server_t": "..."}`. The app uses it for connectivity and clock offset.

## Reliability on the phone

Bounded on-disk queue (about the last 50 events, oldest dropped) with retry on reconnect.
`event_id` idempotency makes retries safe. Back off exponentially on 5xx.

## Reserved, not built this hackathon

`ingest_screen_event`, audio parts, session state. Kept out of the schema until needed.

## Fixtures (demo/fixtures/)

`demo/fixtures/<scenario>/NNN.json` (an `event_json` body) plus `NNN.jpg`, and a replay
script that calls `ingest_photo` for each in order at adjustable speed. First scenario
`shift-hour`: about 20 photos from one hour at the venue framed as a data center round
(arriving, a rack, a panel, a cable change, a conversation, a snack run, back to the desk),
one with a `label`. Target output: a readable timeline and a handoff summary for that hour.

## Open points for Edward

1. Base64-in-JSON is now the transport (the procedure call API takes JSON arguments), which
   is the option you did not prefer. At 1600 px it is about 650 KB per photo. OK?
2. Do shutter-button photos reach the app's photo listener while backgrounded?
3. HEIC or JPEG from the glasses on your unit?
