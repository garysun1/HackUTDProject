# 0019 image only capture

- Date: 2026-11-07
- Status: active
- Source: Gary

**Decision.** One photo per discrete event; no audio, stream, or triggers. Paths: shutter-button photos delivered to our app's SDK photo listener (primary bulk), standalone SDK photo capture from an in-app button (live demo), camera-roll import (fallback). Toolkit 1.0 standalone photo needs no stream; updated 2026-11-07 after reading the 1.0 camera-capture docs. Live demo beat: photo to queryable in under 15 s.

**Reason.** Continuous streaming is limited to ~30 min by thermals and ~1 h of battery.
