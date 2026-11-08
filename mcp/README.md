# Shift Memory MCP server

Exposes the floor's memory (the `wm-physical` SpacetimeDB module) to any MCP client over
stdio. Tools return text with one citation per line, `[event:id time wearer]`, and attach the
photo as an image block so the agent can see the evidence.

## Tools

| Tool | Answers |
|---|---|
| `search_memory(query, since?, limit?)` | anything described in a photo: text read, objects, places, notes |
| `get_timeline(since?, until?)` | the shift as episodes (module `episode` table when present, else place/gap segmentation) |
| `what_changed(entity, since?)` | recorded state changes on an asset, from → to, when, who |
| `find_object(name)` | where something was last seen, with the photo |
| `get_current_context()` | the latest photo: who, where, what it shows, open alerts |
| `explain_change(entity)` | the change chain for an asset with first and latest photos |
| `get_provenance(id)` | the full record behind a citation or entity, with the photo |
| `summarize_handoff(since?)` | the shift handoff; uses the module's Nemotron narrative when `handoff` is deployed |
| `ask_floor(question)` | routes to the module's Nemotron agent when `ask` is deployed |
| `list_open_alerts()`, `acknowledge_alert(alert_id)` | alert triage shared with the console |

## Run

```bash
cd mcp && npm install && npm test
```

The smoke test spawns the server, lists tools, and calls each read tool against Maincloud.

## Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "shift-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/HackUTDProject/mcp/src/server.mjs"],
      "env": {
        "SPACETIME_DB_NAME": "wm-physical",
        "WM_TZ": "America/Chicago",
        "AZURE_AI_KEY": "optional: enables semantic search over image embeddings",
        "AZURE_AI_SERVICES_ENDPOINT": "https://hackutd-wm-garysun.cognitiveservices.azure.com/"
      }
    }
  }
}
```

Restart Claude Desktop; the tools appear under the hammer icon. Try: "What needs attention on
the floor right now?", "What happened to PDU-A today?", "Write the handoff for the next shift."

Environment: `SPACETIME_HOST` (default Maincloud), `WM_TZ`. By default the server reads whichever
database `demo_config.active_dataset` on `wm-physical` names (the workspace switch, decision 0029);
`SPACETIME_DB_NAME` pins one database instead. Azure variables are optional; without them
`search_memory` is keyword-only. No secrets are required to read.

Questions are logged (decision 0031): when `INGEST_TOKEN` (or `ADMIN_TOKEN`) is in the
environment, every question-answering call is recorded in the module's `question` table with
the moments it cited, and the console draws it under those photos. Without a token nothing is
logged and the tools work the same.
