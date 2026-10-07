import * as THREE from 'three';
import { LUT } from './leds.js';

// The ideal cone: branch tips reach roughly this surface, and LED strips are first wound on it
// before drapeStripsOnFoliage() fits them to the actual needles.
export function envelopeRadius(tree, y) {
  const { height, baseRadius, trunkHeight } = tree;
  if (y <= trunkHeight) return baseRadius;
  return Math.max(0, (baseRadius * (height - y)) / (height - trunkHeight));
}

// Real-world sizes (meters), so a bigger tree gets more branches rather than bigger ones.
const WHORL_SPACING = 0.1;
const FROND_LENGTH = 0.26;
const FROND_WIDTH = 0.17;
const GLOW_RADIUS = 0.4; // how far an LED's light reaches into the needles
const GLOW_LEDS = 4; // nearest LEDs that light each needle spray
const QUAD_ROLLS = [0, 1.15]; // each spray is two crossed quads, for volume from any angle
const NEEDLE_GREENS = ['#1d4a28', '#24562f', '#2d6236', '#356d3c', '#3f7a45', '#4a8a4c'];
// Per-spray tint range (see createTreeMesh): channel multiplier at most these, times shade ≤ 1.
const NEEDLE_TINT_MAX = [1.15 * 1.1, 1.15, 1.15 * 1.05];
// LED glow on needles is ledGlow × (needle color × GLOW_TINT + GLOW_BASE).
const GLOW_TINT = 6;
const GLOW_BASE = 0.12;
// The most a needle amplifies the glow it receives, per channel: brightest texture color ×
// brightest tint, through the formula above. (The brightest texture green is brightest in all
// three channels.) Bounds leaf glow for the flash guard.
const NEEDLE_GLOW_RESPONSE = [0, 1, 2].map((c) => {
  const max = Math.max(...NEEDLE_GREENS.map((hex) => new THREE.Color(hex).toArray()[c]));
  return max * NEEDLE_TINT_MAX[c] * GLOW_TINT + GLOW_BASE;
});

const UP = new THREE.Vector3(0, 1, 0);
const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x3a2716 });
const branchMaterial = new THREE.MeshLambertMaterial({ color: 0x2e2012 });
const coreMaterial = new THREE.MeshLambertMaterial({ color: 0x0c2414 });
const starMaterial = new THREE.MeshBasicMaterial({ color: 0xffd36b });

// Deterministic randomness so each tree looks the same on every load.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fir spray drawn on a canvas: a stem with needles angled toward the tip.
let frondTexture = null;
function getFrondTexture() {
  if (frondTexture) return frondTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  const rand = mulberry32(42);
  g.lineCap = 'round';

  const needles = 80;
  for (let i = 0; i < needles; i++) {
    const t = i / needles;
    const y = 250 - t * 238;
    const len = 54 * (1 - 0.6 * t) * (0.8 + rand() * 0.35);
    for (const side of [-1, 1]) {
      const a = 0.9 + (rand() - 0.5) * 0.35; // angle from the stem
      g.strokeStyle = NEEDLE_GREENS[Math.floor(rand() * NEEDLE_GREENS.length)];
      g.lineWidth = 2.2 + rand() * 1.2;
      g.beginPath();
      g.moveTo(64, y);
      g.lineTo(64 + side * Math.sin(a) * len, y - Math.cos(a) * len);
      g.stroke();
    }
  }
  g.strokeStyle = '#4a3418';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(64, 254);
  g.lineTo(64, 8);
  g.stroke();

  frondTexture = new THREE.CanvasTexture(canvas);
  frondTexture.colorSpace = THREE.SRGBColorSpace;
  frondTexture.anisotropy = 4;
  return frondTexture;
}

// Needle material plus a per-instance "ledGlow" color: light from nearby LEDs added on top of
// normal scene lighting, tinted by the needle color.
function createFrondMaterial() {
  const material = new THREE.MeshLambertMaterial({
    map: getFrondTexture(),
    alphaTest: 0.5,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 ledGlow;\nvarying vec3 vLedGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLedGlow = ledGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLedGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vLedGlow * ' +
          `(diffuseColor.rgb * ${GLOW_TINT.toFixed(1)} + ${GLOW_BASE});`,
      );
  };
  material.customProgramCacheKey = () => 'led-frond';
  return material;
}

export function createTreeMesh(tree) {
  const { height: H, baseRadius: R, trunkHeight: T } = tree;
  const rand = mulberry32(1000 + tree.index * 7919);
  const group = new THREE.Group();
  group.position.set(...tree.position);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.02, R * 0.07, H * 0.92, 10), trunkMaterial);
  trunk.position.y = H * 0.46;
  group.add(trunk);

  // Dark inner cone so you can't see the sky through gaps between branches.
  const coreHeight = H - T - 0.15;
  const core = new THREE.Mesh(new THREE.ConeGeometry(R * 0.5, coreHeight, 16, 1, true), coreMaterial);
  core.position.y = T + 0.05 + coreHeight / 2;
  group.add(core);

  const branchMatrices = [];
  const quads = []; // { matrix, shade }, QUAD_ROLLS.length per spray
  const anchors = []; // middle of each needle spray: drapes the strips and receives LED glow
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const side = new THREE.Vector3();
  const normal = new THREE.Vector3();

  function addFrond(center, along, roll, size, shade) {
    side.crossVectors(along, UP);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().applyAxisAngle(along, roll);
    normal.crossVectors(side, along).normalize();
    anchors.push(center.clone());
    for (const extraRoll of QUAD_ROLLS) {
      const s = side.clone().applyAxisAngle(along, extraRoll);
      const n = normal.clone().applyAxisAngle(along, extraRoll);
      const matrix = new THREE.Matrix4().makeBasis(
        s.multiplyScalar(FROND_WIDTH * size),
        along.clone().multiplyScalar(FROND_LENGTH * size),
        n,
      );
      matrix.setPosition(center);
      quads.push({ matrix, shade });
    }
  }

  // Whorls of branches. `tipY` is where the branch tips land, so the tips (not the bases)
  // follow the envelope the LED strip wraps around.
  for (let tipY = T + 0.02; tipY < H - 0.18; tipY += WHORL_SPACING * (0.7 + rand() * 0.6)) {
    const env = envelopeRadius(tree, tipY);
    const count = Math.max(5, Math.min(11, Math.round(4 + (7 * env) / R)));
    const base = rand() * Math.PI * 2;
    const size = 0.55 + 0.45 * Math.min(1, env / R + 0.2);

    for (let j = 0; j < count; j++) {
      const az = base + (j / count) * Math.PI * 2 + (rand() - 0.5) * 0.7;
      const y = tipY + (rand() - 0.5) * WHORL_SPACING * 0.6;
      const reach = envelopeRadius(tree, y) * (0.9 + rand() * 0.14);
      const rise = 0.05 + rand() * 0.2;
      const dir = new THREE.Vector3(Math.cos(az), rise, Math.sin(az)).normalize();
      const length = reach / Math.hypot(dir.x, dir.z);
      const start = new THREE.Vector3(0, y - dir.y * length, 0);

      // Woody branch.
      const r = 0.008 + 0.012 * (env / R);
      q.setFromUnitVectors(UP, dir);
      v.copy(start).addScaledVector(dir, length / 2);
      m.compose(v, q, new THREE.Vector3(r, length, r));
      branchMatrices.push(m.clone());

      // Needle sprays along the outer part of the branch, plus side shoots.
      const fl = FROND_LENGTH * size;
      const from = length * 0.15 + fl / 2;
      const to = length - fl * 0.25; // the last spray overhangs the branch tip a little
      const steps = Math.max(1, Math.ceil((to - from) / (fl * 0.55)));
      for (let k = 0; k <= steps; k++) {
        const s = from + ((to - from) * k) / steps;
        const outer = s / length;
        const shade = 0.45 + 0.55 * outer;
        const center = start.clone().addScaledVector(dir, s);
        const along = dir.clone().applyAxisAngle(UP, (rand() - 0.5) * 0.4);
        along.y += (rand() - 0.6) * 0.5;
        along.normalize();
        addFrond(center, along, (rand() - 0.5) * 0.9, size, shade);

        if (k < steps && rand() < 0.85) {
          for (const sgn of [-1, 1]) {
            const sideDir = dir.clone().applyAxisAngle(UP, sgn * (0.6 + rand() * 0.35));
            sideDir.y += (rand() - 0.7) * 0.6;
            sideDir.normalize();
            const c = center.clone().addScaledVector(sideDir, fl * 0.35);
            addFrond(c, sideDir, (rand() - 0.5) * 0.6, size * 0.8, shade * 0.9);
          }
        }
      }
    }
  }

  // Leader: sprays pointing up at the top.
  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2;
    const along = new THREE.Vector3(Math.cos(az) * 0.5, 1, Math.sin(az) * 0.5).normalize();
    addFrond(new THREE.Vector3(0, H - 0.16, 0).addScaledVector(along, 0.08), along, rand(), 0.6, 0.9);
  }
  addFrond(new THREE.Vector3(0, H - 0.12, 0), UP.clone(), 0, 0.6, 1);

  const branches = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.6, 1, 1, 5),
    branchMaterial,
    branchMatrices.length,
  );
  branchMatrices.forEach((mat, i) => branches.setMatrixAt(i, mat));
  group.add(branches);

  // One instanced mesh for all needle sprays of this tree.
  const frondGeometry = new THREE.PlaneGeometry(1, 1);
  const glow = new THREE.InstancedBufferAttribute(new Float32Array(quads.length * 3), 3);
  glow.setUsage(THREE.DynamicDrawUsage);
  frondGeometry.setAttribute('ledGlow', glow);
  const frondMesh = new THREE.InstancedMesh(frondGeometry, createFrondMaterial(), quads.length);
  const color = new THREE.Color();
  quads.forEach((quad, i) => {
    frondMesh.setMatrixAt(i, quad.matrix);
    const g = quad.shade * (0.8 + rand() * 0.35);
    color.setRGB(g * (0.9 + rand() * 0.2), g, g * (0.85 + rand() * 0.2));
    frondMesh.setColorAt(i, color);
  });
  frondMesh.frustumCulled = false;
  group.add(frondMesh);

  const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), starMaterial);
  star.position.y = H + 0.04;
  star.scale.set(1, 1.3, 0.5);
  group.add(star);

  return { group, foliage: { glow, anchors } };
}

const DRAPE_HEIGHT = 0.08; // how far above/below an LED to look for supporting foliage
const DRAPE_ARC = 0.12; // how far sideways
const DRAPE_SMOOTH = 3; // LEDs on each side averaged so the strip doesn't zigzag
const RESPACE_PASSES = 8;

// Pulls each LED in from the ideal cone onto the actual foliage surface around it, like a
// strip draped over real branches. LEDs rest at the mid-length of the outermost needle sprays;
// `strip.offset` moves them out (+) or in (-) from there. Mutates led.pos / led.world.
export function drapeStripsOnFoliage(tree, foliage) {
  const anchors = foliage.anchors.map((t) => ({ y: t.y, r: Math.hypot(t.x, t.z), a: Math.atan2(t.z, t.x) }));
  anchors.sort((p, q) => p.y - q.y);

  tree.strips.forEach((strip, s) => {
    const offset = tree.stripConfigs[s].offset;
    const surface = strip.leds.map((led) => {
      const { x, y, z } = led.pos;
      const r0 = Math.hypot(x, z);
      let best = 0;
      // Binary search to the first anchor in the height window.
      let lo = 0, hi = anchors.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].y < y - DRAPE_HEIGHT) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < anchors.length && anchors[i].y <= y + DRAPE_HEIGHT; i++) {
        const delta = anchors[i].a - led.angle;
        const da = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))); // wrapped to [0, π]
        if (da * r0 < DRAPE_ARC && anchors[i].r > best) best = anchors[i].r;
      }
      return best > 0 ? best : r0 * 0.85;
    });

    strip.leds.forEach((led, i) => {
      let sum = 0, n = 0;
      for (let k = Math.max(0, i - DRAPE_SMOOTH); k <= Math.min(surface.length - 1, i + DRAPE_SMOOTH); k++) {
        sum += surface[k];
        n++;
      }
      const r = Math.max(0.05, sum / n + offset);
      led.pos.x = r * Math.cos(led.angle);
      led.pos.z = r * Math.sin(led.angle);
      led.world.x = led.pos.x + tree.position[0];
      led.world.z = led.pos.z + tree.position[2];
    });
    respaceEvenly(strip, tree);

    strip.lengthMeters = strip.leds.reduce((len, led, i) => {
      if (i === 0) return 0;
      const p = strip.leds[i - 1].pos;
      return len + Math.hypot(led.pos.x - p.x, led.pos.y - p.y, led.pos.z - p.z);
    }, 0);
  });
}

// Draping changes each LED's radius, which breaks the equal spacing of a physical strip.
// Resample the draped path by arc length, interpolating in cylindrical coordinates (height,
// winding angle, radius) so the curve keeps its shape. A few passes converge closely.
function respaceEvenly(strip, tree) {
  const leds = strip.leds;
  const n = leds.length;
  if (n < 3) return;

  for (let pass = 0; pass < RESPACE_PASSES; pass++) {
    // Use the continuous winding angle: with sparse strips neighbours can be more than π
    // apart, so the wrapped angle alone can't tell which way round a step went.
    const pts = leds.map((l) => ({ y: l.pos.y, r: Math.hypot(l.pos.x, l.pos.z), a: l._winding }));
    const cum = [0];
    for (let i = 1; i < n; i++) {
      const p = pts[i - 1], c = pts[i];
      const dx = c.r * Math.cos(c.a) - p.r * Math.cos(p.a);
      const dz = c.r * Math.sin(c.a) - p.r * Math.sin(p.a);
      cum.push(cum[i - 1] + Math.hypot(dx, c.y - p.y, dz));
    }

    const length = cum[n - 1];
    let k = 0;
    leds.forEach((led, i) => {
      const s = (length * i) / (n - 1);
      while (k < n - 2 && cum[k + 1] < s) k++;
      const f = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
      const lerp = (key) => pts[k][key] + (pts[k + 1][key] - pts[k][key]) * f;
      const y = lerp('y'), r = lerp('r'), a = lerp('a');
      led.pos.x = r * Math.cos(a);
      led.pos.y = y;
      led.pos.z = r * Math.sin(a);
      led._winding = a;
      led.angle = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      led.h = y / tree.height;
      led.world.x = led.pos.x + tree.position[0];
      led.world.y = led.pos.y + tree.position[1];
      led.world.z = led.pos.z + tree.position[2];
    });
  }
}

// For each needle spray, remember its nearest LEDs and how strongly each one lights it.
export function bindFoliageToLeds(foliage, leds) {
  const n = foliage.anchors.length;
  const index = new Int32Array(n * GLOW_LEDS).fill(-1);
  const weight = new Float32Array(n * GLOW_LEDS);
  const best = [];

  foliage.anchors.forEach((c, f) => {
    best.length = 0;
    for (const led of leds) {
      const dx = led.pos.x - c.x, dy = led.pos.y - c.y, dz = led.pos.z - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > GLOW_RADIUS * GLOW_RADIUS) continue;
      best.push([d2, led.globalIndex]);
    }
    best.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < Math.min(GLOW_LEDS, best.length); k++) {
      const d = Math.sqrt(best[k][0]);
      const falloff = (1 - d / GLOW_RADIUS) ** 2;
      index[f * GLOW_LEDS + k] = best[k][1];
      weight[f * GLOW_LEDS + k] = (0.015 / (0.015 + d * d)) * falloff;
    }
  });
  foliage.ledIndex = index;
  foliage.ledWeight = weight;
}

// How strongly this tree's leaf glow can show an LED, for the flash guard: per-channel needle
// response (`response`) and the largest total weight any spray gives its LEDs (`weight`).
export function foliageGlowBound(foliage) {
  let weight = 0;
  for (let f = 0; f < foliage.anchors.length; f++) {
    let sum = 0;
    for (let k = 0; k < GLOW_LEDS; k++) sum += foliage.ledWeight[f * GLOW_LEDS + k];
    weight = Math.max(weight, sum);
  }
  return { response: NEEDLE_GLOW_RESPONSE, weight };
}

export function clearFoliageGlow(foliage) {
  foliage.glow.array.fill(0);
  foliage.glow.needsUpdate = true;
}

export function updateFoliageGlow(foliage, pixels, brightness) {
  const { ledIndex, ledWeight, glow } = foliage;
  const out = glow.array;
  const n = foliage.anchors.length;
  const per = QUAD_ROLLS.length;
  for (let f = 0; f < n; f++) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < GLOW_LEDS; k++) {
      const i = ledIndex[f * GLOW_LEDS + k];
      if (i < 0) break;
      const w = ledWeight[f * GLOW_LEDS + k];
      r += LUT[pixels[i * 3]] * w;
      g += LUT[pixels[i * 3 + 1]] * w;
      b += LUT[pixels[i * 3 + 2]] * w;
    }
    for (let q = f * per; q < (f + 1) * per; q++) {
      out[q * 3] = r * brightness;
      out[q * 3 + 1] = g * brightness;
      out[q * 3 + 2] = b * brightness;
    }
  }
  glow.needsUpdate = true;
}
