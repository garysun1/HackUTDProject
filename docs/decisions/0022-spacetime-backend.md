# 0022 spacetime backend

- Date: 2026-11-07
- Status: active (supersedes 0001 storage split, 0009 local hosting; amends 0016)
- Source: Gary, chat

**Decision.** The backend is one SpacetimeDB module in TypeScript published to Maincloud: tables for events, photos, entities, edges, episodes, handoffs; procedures for ingest, perception (outbound HTTP to Azure), segmentation, the Nemotron agent loop, and handoff. No Postgres, Neo4j, LangGraph, or API server. The phone calls ingest_photo over the HTTP procedure API with JSON args (base64 photo); the web view and MCP server subscribe over WebSocket. Time-boxed: if the vertical slice is not working by 14:30 on day 1, fall back to Postgres + Neo4j on a laptop.

**Reason.** Docs confirm TypeScript modules with stable procedures that can make HTTP calls (30 s default, 180 s max timeout), an HTTP endpoint to call procedures with JSON args, inline binary storage guidance up to ~100 MB, and Maincloud free tier with auto-pause. Live subscriptions give the demo's real-time beat for free. Hosting on Maincloud lets the phone upload over cellular.
