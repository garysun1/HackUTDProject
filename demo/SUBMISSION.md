> **Draft** for Gary and Edward to edit (issue #11). Written 2026-11-07 against the repo as it stood that evening. `[VERIFY: …]` marks a claim to confirm before submitting; remove the tag or the sentence, never leave a claim the build does not support. No metrics, quotes, or logos are to be added that the repo does not back.

# Working Memory for the Physical World

Enterprise operational memory for physical work. Console working name: **Shift Memory**. HackUTD 2026 · NVIDIA, NMC², and Spacetime tracks.

## Inspiration

Enterprise AI retrieves over documents, tickets, and chat. Nothing captures what happens on the floor, at the bench, or in the field until someone writes it up after the fact, and that knowledge leaves with the shift. Data center operators do physical rounds that no system records; a missed warning, an unclear handoff, or the wrong information at the wrong time becomes an outage. Glasses with a shutter button made the missing piece practical: one deliberate photo per event, taken by the person already doing the work.

## What it does

Operators photograph discrete moments with Meta Ray-Ban glasses. Each photo becomes an event in a shared, time-anchored graph, attributed to a wearer and a shift and resolved against the organization's asset registry: the model reads rack labels, panel readouts, and cable tags, and the module links the event to the canonical asset. A rule inside perception raises an alert and posts it to Slack within seconds when a photo shows a fault or a change into a fault state. The Shift Memory console shows the floor's live timeline, a floor schematic, open alerts, and the shift handoff, with a photo, a time, and a wearer behind every line. The same memory is exposed to the agents an organization already runs through MCP, so a supervisor who was never on the floor can ask what happened to PDU-A today and get an answer that cites its evidence `[VERIFY: Gary #7, #9]`. The demo is a data center shift change; labs, field service, facilities, and manufacturing are the same system with different photos.

## How we built it

- **Capture:** an iOS app in Swift 6 on the Meta Wearables Device Access Toolkit 1.0.1. Standalone photo capture (no stream) from an in-app button; shutter-button photos arrive on the same listener; camera-roll import as the fallback. On the phone, before upload: resize to 1600 px on the long edge, blur every face with Vision face rectangles, strip metadata, JPEG at about q85, then `POST` the event JSON and base64 photo to the module's `ingest_photo` procedure with a bounded retry queue and idempotent event ids.
- **Backend:** one SpacetimeDB module in TypeScript on Maincloud (`wm-physical`). Tables for events, photos, entities, edges, episodes, handoffs, alerts, assets, and wearers. `ingest_photo` stores the event and photo and schedules `perceive` through a scheduled job table; `perceive` makes the outbound HTTP calls, then writes perception, graph edges, and alerts in short transactions.
- **Perception:** NVIDIA Nemotron 3.5 Super VL (`nvidia/nemotron-3.5-super-vl-120b-a12b`) with reasoning disabled, returning structured JSON: scene, objects, people count, text in scene, changes since the previous event, anomalies, summary, confidence. Azure OpenAI gpt-4o is the fallback on an HTTP error, timeout, or bad JSON.
- **Embeddings:** Azure AI Vision image vectors (1024-d) on each event, for similarity edges and search.
- **Asset registry and attribution:** assets seeded from CSV through an admin reducer and matched against the text read in the scene; wearers keyed by device id with name, role, and shift.
- **Alerts:** a rule in `perceive` for fault words, healthy-to-fault changes, and high-severity anomalies; one alert per asset, de-duplicated while unacknowledged, posted to a Slack incoming webhook.
- **Console:** Vite and TypeScript, no framework, on live SpacetimeDB subscriptions; a canvas floor schematic; an event drawer with provenance.
- **Agent and MCP:** a Nemotron tool-calling agent (`nvidia/nemotron-3.5-lightning-30b-a3b`) as the `ask` procedure over the memory's tools, and a Node MCP server exposing the same tools to Claude Desktop `[VERIFY: Gary #7, #9 — state exactly what shipped]`.

## Challenges we ran into

- A procedure cannot hold a transaction across an HTTP call, so perception is a sequence of short transactions: read, call the models, write. Each step had to be safe to re-run.
- With reasoning on, the VL model spent most of its token budget thinking and truncated the JSON. Turning thinking off (`chat_template_kwargs: {enable_thinking: false}`) fixed it; perception needs one clean structured answer, not a chain of thought.
- Standalone photo capture in the toolkit is beta: startup is the most common failure, a capture silent for 30 seconds fails, and closing the hinges ends the session for good. The app keeps one capture in flight and retries startup once with a fresh camera setup.
- Entity resolution from model-read text alone merges and splits things wrongly, so the registry match normalizes to letters and digits ("PDU A RACK R12" matches `PDU-A`) and every answer stays evidence-first so a wrong merge is visible rather than silent.
- An alert rule that fires on every photo of a fault would flood the channel; alerts are grouped per asset and folded into the open alert until someone acknowledges it.
- The photo travels as base64 inside a JSON procedure call, about 650 KB at 1600 px; acceptable over cellular, and it keeps the phone's path free of any laptop or hotspot.

## Accomplishments that we're proud of

- A photo taken on a pair of glasses becomes an attributed, asset-resolved event with a Slack alert, with the entire pipeline from ingestion to alert running inside one database module.
- In our bake-off on a rack-label scene, Nemotron 3.5 Super VL read all eight strings and detected all three state changes, in 4.7 s against 7.3 s for gpt-4o, so Nemotron became the primary perception model.
- A console that is readable from across a room and honest about its state: it says when it is reconnecting, why a list is empty, and which features are not deployed yet.
- Privacy that is built, not promised: faces blurred on the device, people counted and never identified, provenance on every line.

## What we learned

SpacetimeDB's model, where the database is the server, removes the API layer entirely once you accept its shape: scheduled tables for jobs, procedures for anything that touches the network, subscriptions instead of polling. Reasoning models need their thinking budget managed per task. A wearable's constraints (beta capture, thermals, hinges) decide the product's capture policy more than any design preference does. And an evidence-first interface is a forcing function: if every claim must show its photo, the system cannot quietly be wrong.

## What's next

Designed in, not built this weekend (DESIGN.md §15): audio capture and transcripts with voice commands; a sentinel stream with on-phone triggers; laptop screen capture linked to physical events with a consistency rule; versioned state nodes; learned bindings between labels and assets; multi-shift consolidation; row-level security per wearer on top of Spacetime's visibility filters.

## NVIDIA track

Nemotron is used beyond a chatbot: it is the perception step and the agent of a multi-step, tool-using workflow. `nvidia/nemotron-3.5-super-vl-120b-a12b` reads every photo into structured JSON (objects, text in the scene, changes since the previous event, anomalies) that drives the graph and the alert rule; `nvidia/nemotron-3.5-lightning-30b-a3b` runs the `ask` loop, calling tools over the memory (`search_memory`, `get_timeline`, `what_changed`, `find_object`, `get_current_context`, `explain_change`, `get_provenance`, `summarize_handoff`) and returning an answer with event citations, and writes the shift handoff `[VERIFY: Gary #7, #8]`. Both calls go through NVIDIA's OpenAI-compatible endpoint with `chat_template_kwargs: {enable_thinking: false}`: with reasoning on, the VL model spent its budget thinking and truncated the JSON, and perception needs one complete structured answer per photo. Reasoning can be re-enabled for the agent loop with an explicit token budget if answer quality calls for it.

## NMC² track

The build maps onto the three failures the track names. A missed warning: the alert beat, where a photo of a panel showing `PSU2 FAULT` raises an alert in the console and in the team's Slack channel within seconds of the shutter press, attributed to the asset and the operator who saw it. An unclear handoff: the generated handoff, grouped by what needs attention, what changed, and where people were, each line citing the photo it came from, so the incoming shift reads evidence instead of a recollection. Wrong information at the wrong time: the supervisor query, where someone who was never on the floor asks what happened to PDU-A today and gets an answer with the photo, the time, and the wearer behind it rather than a guess.

## Spacetime track

The majority of the backend runs inside one SpacetimeDB module on Maincloud: ingestion (`ingest_photo`), storage of events and the photos themselves, perception orchestration (procedures making the outbound calls to Nemotron, Azure OpenAI, and Azure AI Vision), the entity and edge graph, asset matching and wearer attribution, the alert rule and the Slack post, and scheduling through a scheduled job table. The console is live subscriptions over the TypeScript SDK with no server of our own in between, which is what makes a photo appear on the wall display seconds after it is taken. Hosting on Maincloud lets the phone upload over cellular from anywhere on the floor with no laptop or hotspot in the path. The only code outside the module is the iOS app, the web page, and the MCP adapter `[VERIFY: Gary #9]`.

## Built with

Swift 6 and SwiftUI · Meta Wearables Device Access Toolkit 1.0.1 (MWDATCore, MWDATCamera, MWDATMockDevice) · Apple Vision (face rectangles) · SpacetimeDB TypeScript module on Maincloud and the SpacetimeDB TypeScript SDK · NVIDIA Nemotron 3.5 Super VL and Nemotron 3.5 Lightning via integrate.api.nvidia.com · Azure OpenAI (gpt-4o) · Azure AI Vision (multimodal embeddings) · Slack incoming webhooks · Vite and TypeScript · Canvas · Model Context Protocol (Node, stdio) and Claude Desktop `[VERIFY: Gary #9]`

## Links

Repository: https://github.com/garysun1/HackUTDProject
