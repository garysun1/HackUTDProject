// Wearable-camera finish: makes a clean generated image look like what the glasses + phone
// actually upload. Deterministic per key, so re-runs produce identical files.
//   - resize to 1600 px wide (the capture app's upload size)
//   - slight lens softness, then phone-style sharpening
//   - small white-balance cast and lower saturation (small sensor under LED light)
//   - luminance sensor noise
//   - gentle lens vignetting
//   - 4:2:0 JPEG at quality 82, no metadata
import sharp from 'sharp';

function prng(key) {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
}

export async function finish(input, key = 'x') {
  const rand = prng(key);
  const W = 1600;
  const meta = await sharp(input).metadata();
  const H = Math.round(((meta.height ?? 768) * W) / (meta.width ?? 1024));
  const base = sharp(input).resize({ width: W, height: H, fit: 'fill', kernel: 'lanczos3' });

  // luminance noise: gaussian-ish (sum of 3 uniforms), mid-gray centered, applied with overlay
  const noise = Buffer.alloc(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.max(0, Math.min(255, 128 + ((rand() + rand() + rand() - 1.5) * 34) | 0));
  const noiseLayer = await sharp(noise, { raw: { width: W, height: H, channels: 1 } }).toColourspace('srgb').png().toBuffer();

  // vignette: radial transparent -> dark, multiplied
  const vignette = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><radialGradient id="g" cx="50%" cy="50%" r="75%">` +
      `<stop offset="60%" stop-color="#fff"/><stop offset="100%" stop-color="#b8b8b8"/></radialGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/></svg>`
  );

  // white-balance cast: warm or cool, small
  const warm = rand() < 0.5;
  const cast = warm ? [1.03, 1.0, 0.95] : [0.97, 1.0, 1.04];

  return base
    .blur(0.55)
    .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.2 })
    .modulate({ saturation: 0.9 + rand() * 0.06, brightness: 0.98 + rand() * 0.05 })
    .linear(cast, [0, 0, 0])
    .composite([
      { input: noiseLayer, blend: 'soft-light' },
      { input: vignette, blend: 'multiply' },
    ])
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0', mozjpeg: false })
    .toBuffer();
}
