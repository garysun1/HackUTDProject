// Local metres around a site origin. Three.js is y-up: x = east, z = south (north is -z).
const R = 6378137;
const D2R = Math.PI / 180;

export class Proj {
  private k: number;
  constructor(public lon0: number, public lat0: number) { this.k = Math.cos(lat0 * D2R); }
  toXZ(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * D2R * R * this.k, -(lat - this.lat0) * D2R * R];
  }
  // Shape space for THREE.Shape: (x, north). A mesh rotated -90° about X maps shape y to world -z.
  toShape(lon: number, lat: number): [number, number] { const [x, z] = this.toXZ(lon, lat); return [x, -z]; }
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Web Mercator tiles (for the imagery ground).
export function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2) * n);
  return [x, y];
}
export function tileBounds(x: number, y: number, z: number): { w: number; e: number; n: number; s: number } {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return { w: lon(x), e: lon(x + 1), n: lat(y), s: lat(y + 1) };
}

export function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
  const [x, y] = pt; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function centroid(pts: [number, number][]): [number, number] {
  let sx = 0, sy = 0; for (const p of pts) { sx += p[0]; sy += p[1]; }
  return [sx / pts.length, sy / pts.length];
}
