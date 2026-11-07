#!/usr/bin/env node
// Shift Memory MCP server: exposes the floor's memory (wm-physical on SpacetimeDB) to any
// MCP client over stdio. Claude Desktop config: see mcp/README.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { register } from './tools.mjs';

const server = new McpServer({ name: 'shift-memory', version: '0.1.0' }, {
  instructions: 'This is an organization\'s memory of physical work: operators photograph moments on the floor; each photo is an event attributed to a wearer and resolved against an asset registry. Every answer must cite events as [event:id time wearer]; call get_provenance with the id to see the photo. Prefer the specific tools (search_memory, what_changed, find_object, get_timeline, summarize_handoff, get_current_context) over guessing. People are counted, never identified.',
});
register(server);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`shift-memory MCP ready on stdio (db ${process.env.SPACETIME_DB_NAME || 'wm-physical'})\n`);
