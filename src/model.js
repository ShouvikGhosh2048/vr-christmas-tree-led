import { generateStripPoints } from './strip.js';

// One LED. Colors are 8-bit RGB (0-255) stored in a shared Uint8ClampedArray, the same layout
// a WLED/FastLED controller uses, so the buffer can later be streamed to real hardware.
class Led {
  constructor(buffer, meta) {
    this._buf = buffer;
    this._o = meta.globalIndex * 3;
    Object.assign(this, meta);
  }

  // set(r, g, b) or set([r, g, b])
  set(r, g, b) {
    if (typeof r !== 'number') [r, g, b] = r;
    const buf = this._buf, o = this._o;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    return this;
  }

  get() {
    const buf = this._buf, o = this._o;
    return [buf[o], buf[o + 1], buf[o + 2]];
  }
}

function normalizeTree(cfg, index) {
  const height = cfg.height ?? 2;
  const trunkHeight = cfg.trunkHeight ?? height * 0.12;
  const tree = {
    id: cfg.id ?? `tree${index}`,
    index,
    position: cfg.position ?? [0, 0, 0],
    height,
    baseRadius: cfg.baseRadius ?? height * 0.4,
    trunkHeight,
  };
  tree.stripConfigs = (cfg.strips ?? [{}]).map((s, i) => ({
    id: s.id ?? `${tree.id}-${i}`,
    ledCount: s.ledCount ?? 300,
    turns: s.turns ?? 10,
    startHeight: s.startHeight ?? trunkHeight + 0.03,
    endHeight: s.endHeight ?? height - 0.08,
    offset: s.offset ?? 0,
    startAngle: ((s.startAngleDeg ?? 0) * Math.PI) / 180,
  }));
  return tree;
}

// Builds trees, strips and LEDs from config/scene.json. Strips are laid out back to back in one
// pixel buffer: tree 0 strip 0, tree 0 strip 1, ..., tree 1 strip 0, ...
export function buildModel(config) {
  const trees = config.trees.map(normalizeTree);
  const total = trees.reduce((n, t) => n + t.stripConfigs.reduce((m, s) => m + s.ledCount, 0), 0);
  const pixels = new Uint8ClampedArray(total * 3);
  const leds = [];

  let g = 0;
  for (const tree of trees) {
    const treeStart = g;
    tree.leds = [];
    tree.strips = tree.stripConfigs.map((sc, s) => {
      const { points, length } = generateStripPoints(tree, sc);
      const strip = {
        index: s,
        id: sc.id,
        length: sc.ledCount,
        lengthMeters: length,
        offset: g,
        pixels: pixels.subarray(g * 3, (g + sc.ledCount) * 3),
        leds: [],
      };
      points.forEach((p, i) => {
        const led = new Led(pixels, {
          index: tree.leds.length,
          globalIndex: g,
          tree: tree.index,
          strip: s,
          indexInStrip: i,
          u: p.u,
          h: p.y / tree.height,
          angle: p.angle,
          pos: { x: p.x, y: p.y, z: p.z },
          world: { x: p.x + tree.position[0], y: p.y + tree.position[1], z: p.z + tree.position[2] },
        });
        strip.leds.push(led);
        tree.leds.push(led);
        leds.push(led);
        g++;
      });
      return strip;
    });
    tree.pixels = pixels.subarray(treeStart * 3, g * 3);
  }

  return { trees, leds, pixels };
}
