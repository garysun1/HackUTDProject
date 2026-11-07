#!/usr/bin/env node
// Synthetic dataset generator: scenario JSON -> photoreal wearable-camera images, each
// checked by Nemotron VL (required labels must read back, no faces) before it is kept.
//
//   node demo/synth/generate.mjs [scenario-id ...] [--provider flux2|nvidia] [--attempts 3] [--force]
//
// Providers (--provider or SYNTH_PROVIDER):
//   flux2   FLUX.2-pro deployed on the Azure resource (default). Text-to-image, and image
//           editing for before/after pairs: the "after" shot is an edit of the "before" photo,
//           so framing and every other detail match. Auth: AZURE_AI_KEY (api-key header), or
//           AZURE_BEARER (an `az account get-access-token --resource https://cognitiveservices.azure.com` token).
//   nvidia  FLUX.1-dev on NVIDIA's API (NVIDIA_API_KEY). No editing: pairs share a seed instead.
// The checker always uses Nemotron VL at integrate.api.nvidia.com (NVIDIA_API_KEY).
// Cloud agent sessions: set proxy-injected keys to "proxy-injected" and run with NODE_USE_ENV_PROXY=1.
//
// Output: demo/synth/out/<scenario>/<shot>.jpg (1600 px, wearable-camera finish) and
// manifest.json with prompt, provider, seed, and the check result for every shot.
// Shots that already passed are skipped unless --force. Everything here is synthetic.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish } from './finish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const VALUED = new Set(['--provider', '--attempts']);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const provider = flag('provider', process.env.SYNTH_PROVIDER || 'flux2');
const attempts = Number(flag('attempts', '3'));
const force = args.includes('--force');
const wanted = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));

const NVIDIA_KEY = process.env.NVIDIA_API_KEY;
const AZURE_KEY = process.env.AZURE_AI_KEY;
const AZURE_BEARER = process.env.AZURE_BEARER;
const AZURE_SERVICES = (process.env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://hackutd-wm-garysun.services.ai.azure.com/').replace(/\/+$/, '');
const FLUX2_DEPLOYMENT = process.env.AZURE_FLUX2_DEPLOYMENT || 'flux-2-pro';
const VL_MODEL = process.env.NEMOTRON_VL_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const W = 1440;
const H = 1088; // 4:3, multiples of 16; finish.mjs resizes to the 1600 px the phone uploads

function die(msg) {
  console.error(msg);
  process.exit(1);
}
if (!NVIDIA_KEY) die('NVIDIA_API_KEY is required (the checker uses Nemotron VL).');
if (!['flux2', 'nvidia'].includes(provider)) die(`unknown provider ${provider}`);
if (provider === 'flux2' && !AZURE_KEY && !AZURE_BEARER) die('flux2 needs AZURE_AI_KEY or AZURE_BEARER.');

// Shared framing that makes images read as wearable-camera snapshots rather than renders.
const REALISM =
  ' Off-center casual framing, not a composed hero shot. Flat practical lighting, deep focus with the background nearly as sharp as the foreground, ' +
  'no cinematic depth of field, no dramatic lighting, no text overlays or watermarks.';

// ---------- providers ----------

async function flux2(body) {
  const res = await fetch(`${AZURE_SERVICES}/providers/blackforestlabs/v1/${FLUX2_DEPLOYMENT}?api-version=preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AZURE_BEARER ? { Authorization: `Bearer ${AZURE_BEARER}` } : { 'api-key': AZURE_KEY }),
    },
    body: JSON.stringify({ model: FLUX2_DEPLOYMENT, output_format: 'jpeg', ...body }),
  });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 15_000));
    return flux2(body);
  }
  if (!res.ok) throw new Error(`flux2 http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b64 = (await res.json())?.data?.[0]?.b64_json;
  if (!b64) throw new Error('flux2: no image');
  return Buffer.from(b64, 'base64');
}

async function nvidiaFlux(prompt, seed) {
  const res = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, width: 1024, height: 768, steps: 30, cfg_scale: 3.5, seed }),
  });
  if (!res.ok) throw new Error(`nvidia flux http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const a = (await res.json())?.artifacts?.[0];
  if (!a?.base64) throw new Error('nvidia flux: no image');
  if (a.finishReason && a.finishReason !== 'SUCCESS') throw new Error(`nvidia flux: ${a.finishReason}`);
  return Buffer.from(a.base64, 'base64');
}

const canEdit = provider === 'flux2';
const generate = (prompt, seed) =>
  provider === 'flux2' ? flux2({ prompt, width: W, height: H, seed }) : nvidiaFlux(prompt, seed);
const edit = (raw, instruction, seed) =>
  flux2({
    prompt: `Edit this photo: ${instruction} Keep everything else identical: framing, camera angle, labels, objects, lighting.`,
    input_image: raw.toString('base64'),
    seed,
  });

// ---------- checker ----------

const squash = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function check(jpeg, shot, tries = 3) {
  try {
    return await checkOnce(jpeg, shot);
  } catch (e) {
    // a truncated or empty checker reply says nothing about the image: ask again
    if (tries > 1) return check(jpeg, shot, tries - 1);
    throw new Error(`checker: ${e.message}`);
  }
}

async function checkOnce(jpeg, shot) {
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL_MODEL,
      max_tokens: 1500,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Return ONLY compact JSON: {"text": [each distinct string of text you can read in the image, exactly as written, at most 40], ' +
                '"faces": number of human faces visible, "looks_real": true if this could pass as an unedited real photo}.',
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`checker http ${res.status}`);
  const content = (await res.json())?.choices?.[0]?.message?.content ?? '';
  const j = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  const read = Array.isArray(j.text) ? j.text.map(String) : [];
  const all = squash(read.join(' '));
  const missing = (shot.read || []).filter(r => !all.includes(squash(r)));
  const faces = Number(j.faces) || 0;
  return {
    pass: missing.length === 0 && faces === 0,
    score: (shot.read?.length ? (shot.read.length - missing.length) / shot.read.length : 1) - (faces ? 1 : 0),
    read,
    missing,
    faces,
    looks_real: j.looks_real === true,
  };
}

// One shot: generate (or edit `ref` when given), finish, check; retry with new seeds, keep the best.
async function makeShot(sc, shot, ref, baseSeed) {
  const prompt = `${sc.style} ${shot.prompt}${REALISM}`;
  const useEdit = !!(ref && canEdit && shot.edit);
  let best = null;
  for (let k = 0; k < attempts; k++) {
    const seed = baseSeed + k;
    try {
      const raw = useEdit ? await edit(ref, shot.edit, seed) : await generate(prompt, seed);
      const jpeg = await finish(raw, `${sc.id}/${shot.id}/${seed}`);
      const chk = await check(jpeg, shot);
      const tag = chk.pass ? 'PASS' : `miss[${chk.missing.join(',')}]${chk.faces ? ` faces=${chk.faces}` : ''}`;
      console.log(`  ${shot.id}${useEdit ? ' (edit)' : ''} seed ${seed}: ${tag}`);
      if (!best || chk.score > best.chk.score) best = { raw, jpeg, chk, seed };
      if (chk.pass) break;
    } catch (e) {
      console.log(`  ${shot.id} seed ${seed}: ${String(e.message).slice(0, 160)}`);
    }
  }
  return best && { ...best, prompt: useEdit ? `EDIT of previous shot: ${shot.edit}` : prompt, edited: useEdit };
}

// ---------- main ----------

const scenarioDir = join(HERE, 'scenarios');
const ids = wanted.length ? wanted : readdirSync(scenarioDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
const providerName = provider === 'flux2' ? `azure/${FLUX2_DEPLOYMENT}` : 'nvidia/flux.1-dev';

for (const id of ids) {
  const sc = JSON.parse(readFileSync(join(scenarioDir, `${id}.json`), 'utf8'));
  const outDir = join(HERE, 'out', sc.id);
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { shots: {} };
  Object.assign(manifest, { scenario: sc.id, title: sc.title, synthetic: true });
  console.log(`\n== ${sc.id} (${providerName})`);

  // Shots sharing a `pair` key: the first is generated, later ones are edits of it.
  const groups = [];
  const byPair = new Map();
  for (const shot of sc.shots) {
    if (!shot.pair) groups.push([shot]);
    else if (byPair.has(shot.pair)) byPair.get(shot.pair).push(shot);
    else groups.push((byPair.set(shot.pair, [shot]), byPair.get(shot.pair)));
  }

  for (const group of groups) {
    const done = group.every(s => !force && manifest.shots[s.id]?.check?.pass && existsSync(join(outDir, `${s.id}.jpg`)));
    if (done) {
      console.log(`  skip ${group.map(s => s.id).join(' + ')} (exists, passed)`);
      continue;
    }
    const baseSeed = 1000 + [...(group[0].pair || group[0].id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000, 7);
    let ref = null;
    for (const shot of group) {
      // the nvidia provider cannot edit: pair members reuse the base seed instead
      const r = await makeShot(sc, shot, ref, baseSeed);
      if (!r) {
        console.log(`  FAILED ${shot.id}: no image generated`);
        continue;
      }
      if (!ref) ref = r.raw;
      writeFileSync(join(outDir, `${shot.id}.jpg`), r.jpeg);
      manifest.shots[shot.id] = {
        file: `${shot.id}.jpg`,
        provider: providerName,
        seed: r.seed,
        edited_from: r.edited ? group[0].id : undefined,
        prompt: r.prompt,
        check: { pass: r.chk.pass, missing: r.chk.missing, faces: r.chk.faces, looks_real: r.chk.looks_real, read: r.chk.read },
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }
  const shots = sc.shots.map(s => manifest.shots[s.id]).filter(Boolean);
  console.log(`  ${shots.filter(s => s.check.pass).length}/${sc.shots.length} shots pass -> ${outDir}`);
}
