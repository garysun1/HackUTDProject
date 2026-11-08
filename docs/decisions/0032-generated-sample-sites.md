# 0032 generated 3D sites and full-shift stories for the sample workspaces

- Date: 2026-11-08
- Status: active (extends 0029; the map is the 3D site of #24/#26)
- Source: Gary, chat

**Decision.** The sample workspaces plant, hospital, substation and warehouse demo the way the
UTD capture does. Each has its own building on the 3D map, a wearer walk that goes where its
photos were taken, and a full shift that tells one worker's day.

- **Sites.** `demo/synth/sites.mjs` writes one generated floor plan per site to
  `web/src/site3d/data/sites/<id>.json`, in the same `SiteData` shape as the OpenStreetMap ECSW
  file:
  - a building with named rooms and zones, with upper floors where they matter (the hospital's
    4 West is on level 3);
  - a few neighbouring buildings and drives;
  - the corridor spines and lifts that walks follow.

  The sites are fictional. Each sits on open land near its city, so the satellite imagery under
  it does not show a real building. The console and the standalone `site3d` app pick the known
  site the data sits in, by distance (`site3d/sites.ts`): ECSW for the venue capture, the
  generated plant for a replayed sample. Anything else still gets the generic glass box. The room
  under the wearer comes from the plan, per floor.
- **Walks.** A scenario with `site.scene` gives every shot a `room`. `replay.mjs` (with
  `walk.mjs`) then:
  - places each photo at a seeded spot inside that room;
  - walks each wearer along the corridors between their photos at 1.1 m/s, lingering in between
    and changing floors at a lift;
  - uploads every wearer's track as the phone does: a point every 30 s standing still, every
    ~5 m while walking, batched after each photo.

  The positions are illustrative, as in 0029, but they now agree with what each photo shows.
  Scenarios without `site.scene` (nmc2 for now) keep 0029's random walk.
- **Stories.** Each of the four scenarios is 14–15 shots over a 6–7 hour shift with two wearers:
  - routine rounds with normal readings;
  - a fault that raises an alert;
  - the evidence and a colleague who helps, shown as gloved hands, a note, a tag or a part (never
    a face);
  - the fix, which resolves the alert and its work order;
  - a second, smaller problem left open for the handoff.

  Work orders with `opened_t` are opened when the replay reaches that minute, so they appear
  during the shift rather than before it.
- **Images.** New images come from the existing pipeline: FLUX.2-pro, with before/after shots
  edited from the earlier photo, then the Nemotron VL label and no-face check. Earlier shots that
  still fit were kept.
- **nmc2.** The sponsor-track data center keeps its current story. Its narrative is being
  decided separately.

**Reason.** The sample workspaces exist to show that the same memory works on any physical
floor. A generic box with a random walk and a five-photo fault with no ending showed the
mechanism but not a day's work. The handoff, the questions and the map only become convincing
when there is a full shift to remember, with something fixed and something left for the next
person.
