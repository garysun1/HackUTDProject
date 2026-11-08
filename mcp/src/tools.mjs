// The eight memory tools plus alert helpers. Facts come from the graph; prose is minimal
// and every line carries a citation that resolves to an event and its photo.
import { z } from 'zod';
import { snapshot, matchEntity, cite, imageBlock, fmtTime, fmtDateTime, parseSince, perception, hasProcedure, call, handoffs, eventsWithEmbedding, logQuestion, citedIds } from './db.mjs';

const text = t => ({ type: 'text', text: t });
const json = o => ({ type: 'text', text: JSON.stringify(o, null, 2) });
async function withPhoto(blocks, eventId, include = true) { if (!include || !eventId) return blocks; const img = await imageBlock(eventId); return img ? [...blocks, img] : blocks; }

function eventLine(snap, e) {
  const place = snap.placeOf(e.event_id); const assets = snap.assetsOf(e.event_id).filter(a => a.kind === 'asset').map(a => a.canonical_name);
  return `${fmtTime(e.t_micros)} · ${snap.wearerName(e.device_id)}${place ? ` · ${place.canonical_name}` : ''}${assets.length ? ` · ${assets.join(', ')}` : ''}: ${e.summary || '(not yet perceived)'}${e.note ? ` — note: “${e.note}”` : ''} ${cite(snap, e)}`;
}

function keywordScore(e, terms) {
  const p = perception(e) || {};
  const hay = [e.summary, e.scene, e.activity, e.location_guess, e.note, e.label, ...(p.text_in_scene || []), ...((p.objects || []).map(o => o?.name)), ...((p.changes_since_previous || []).map(c => `${c?.entity} ${c?.from} ${c?.to}`))].filter(Boolean).join(' \n ').toLowerCase();
  let s = 0; for (const t of terms) { if (!t) continue; const n = hay.split(t).length - 1; s += n ? 1 + Math.min(n, 3) * 0.25 : 0; }
  return s;
}

async function textEmbedding(q) {
  const key = process.env.AZURE_AI_KEY, ep = (process.env.AZURE_AI_SERVICES_ENDPOINT || '').replace(/\/+$/, '');
  if (!key || !ep) return null;
  try {
    const r = await fetch(`${ep}/computervision/retrieval:vectorizeText?api-version=2024-02-01&model-version=2023-04-15`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q }) });
    if (!r.ok) return null; return (await r.json()).vector || null;
  } catch { return null; }
}
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; };

// Tools that answer a question are logged to the module's question table with the moments they
// cited, so the console can show the memory being used (decision 0031). Best effort, needs a token.
const QUESTION_OF = { search_memory: a => a.query, what_changed: a => `what changed on ${a.entity}`, find_object: a => `where is ${a.name}`, explain_change: a => `explain the change on ${a.entity}`, ask_floor: a => a.question, get_current_context: () => 'what is happening right now', summarize_handoff: a => `handoff${a?.since ? ` since ${a.since}` : ''}` };
export function register(server) {
  const registerRaw = server.registerTool.bind(server);
  server.registerTool = (name, cfg, handler) => registerRaw(name, cfg, async (args, extra) => {
    const res = await handler(args, extra);
    const q = QUESTION_OF[name];
    if (q) { const txt = (res?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); snapshot().then(snap => logQuestion(name, q(args || {}), txt, citedIds(snap, txt), extra?.requestInfo?.headers?.['user-agent'] ? 'mcp client' : 'Claude Desktop')).catch(() => {}); }
    return res;
  });
  server.registerTool('search_memory', {
    title: 'Search the floor memory',
    description: 'Find photographed events matching a query (text in the scene, objects, places, notes, summaries). Returns ranked events with citations and the top photo.',
    inputSchema: { query: z.string().describe('What to look for, e.g. "PSU fault", "label printer", "rack 12"'), since: z.string().optional().describe('Window start: ISO time, or "2h", "45m", "1d"'), limit: z.number().int().min(1).max(20).optional(), include_photo: z.boolean().optional() },
  }, async ({ query, since, limit = 8, include_photo = true }) => {
    const snap = await snapshot(); const cutoff = parseSince(since);
    const terms = query.toLowerCase().split(/[^a-z0-9.#-]+/).filter(t => t.length > 1);
    let scored = snap.events.filter(e => e.t_micros >= cutoff).map(e => ({ e, s: keywordScore(e, terms) }));
    const qv = await textEmbedding(query);
    if (qv) { const emb = new Map((await eventsWithEmbedding()).map(r => [r.event_id, r.embedding])); for (const x of scored) { const v = emb.get(x.e.event_id); if (v && v.length) x.s += 3 * Math.max(0, cosine(qv, v) - 0.15); } }
    scored = scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.e.t_micros - a.e.t_micros).slice(0, limit);
    if (!scored.length) return { content: [text(`No events match “${query}”${since ? ` since ${since}` : ''}. ${snap.events.length} events exist in total.`)] };
    const lines = scored.map((x, i) => `${i + 1}. ${eventLine(snap, x.e)}`);
    return { content: await withPhoto([text(`${scored.length} match${scored.length > 1 ? 'es' : ''} for “${query}”:\n${lines.join('\n')}\n\nCitations are [event:id time wearer]; call get_provenance with the id to open the photo.`)], scored[0].e.event_id, include_photo) };
  });

  server.registerTool('get_timeline', {
    title: 'Timeline of the shift',
    description: 'Episodes of the shift in order: time span, place, who, what happened, with citations.',
    inputSchema: { since: z.string().optional().describe('Window start: ISO time, or "2h", "1d"'), until: z.string().optional() },
  }, async ({ since, until }) => {
    const snap = await snapshot(); const a = parseSince(since), b = until ? parseSince(until) : Infinity;
    const evs = snap.events.filter(e => e.t_micros >= a && e.t_micros <= b);
    if (!evs.length) return { content: [text('No events in that window.')] };
    let segments = [];
    if (snap.episodes.length) {
      segments = snap.episodes.filter(ep => ep.t_end_micros >= a && ep.t_start_micros <= b).map(ep => ({ start: ep.t_start_micros, end: ep.t_end_micros, title: ep.title, summary: ep.summary, ids: ep.event_ids }));
    } else {
      // deterministic fallback: new segment on place change or a gap over 20 minutes
      let cur = null;
      for (const e of evs) { const place = snap.placeOf(e.event_id)?.canonical_name || 'no place identified'; if (!cur || cur.place !== place || e.t_micros - cur.end > 20 * 60e6) { cur = { start: e.t_micros, end: e.t_micros, place, ids: [], who: new Set() }; segments.push(cur); } cur.end = e.t_micros; cur.ids.push(e.event_id); cur.who.add(snap.wearerName(e.device_id)); }
      segments = segments.map(s => ({ ...s, title: `${s.place} · ${[...s.who].join(', ')}`, summary: s.ids.map(id => snap.events.find(e => e.event_id === id)?.summary).filter(Boolean).slice(0, 2).join(' ') }));
    }
    const lines = segments.map(s => { const first = snap.events.find(e => e.event_id === s.ids[0]); return `• ${fmtTime(s.start)}–${fmtTime(s.end)} ${s.title} (${s.ids.length} photo${s.ids.length > 1 ? 's' : ''})\n  ${s.summary || ''} ${first ? cite(snap, first) : ''}`; });
    return { content: [text(`Timeline ${fmtDateTime(evs[0].t_micros)} → ${fmtDateTime(evs[evs.length - 1].t_micros)}, ${evs.length} events, ${segments.length} episodes:\n${lines.join('\n')}`)] };
  });

  server.registerTool('what_changed', {
    title: 'What changed on an asset',
    description: 'State changes recorded for an asset or object (from → to, when, who), with citations.',
    inputSchema: { entity: z.string().describe('Asset or object name/id, e.g. "PDU-A", "PSU 2", "rack 12"'), since: z.string().optional() },
  }, async ({ entity, since }) => {
    const snap = await snapshot(); const cutoff = parseSince(since); const matches = matchEntity(snap, entity);
    if (!matches.length) return { content: [text(`No entity matches “${entity}”. Known assets: ${snap.entities.filter(e => e.kind === 'asset').map(e => e.canonical_name).join(', ') || 'none seeded'}.`)] };
    const ids = new Set(matches.map(m => m.entity_id)); const out = [];
    for (const e of snap.events) { if (e.t_micros < cutoff) continue; for (const c of snap.changesOf(e.event_id)) if (c.entity && ids.has(c.entity.entity_id)) out.push(`${fmtTime(e.t_micros)} ${c.entity.canonical_name}${c.attr ? ` ${c.attr}` : ''}: ${c.from} → ${c.to} (${snap.wearerName(e.device_id)}) ${cite(snap, e)}`); }
    const seen = snap.events.filter(e => e.t_micros >= cutoff && snap.assetsOf(e.event_id).some(a => ids.has(a.entity_id)));
    const head = `Matched: ${matches.slice(0, 3).map(m => `${m.canonical_name} (${m.kind})`).join(', ')}. Seen in ${seen.length} photo${seen.length === 1 ? '' : 's'}${seen.length ? `, last at ${fmtTime(seen[seen.length - 1].t_micros)} ${cite(snap, seen[seen.length - 1])}` : ''}.`;
    return { content: [text(out.length ? `${head}\nChanges:\n${out.join('\n')}` : `${head}\nNo recorded state changes${since ? ' in that window' : ''}.`)] };
  });

  server.registerTool('find_object', {
    title: 'Find an object or asset',
    description: 'Where something was last seen: place, time, who photographed it, and the photo.',
    inputSchema: { name: z.string(), include_photo: z.boolean().optional() },
  }, async ({ name, include_photo = true }) => {
    const snap = await snapshot(); const matches = matchEntity(snap, name);
    if (!matches.length) return { content: [text(`Nothing called “${name}” has been photographed. Try search_memory for a looser match.`)] };
    const ids = new Set(matches.map(m => m.entity_id));
    const seen = snap.events.filter(e => snap.assetsOf(e.event_id).some(a => ids.has(a.entity_id)) || snap.changesOf(e.event_id).some(c => c.entity && ids.has(c.entity.entity_id)));
    if (!seen.length) return { content: [text(`“${matches[0].canonical_name}” is known but no photo involves it yet.`)] };
    const last = seen[seen.length - 1]; const place = snap.placeOf(last.event_id);
    return { content: await withPhoto([text(`${matches[0].canonical_name}: last seen ${fmtDateTime(last.t_micros)}${place ? ` at ${place.canonical_name}` : ''} by ${snap.wearerName(last.device_id)}. ${last.summary} ${cite(snap, last)}\nSeen ${seen.length} time${seen.length > 1 ? 's' : ''} in total; first ${fmtDateTime(seen[0].t_micros)} ${cite(snap, seen[0])}.`)], last.event_id, include_photo) };
  });

  server.registerTool('get_current_context', {
    title: 'What is happening now',
    description: 'The most recent photographed event: who, where, what the scene shows, open alerts, and the photo.',
    inputSchema: { include_photo: z.boolean().optional() },
  }, async ({ include_photo = true }) => {
    const snap = await snapshot(); const last = snap.events[snap.events.length - 1];
    if (!last) return { content: [text('No events yet.')] };
    const p = perception(last) || {}; const place = snap.placeOf(last.event_id); const open = snap.alerts.filter(a => !a.acked);
    const ageMin = Math.round((Date.now() * 1000 - last.t_micros) / 60e6);
    const body = [`Latest: ${fmtDateTime(last.t_micros)} (${ageMin} min ago), ${snap.wearerName(last.device_id)}${place ? ` at ${place.canonical_name}` : ''}. ${cite(snap, last)}`,
      `Scene: ${last.summary || '(not yet perceived)'}`,
      p.activity ? `Activity: ${p.activity}` : null,
      p.text_in_scene?.length ? `Text read: ${p.text_in_scene.join(' | ')}` : null,
      snap.assetsOf(last.event_id).length ? `Involves: ${snap.assetsOf(last.event_id).map(a => a.canonical_name).join(', ')}` : null,
      last.note ? `Wearer note: “${last.note}”` : null,
      `Open alerts: ${open.length}${open.length ? ' — ' + open.slice(0, 5).map(a => `${a.text} (${a.entity_name || 'unassigned'}, ${fmtTime(a.t_micros)})`).join('; ') : ''}`].filter(Boolean).join('\n');
    return { content: await withPhoto([text(body)], last.event_id, include_photo) };
  });

  server.registerTool('explain_change', {
    title: 'Explain how an asset got to its current state',
    description: 'Walks the recorded changes for an asset in order and shows the before and after photos.',
    inputSchema: { entity: z.string() },
  }, async ({ entity }) => {
    const snap = await snapshot(); const matches = matchEntity(snap, entity);
    if (!matches.length) return { content: [text(`No entity matches “${entity}”.`)] };
    const ids = new Set(matches.map(m => m.entity_id)); const chain = [];
    for (const e of snap.events) for (const c of snap.changesOf(e.event_id)) if (c.entity && ids.has(c.entity.entity_id)) chain.push({ e, c });
    const seen = snap.events.filter(e => snap.assetsOf(e.event_id).some(a => ids.has(a.entity_id)));
    if (!chain.length) return { content: await withPhoto([text(`${matches[0].canonical_name}: no state changes recorded across ${seen.length} photo${seen.length === 1 ? '' : 's'}. Current state is whatever the latest photo shows. ${seen.length ? cite(snap, seen[seen.length - 1]) : ''}`)], seen[seen.length - 1]?.event_id) };
    const lines = chain.map(({ e, c }, i) => `${i + 1}. ${fmtDateTime(e.t_micros)}: ${c.entity.canonical_name}${c.attr ? ` ${c.attr}` : ''} went from ${c.from} to ${c.to}, photographed by ${snap.wearerName(e.device_id)} ${cite(snap, e)}`);
    let blocks = [text(`${matches[0].canonical_name}: ${chain.length} recorded change${chain.length > 1 ? 's' : ''}.\n${lines.join('\n')}\nFirst and latest photos follow.`)];
    blocks = await withPhoto(blocks, chain[0].e.event_id); if (chain.length > 1) blocks = await withPhoto(blocks, chain[chain.length - 1].e.event_id);
    return { content: blocks };
  });

  server.registerTool('get_provenance', {
    title: 'Evidence behind an event or entity',
    description: 'Given an event id (or its 8-char prefix from a citation) or an entity name, returns the event record(s), wearer, place, perception fields, and the photo.',
    inputSchema: { id: z.string(), include_photo: z.boolean().optional() },
  }, async ({ id, include_photo = true }) => {
    const snap = await snapshot();
    let e = snap.events.find(x => x.event_id === id || x.event_id.startsWith(id));
    if (!e) { const m = matchEntity(snap, id); if (m.length) { const ids = new Set(m.map(x => x.entity_id)); const seen = snap.events.filter(x => snap.assetsOf(x.event_id).some(a => ids.has(a.entity_id))); e = seen[seen.length - 1]; } }
    if (!e) return { content: [text(`No event or entity matches “${id}”.`)] };
    const p = perception(e) || {};
    const rec = { event_id: e.event_id, captured_local: fmtDateTime(e.t_micros), client_t: e.client_t, wearer: snap.wearerName(e.device_id), device_id: e.device_id, source: e.source, status: e.status, place: snap.placeOf(e.event_id)?.canonical_name || null, involves: snap.assetsOf(e.event_id).map(a => `${a.canonical_name} (${a.kind})`), summary: e.summary, activity: e.activity, text_in_scene: p.text_in_scene || [], changes: p.changes_since_previous || [], people_count: e.people_count, confidence: e.confidence, note: e.note, label: e.label, model: p._meta?.model || null };
    return { content: await withPhoto([json(rec)], e.event_id, include_photo) };
  });

  server.registerTool('summarize_handoff', {
    title: 'Shift handoff',
    description: 'Handoff for the incoming shift: needs attention, what changed, where people were, notes, with a citation per line. Uses the module\'s Nemotron-written narrative when available.',
    inputSchema: { since: z.string().optional().describe('Window start; default: since the last handoff, else the whole record') },
  }, async ({ since }) => {
    const snap = await snapshot(); const prior = await handoffs();
    const cutoff = since ? parseSince(since) : (prior.length ? Math.max(...prior.map(h => h.generated_micros)) : 0);
    const evs = snap.events.filter(e => e.t_micros >= cutoff);
    if (!evs.length) return { content: [text('Nothing new since the last handoff.')] };
    let narrative = null;
    if (await hasProcedure('handoff')) { try { const r = await call('handoff', [String(cutoff)]); narrative = typeof r === 'string' ? r : r?.text || r?.[0] || JSON.stringify(r); } catch (err) { narrative = null; } }
    const open = snap.alerts.filter(a => !a.acked && a.t_micros >= cutoff);
    const sections = [];
    if (open.length) sections.push(`NEEDS ATTENTION\n${open.map(a => { const e = snap.events.find(x => x.event_id === a.event_id); return `• ${a.text}${a.entity_name ? ` — ${a.entity_name}` : ''} (${fmtTime(a.t_micros)}, ${a.wearer_name || (e && snap.wearerName(e.device_id))}) ${e ? cite(snap, e) : ''}`; }).join('\n')}`);
    const changes = []; for (const e of evs) for (const c of snap.changesOf(e.event_id)) if (c.entity) changes.push(`• ${c.entity.canonical_name}${c.attr ? ` ${c.attr}` : ''}: ${c.from} → ${c.to} (${fmtTime(e.t_micros)}, ${snap.wearerName(e.device_id)}) ${cite(snap, e)}`);
    if (changes.length) sections.push(`WHAT CHANGED\n${changes.join('\n')}`);
    const byPlace = new Map(); for (const e of evs) { const p = snap.placeOf(e.event_id)?.canonical_name || 'no place identified'; if (!byPlace.has(p)) byPlace.set(p, []); byPlace.get(p).push(e); }
    sections.push(`WHERE PEOPLE WERE\n${[...byPlace.entries()].map(([p, es]) => `• ${p}: ${es.length} photo${es.length > 1 ? 's' : ''}, ${fmtTime(es[0].t_micros)}–${fmtTime(es[es.length - 1].t_micros)}, ${[...new Set(es.map(e => snap.wearerName(e.device_id)))].join(', ')} ${cite(snap, es[es.length - 1])}`).join('\n')}`);
    const notes = evs.filter(e => e.note || e.label); if (notes.length) sections.push(`NOTES LEFT BY THE SHIFT\n${notes.map(e => `• ${e.label ? `[${e.label}] ` : ''}${e.note ? `“${e.note}”` : ''} ${cite(snap, e)}`).join('\n')}`);
    const low = evs.filter(e => e.status === 'in_graph' && e.confidence > 0 && e.confidence < 0.5); if (low.length) sections.push(`UNCERTAIN\n${low.map(e => `• ${e.summary} ${cite(snap, e)}`).join('\n')}`);
    const head = `HANDOFF ${fmtDateTime(evs[0].t_micros)} → ${fmtDateTime(evs[evs.length - 1].t_micros)} · ${evs.length} events · ${[...new Set(evs.map(e => snap.wearerName(e.device_id)))].join(', ')}`;
    return { content: [text(`${head}\n${narrative ? `\n${narrative}\n` : ''}\n${sections.join('\n\n')}\n\nEvery line cites [event:id time wearer]; use get_provenance with the id for the photo.`)] };
  });

  server.registerTool('ask_floor', {
    title: 'Ask the floor a free-form question',
    description: 'Routes a natural-language question to the module\'s Nemotron agent (when deployed). Until then, returns the most relevant events so you can reason over them yourself.',
    inputSchema: { question: z.string() },
  }, async ({ question }) => {
    if (await hasProcedure('ask')) {
      try { const r = await call('ask', [question]); const answer = typeof r === 'string' ? r : r?.answer ?? r?.[0] ?? JSON.stringify(r); const cites = Array.isArray(r?.citations) ? r.citations : Array.isArray(r?.[1]) ? r[1] : []; return { content: [text(`${answer}${cites.length ? `\n\nCitations: ${cites.map(c => `[event:${String(c).slice(0, 8)}]`).join(' ')}` : ''}`)] }; }
      catch (err) { return { content: [text(`The floor agent could not answer right now (${String(err.message).slice(0, 120)}). Use search_memory, what_changed, find_object, get_timeline, and summarize_handoff directly.`)] }; }
    }
    return { content: [text('The floor agent (ask procedure) is not deployed yet. Answer from the specific tools: search_memory for anything described in a photo, what_changed / explain_change for an asset\'s state, find_object for where something is, get_timeline for the sequence, summarize_handoff for the shift summary, get_current_context for right now. Every result cites events you can open with get_provenance.')] };
  });

  server.registerTool('list_open_alerts', {
    title: 'Open alerts',
    description: 'Alerts raised from photos that nobody has acknowledged yet.',
    inputSchema: {},
  }, async () => {
    const snap = await snapshot(); const open = snap.alerts.filter(a => !a.acked).sort((a, b) => b.t_micros - a.t_micros);
    if (!open.length) return { content: [text('All clear. No open alerts.')] };
    return { content: [text(open.map(a => { const e = snap.events.find(x => x.event_id === a.event_id); return `• #${a.alert_id} ${a.kind.replace('_', ' ')}: ${a.text}${a.entity_name ? ` — ${a.entity_name}` : ''} (${fmtDateTime(a.t_micros)}, ${a.wearer_name || (e && snap.wearerName(e.device_id)) || ''}) ${e ? cite(snap, e) : ''}`; }).join('\n'))] };
  });

  server.registerTool('acknowledge_alert', {
    title: 'Acknowledge an alert',
    description: 'Marks an alert as acknowledged for everyone (console, Slack, other agents).',
    inputSchema: { alert_id: z.number().int() },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ alert_id }) => { await call('ack_alert', [alert_id]); return { content: [text(`Alert #${alert_id} acknowledged.`)] }; });
}
