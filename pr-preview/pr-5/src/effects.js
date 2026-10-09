import * as color from './color.js';

const EFFECTS_DIR = new URL('../effects/', import.meta.url);
const ERROR_COLOR = [60, 0, 0];

// Loads effect modules listed in effects/index.json and runs one effect instance per tree.
//
// Events:
//   'change' - an effect was assigned, failed, or the effect list was reloaded
//   'params' - a parameter or the brightness changed
export class EffectManager extends EventTarget {
  constructor(model) {
    super();
    this.model = model;
    this.effects = new Map(); // id -> effect definition
    this.list = []; // effect ids in manifest order
    this.loadErrors = [];
    this.runners = model.trees.map(() => null);
    this.brightness = 1;
  }

  // Always cache-busts so a fresh push to GitHub Pages (or a local edit) is picked up.
  async loadAll() {
    const v = `?v=${Date.now()}`;
    const res = await fetch(new URL(`index.json${v}`, EFFECTS_DIR), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load effects/index.json (${res.status})`);
    const files = await res.json();

    this.effects.clear();
    this.list = [];
    this.loadErrors = [];
    await Promise.all(
      files.map(async (file) => {
        const id = file.replace(/\.js$/, '');
        try {
          const mod = await import(new URL(`${file}${v}`, EFFECTS_DIR).href);
          const def = mod.default;
          if (!def || typeof def.render !== 'function') {
            throw new Error('must `export default { name, render(ctx) { ... } }`');
          }
          this.effects.set(id, { ...def, id, name: def.name ?? id, params: def.params ?? {} });
        } catch (e) {
          console.error(`Effect ${file} failed to load`, e);
          this.loadErrors.push(`${file}: ${e.message}`);
        }
      }),
    );
    this.list = files.map((f) => f.replace(/\.js$/, '')).filter((id) => this.effects.has(id));
  }

  // Re-imports every effect and restarts whatever each tree was running.
  async reload() {
    const current = this.runners.map((r) => r?.id);
    await this.loadAll();
    current.forEach((id, i) => {
      if (id && this.effects.has(id)) this.setEffect(i, id);
      else if (this.list.length) this.setEffect(i, this.list[0]);
    });
    this._emit('change');
  }

  setEffect(treeIndex, id) {
    const def = this.effects.get(id);
    if (!def) {
      console.warn(`Unknown effect "${id}"`);
      return;
    }
    const tree = this.model.trees[treeIndex];
    const params = {};
    for (const [key, spec] of Object.entries(def.params)) params[key] = spec.value;

    const runner = { id, def, params, state: {}, error: null };
    runner.ctx = this._makeContext(tree, runner);
    this.runners[treeIndex] = runner;
    tree.pixels.fill(0);
    try {
      def.setup?.(runner.ctx);
    } catch (e) {
      this._fail(treeIndex, runner, e);
    }
    this._emit('change');
  }

  setParam(treeIndex, key, value) {
    const runner = this.runners[treeIndex];
    if (!runner || !(key in runner.params)) return;
    runner.params[key] = value;
    this._emit('params');
  }

  setBrightness(value) {
    this.brightness = Math.min(1, Math.max(0, value));
    this._emit('params');
  }

  update(time, dt) {
    this.runners.forEach((runner, i) => {
      if (!runner || runner.error) return;
      const ctx = runner.ctx;
      ctx.time = time;
      ctx.dt = dt;
      try {
        runner.def.render(ctx);
      } catch (e) {
        this._fail(i, runner, e);
      }
      ctx.frame++;
    });
  }

  _fail(treeIndex, runner, e) {
    runner.error = e?.message ?? String(e);
    console.error(`Effect "${runner.id}" on tree ${this.model.trees[treeIndex].id} crashed:`, e);
    runner.ctx.fill(ERROR_COLOR);
    this._emit('change');
  }

  _emit(type) {
    this.dispatchEvent(new Event(type));
  }

  // The object every effect function receives. See README.md for the full contract.
  _makeContext(tree, runner) {
    const pixels = tree.pixels;
    return {
      time: 0,
      dt: 0,
      frame: 0,
      tree: {
        id: tree.id,
        index: tree.index,
        height: tree.height,
        baseRadius: tree.baseRadius,
        position: tree.position,
      },
      leds: tree.leds,
      strips: tree.strips,
      params: runner.params,
      state: runner.state,

      fill(c) {
        for (let i = 0; i < pixels.length; i += 3) {
          pixels[i] = c[0];
          pixels[i + 1] = c[1];
          pixels[i + 2] = c[2];
        }
      },
      clear() {
        pixels.fill(0);
      },
      // Like FastLED's fadeToBlackBy: amount 0..1 of the current value is removed.
      // Floors so values always reach 0 instead of getting stuck by rounding.
      fade(amount) {
        const keep = 1 - Math.min(1, Math.max(0, amount));
        for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(pixels[i] * keep);
      },

      random: Math.random,
      randomInt: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
      ...color,
    };
  }
}
