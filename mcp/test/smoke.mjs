// Smoke test: spawn the server over stdio, list tools, call each read tool against the live DB.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'src', 'server.mjs')], env: { ...process.env } });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '));

async function run(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter(c => c.type === 'text').map(c => c.text);
  const images = r.content.filter(c => c.type === 'image');
  console.log(`\n== ${name}(${JSON.stringify(args)}) ${Date.now() - t0} ms, ${images.length} image(s)${images[0] ? ` ${Math.round(images[0].data.length * 0.75 / 1024)} KB` : ''}`);
  console.log(texts.join('\n').split('\n').slice(0, 14).join('\n'));
  return r;
}
await run('get_current_context', {});
await run('search_memory', { query: 'PSU fault', include_photo: false });
await run('what_changed', { entity: 'PDU-A' });
await run('find_object', { name: 'SW-CORE-07', include_photo: false });
await run('get_timeline', {});
await run('list_open_alerts', {});
await run('summarize_handoff', {});
await run('explain_change', { entity: 'PSU 2' });
await run('get_provenance', { id: 'fd04b475', include_photo: false });
await run('ask_floor', { question: 'what happened to PDU-A today?' });
await client.close();
