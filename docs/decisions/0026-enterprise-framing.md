# 0026 enterprise framing

- Date: 2026-11-07
- Status: active (amends 0012 G, 0017, 0024)
- Source: Gary, chat

**Decision.** The product is framed as enterprise operational memory for physical work, the missing modality in enterprise knowledge, rather than a personal agent's memory. NMC² (data center shift change) is the application shown in the demo, named as one application. Consequences: shared memory across wearers is in scope (events carry wearer and shift); entities resolve against an asset registry seeded from CSV; a rule in perception raises alerts on fault-like text or state changes and posts to a Slack channel; the handoff posts to the same channel; the demo is rebuilt around alert, handoff, and supervisor beats; governance language (device-side face blur, people counted not identified, provenance on every claim, self-host option) is part of the pitch. Still excluded: identifying people, SSO, multi-tenancy, admin console. MCP remains the integration surface, framed as "the agents the organization already runs can query the floor."

**Reason.** The sponsor and judging audience is enterprise-oriented; the enterprise delta is small (attribution, registry, alert rule, channel posts, about half a day) while the narrative gain is large, and it maps directly onto NMC²'s "missed warning, unclear handoff, wrong information at the wrong time."
