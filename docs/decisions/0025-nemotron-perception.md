# 0025 nemotron perception

- Date: 2026-11-07
- Status: active (amends 0011, 0023)
- Source: Gary, chat; bake-off run by Claude

**Decision.** `nvidia/nemotron-3.5-super-vl-120b-a12b` with reasoning disabled is the primary perception model. Azure gpt-4o is the fallback on 429 or timeout. The pipeline is therefore Nemotron end to end: perception, episode summaries, agent loop, handoff.

**Reason.** Bake-off on a synthetic rack-label scene with a previous-event summary: both models read all eight text strings and detected all three state changes (power reading, PSU fault, new warning note); Nemotron returned valid JSON in 4.7 s vs 7.3 s for gpt-4o. With reasoning on, the VL model spent most of its budget thinking and truncated the JSON, so `chat_template_kwargs: {enable_thinking: false}` is required. Free-tier rate limits (about 40 requests per minute per model) comfortably cover one perception call per photo plus agent traffic.
