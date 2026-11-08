# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + TypeScript, no framework. SpacetimeDB TypeScript SDK for live subscriptions to the
`wm-physical` module on Maincloud. Canvas for the floor schematic. Google Fonts.

## Users

Data center operators on shift (wearers of the glasses) and the people who were not on the
floor: the incoming shift lead reading a handoff, a supervisor asking what happened to an
asset. Judges at HackUTD watching on a projector from two meters.

## Product Purpose

Enterprise operational memory for physical work. Operators photograph discrete moments; each
photo becomes an evidence-backed event attributed to a wearer and shift and resolved against
the organization's assets. The console shows the floor's live memory, raises alerts, writes
the shift handoff, and answers questions, every claim citing a photo.

## Positioning

The missing modality in enterprise knowledge. Retrieval covers documents, tickets, and chat;
nothing captures the floor until someone writes it up after the fact. This does, with a photo
behind every line, and exposes it to people here and to the organization's agents over MCP.

## Operating Context

Night shifts, dim rooms, wall displays and laptops; readers under time pressure who will not
read a tutorial. Photos arrive every few minutes from Meta Ray-Ban glasses; perception runs
inside the SpacetimeDB module within seconds. Assets have IDs (R12-C, PDU-A, SW-CORE-07).

## Capabilities and Constraints

Live tables: event, photo, entity, edge, episode, handoff (plus asset, wearer, alert pending).
Procedures: ping, ingest_photo, perceive (scheduled); ask and handoff pending. Image-only; no
audio. Faces blurred on the device; people counted, never identified. Hackathon build: no
auth, single floor.

## Brand Commitments

Product name: Reflection (was Shift Memory). Tracks: NVIDIA (Nemotron agent), NMC² (data
center operations), Spacetime (backend). Projector legibility is binding.

## Evidence on Hand

Real photos from the venue arrive during the hackathon; `demo/fixtures/shift-hour` is the
rehearsal set. One synthetic rack-label scene exists in the scratchpad. No testimonials, no
logos to use; do not fabricate any.

## Product Principles

1. Evidence first: no claim without its photo, time, and wearer.
2. Readable from across a room: density with hierarchy, never decoration.
3. Live by default: anything that changes on the floor changes on the screen without a reload.
4. The floor is the mental model: assets and places are where they are, events attach to them.
5. People are counted, never identified.
