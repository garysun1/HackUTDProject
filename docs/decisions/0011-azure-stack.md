# 0011 azure stack

- Date: 2026-11-07
- Status: active (amended by 0023: Nemotron is the agent; gpt-5 is fallback)
- Source: Gary

**Decision.** Azure OpenAI gpt-4o for perception, gpt-5 for the query agent, text-embedding-3-small, Azure AI Vision multimodal embeddings; Azure AI Speech provisioned but unused after 0019. Claude appears as the MCP client, not a billed backend call.

**Reason.** Sponsored Azure credits; Claude on Foundry is not credit-eligible.
