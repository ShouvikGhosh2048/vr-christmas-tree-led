import { envelopeRadius } from './tree.js';

const SAMPLES = 4096;

// Wraps a helix around the tree's cone, then resamples it by arc length so LEDs are evenly
// spaced like a real strip (a naive helix bunches LEDs near the top where circles are smaller).
// Returns positions local to the tree base; drapeStripsOnFoliage() later fits them to the needles.
export function generateStripPoints(tree, strip) {
  const { startHeight: y0, endHeight: y1, turns, startAngle, ledCount } = strip;

  const dense = new Float64Array((SAMPLES + 1) * 3);
  const dist = new Float64Array(SAMPLES + 1);
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES;
    const y = y0 + (y1 - y0) * t;
    const r = Math.max(0.02, envelopeRadius(tree, y));
    const a = startAngle + 2 * Math.PI * turns * t;
    dense[k * 3] = r * Math.cos(a);
    dense[k * 3 + 1] = y;
    dense[k * 3 + 2] = r * Math.sin(a);
    if (k > 0) {
      const dx = dense[k * 3] - dense[k * 3 - 3];
      const dy = dense[k * 3 + 1] - dense[k * 3 - 2];
      const dz = dense[k * 3 + 2] - dense[k * 3 - 1];
      dist[k] = dist[k - 1] + Math.hypot(dx, dy, dz);
    }
  }

  const length = dist[SAMPLES];
  const points = [];
  let k = 0;
  for (let i = 0; i < ledCount; i++) {
    const u = ledCount === 1 ? 0 : i / (ledCount - 1);
    const s = u * length;
    while (k < SAMPLES - 1 && dist[k + 1] < s) k++;
    const f = (s - dist[k]) / (dist[k + 1] - dist[k] || 1);
    const x = dense[k * 3] + (dense[k * 3 + 3] - dense[k * 3]) * f;
    const y = dense[k * 3 + 1] + (dense[k * 3 + 4] - dense[k * 3 + 1]) * f;
    const z = dense[k * 3 + 2] + (dense[k * 3 + 5] - dense[k * 3 + 2]) * f;
    let angle = Math.atan2(z, x);
    if (angle < 0) angle += 2 * Math.PI;
    points.push({ x, y, z, u, angle });
  }
  return { points, length };
}
