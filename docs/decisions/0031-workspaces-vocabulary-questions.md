# 0031 workspaces, a vocabulary per workspace, and questions as a first-class component

- Date: 2026-11-08
- Status: active (extends 0029, 0030)
- Source: Gary, chat

**Decision.** The console presents the datasets as workspaces, the way an enterprise platform
would: a switcher in the top bar lists them with a name, a line about the site, a sample tag
for synthetic ones and a photo count, and switching swaps the data connection client-side with
nothing written to the backend. The choice is remembered per browser; "Follow server default"
returns to the `demo_config` switch of 0029, which still drives any console that has not chosen.

The structure of the memory is the same in every workspace: moments (photos), sessions, people,
places, tracked things, readings, changes, flags, marks, notes and questions. What changes per
workspace is the vocabulary and the registry. Each workspace declares its words (session: shift,
rounds, pick wave; tracked: equipment, machine, device, apparatus, asset; flag: issue, alarm,
trip, hazard) and its plain-language type words; the header, legend, mode button, pills and the
detail panel use them. Unknown types are humanized from the registry's own `asset_type`.

Questions are a component of the memory, not a side channel. The module has a `question`
table and a `log_question` reducer; the MCP server records every question-answering call with
the moments it cited (best effort, when it holds the ingest token); the shift line draws each
question as a card under the photos that answered it, with dashed threads up to them. This is
the agent's provenance made visible, and it is what makes the memory look used rather than only
recorded.

**Reason.** The structure was already general; the words were data-center words, and a single
server-side switch hid the breadth of the thing. A visible workspace switcher shows judges five
industries in ten seconds, and per-workspace language stops a hospital's rounds being called a
shift. Questions close the loop between the glasses, the memory and the agent on one screen.

**Still tailored, and whose it is.** The perception prompt names data center operators and the
alert rule's fault words are machine words. Both live in the module's perception path (pipeline
session); the proposal is a domain-neutral prompt with the workspace vocabulary injected and the
registry carrying the domain.
