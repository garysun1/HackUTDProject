#!/usr/bin/env node
// Synthetic dataset generator: scenario JSON -> photoreal wearable-camera images, each
// checked by Nemotron VL (required labels must read back, no faces) before it is kept.
//
//   node demo/synth/generate.mjs [scenario-id ...] [--provider flux|azure] [--attempts 3] [--force]
//
// Providers (pick with --provider or SYNTH_PROVIDER):
//   flux   NVIDIA-hosted FLUX.1-dev at ai.api.nvidia.com            needs NVIDIA_API_KEY
//   azure  Azure OpenAI gpt-image-1 deployment (AZURE_IMAGE_DEPLOYMENT) needs AZURE_AI_KEY
// The checker always uses Nemotron VL at integrate.api.nvidia.com (NVIDIA_API_KEY).
// In cloud agent sessions set the keys to "proxy-injected" and run with NODE_USE_ENV_PROXY=1.
//
// Output: demo/synth/out/<scenario>/<shot>.jpg (1600 px, wearable-camera finish) and
// manifest.json with prompt, provider, seed, and the check result for every shot.
// Existing passing shots are skipped unless --force. Everything here is synthetic.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish } from './finish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const provider = flag('provider', process.env.SYNTH_PROVIDER || 'flux');
const attempts = Number(flag('attempts', '3'));
const force = args.includes('--force');
const VALUED = new Set(['--provider', '--attempts']);
const wanted = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));

const NVIDIA_KEY = process.env.NVIDIA_API_KEY;
const AZURE_KEY = process.env.AZURE_AI_KEY;
const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || 'https://hackutd-wm-garysun.openai.azure.com/').replace(/\/+$/, '');
const AZURE_DEPLOYMENT = process.env.AZURE_IMAGE_DEPLOYMENT || 'gpt-image-1';
const VL_MODEL = process.env.NEMOTRON_VL_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
if (!NVIDIA_KEY) die('NVIDIA_API_KEY is required (checker, and the flux provider).');
if (provider === 'azure' && !AZURE_KEY) die('AZURE_AI_KEY is required for --provider azure.');
if (!['flux', 'azure'].includes(provider)) die(`unknown provider ${provider}`);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Shared framing that makes images read as wearable-camera snapshots rather than renders.
const REALISM =
  ' Off-center casual framing, not a composed hero shot. Flat practical lighting, deep focus with background equally sharp, ' +
  'no cinematic depth of field, no dramatic lighting, no vignette, no text overlays or watermarks.';

// ---------- providers ----------

async function genFlux(prompt, seed) {
  const res = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, width: 1024, height: 768, steps: 30, cfg_scale: 3.5, seed }),
  });
  if (!res.ok) throw new Error(`flux http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const a = (await res.json())?.artifacts?.[0];
  if (!a?.base64) throw new Error('flux: no image');
  if (a.finishReason && a.finishReason !== 'SUCCESS') throw new Error(`flux: ${a.finishReason}`);
  return Buffer.from(a.base64, 'base64');
}

async function genAzure(prompt, _seed) {
  // gpt-image-1 has no seed; before/after pairs rely on the prompt alone.
  const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/images/generations?api-version=2025-04-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': AZURE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, size: '1536x1024', quality: 'high', n: 1 }),
  });
  if (!res.ok) throw new Error(`azure http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b64 = (await res.json())?.data?.[0]?.b64_json;
  if (!b64) throw new Error('azure: no image');
  return Buffer.from(b64, 'base64');
}

const generate = provider === 'azure' ? genAzure : genFlux;

// ---------- checker ----------

const squash = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function check(jpeg, shot) {
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL_MODEL,
      max_tokens: 600,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Return ONLY JSON: {"text": [every string of text you can read in the image, exactly as written], ' +
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

// ---------- main ----------

const scenarioDir = join(HERE, 'scenarios');
const ids = wanted.length ? wanted : readdirSync(scenarioDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));

for (const id of ids) {
  const sc = JSON.parse(readFileSync(join(scenarioDir, `${id}.json`), 'utf8'));
  const outDir = join(HERE, 'out', sc.id);
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { shots: {} };
  manifest.scenario = sc.id;
  manifest.synthetic = true;
  console.log(`\n== ${sc.id} (${provider})`);

  // Shots sharing a `pair` key are generated together with the same seed so the
  // before/after images keep the same framing; a seed is accepted only if all pass.
  const groups = [];
  const byPair = new Map();
  for (const shot of sc.shots) {
    if (shot.pair) {
      if (!byPair.has(shot.pair)) groups.push((byPair.set(shot.pair, []), byPair.get(shot.pair)));
      byPair.get(shot.pair).push(shot);
    } else groups.push([shot]);
  }

  for (const group of groups) {
    const done = group.every(s => !force && manifest.shots[s.id]?.check?.pass && existsSync(join(outDir, `${s.id}.jpg`)));
    if (done) {
      console.log(`  skip ${group.map(s => s.id).join(' + ')} (exists, passed)`);
      continue;
    }
    const baseSeed = 1000 + [...(group[0].pair || group[0].id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000, 7);
    let best = null;
    for (let k = 0; k < attempts; k++) {
      const seed = baseSeed + k;
      const results = [];
      try {
        for (const shot of group) {
          const prompt = `${sc.style} ${shot.prompt}${REALISM}`;
          const raw = await generate(prompt, seed);
          const jpeg = await finish(raw, `${sc.id}/${shot.id}/${seed}`);
          const chk = await check(jpeg, shot);
          results.push({ shot, prompt, jpeg, chk });
        }
      } catch (e) {
        console.log(`  ${group.map(s => s.id).join(' + ')} seed ${seed}: ${String(e.message).slice(0, 160)}`);
        continue;
      }
      const score = results.reduce((a, r) => a + r.chk.score, 0);
      const pass = results.every(r => r.chk.pass);
      console.log(
        `  ${results.map(r => `${r.shot.id} ${r.chk.pass ? 'PASS' : `miss[${r.chk.missing.join(',')}]${r.chk.faces ? ` faces=${r.chk.faces}` : ''}`}`).join(' + ')}  (seed ${seed})`
      );
      if (!best || score > best.score) best = { score, seed, results };
      if (pass) break;
    }
    if (!best) {
      console.log(`  FAILED ${group.map(s => s.id).join(' + ')}: no image generated`);
      continue;
    }
    for (const r of best.results) {
      writeFileSync(join(outDir, `${r.shot.id}.jpg`), r.jpeg);
      manifest.shots[r.shot.id] = {
        file: `${r.shot.id}.jpg`,
        provider: provider === 'azure' ? `azure/${AZURE_DEPLOYMENT}` : 'nvidia/flux.1-dev',
        seed: best.seed,
        prompt: r.prompt,
        check: { pass: r.chk.pass, missing: r.chk.missing, faces: r.chk.faces, looks_real: r.chk.looks_real, read: r.chk.read },
      };
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const shots = sc.shots.map(s => manifest.shots[s.id]).filter(Boolean);
  console.log(`  ${shots.filter(s => s.check.pass).length}/${sc.shots.length} shots pass -> ${outDir}`);
}
