# 0001 stack and storage split

- Date: 2026-11-07
- Status: superseded by 0022 (Spacetime replaces Postgres and Neo4j)
- Source: Seed §2.3

**Decision.** Postgres + pgvector is the replayable source of truth; Neo4j holds entities, events, edges and is rebuildable from Postgres; photos in object storage.

**Reason.** Lets graph parameters be tuned without recapturing.
