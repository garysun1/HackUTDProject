# 0023 nemotron agent

- Date: 2026-11-07
- Status: active (amends 0011; extended by 0025 to perception)
- Source: Gary, chat

**Decision.** Nemotron via NVIDIA's OpenAI-compatible endpoint is the agent behind the MCP tools, the episode titler, and the handoff writer, running as a tool-calling loop inside the ask procedure. Default nemotron-3.5-lightning-30b-a3b, nemotron-3-ultra if quality needs it; verify IDs on build.nvidia.com. Azure gpt-4o stays the perception VLM; Azure gpt-5 is the fallback agent. Optional bake-off of nemotron-3.5-super-vl for perception.

**Reason.** NVIDIA track requires Nemotron used beyond a chatbot in multi-step, tool-using workflows, which is exactly the agent loop.
