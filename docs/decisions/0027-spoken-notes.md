# 0027 spoken notes, transcribed on the phone

- Date: 2026-11-07
- Status: active (amends 0019)
- Source: Edward, chat; posted to `#log` by Edward's agent

**Decision.** After the shutter chime, the capture app listens while the photo transfers from the
glasses (10–45 s) and the wearer says what is going on. Apple on-device speech recognition turns it
into text, and the upload waits so the text goes into the existing `note` field with the photo. No
contract or schema change: `perceive` already puts the wearer note into the perception prompt, so
the context reaches the graph through the existing path. No audio leaves the phone. The mic is the
glasses' when connected as a Bluetooth headset, else the phone's; toggle in Settings. The shift
also ends with a spoken handoff stored as a `Handoff:` note, which the next wearer's briefing
leads with.

**Reason.** A typed note on a phone mid-task does not happen; a spoken one does, and it is the
single richest signal for the graph ("PSU2 was faulting because it was unseated; I reseated it").
0019's image-only rule was about not streaming or storing audio, which still holds.
