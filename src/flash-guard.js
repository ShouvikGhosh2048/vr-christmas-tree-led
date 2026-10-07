import { DISPLAY_GAIN, LUT } from './leds.js';

// Photosensitivity guard between the effects and the display. Effects are arbitrary files and
// can strobe, so everything that is drawn (bulbs, halos, leaf glow, tree lights) reads the
// guarded copy, never the effect's pixel buffer. The effect buffer itself is untouched, so
// effects that rely on it persisting between frames behave exactly as before.
//
// Modelled on WCAG 2.3's flash rules: no more than 3 flashes in any second, a flash being a
// pair of opposite changes of 10% or more in relative luminance, or of 20/320 in linear
// R − G − B (the "red flash" measure, which also catches red ↔ green swaps at equal
// luminance).
//
// The rule is applied to each LED and to the average of each REGION_BANDS-th of each tree's
// height and of each whole tree, so plain block flashing (a tree, a band, top vs bottom) is
// caught too. A region's average only counts its own LEDs, so changes elsewhere can't cancel
// it out. It isn't watertight: a pattern that balances one part of a region against another,
// with groups taking turns, can still flash a large area.
//
// For each unit and measure, a reversal must be at least 1/MAX_FLASHES s after the one before
// last, i.e. the last change in the same direction. That spaces flashes out evenly and implies
// at most MAX_FLASHES of each kind in any second, while a single quick flash (a sparkle: up
// then straight back down) passes. A change that would come too soon is held back: the LED, or
// every LED in the region, keeps its colour until it's allowed. Other changes pass untouched,
// so effects that stay under the limit look exactly as written. The brightness control is
// applied after this.
const LUMA_STEP = 0.1;
const RED_STEP = 20 / 320;
const MAX_FLASHES = 3;
const REGION_BANDS = 4;

// Measures are taken on the LED's linear value times DISPLAY_GAIN, not the raw value: every
// drawn path (bulb, glow, leaf glow, tree light) changes by at most that much for a given
// change in the LED, so a flash anywhere on screen is at least as big in this measure. It
// isn't capped at 1, so changes between bright values still count.
const SEEN = LUT.map((v) => v * DISPLAY_GAIN);

export class FlashGuard {
  // `pixels` is the shared effect buffer; `leds` are the model's LEDs (tree, h, globalIndex).
  constructor(pixels, leds) {
    const n = pixels.length;
    const count = n / 3;
    this.target = pixels;
    // Each LED shows either the effect's colour or its previous one. `shown` holds those bytes;
    // `state` and `next` the shown and candidate colours as seen (SEEN values).
    this.state = new Float32Array(n);
    this.next = new Float32Array(n);
    this.shown = new Uint8ClampedArray(n);
    this.accept = new Uint8Array(count); // whether each LED takes its candidate this frame
    this.time = 0;
    this.count = count;

    // Units are the LEDs (0..count-1), then the height bands, then the trees. `levels[k]` maps
    // each LED to its unit at that level.
    const trees = leds.reduce((t, led) => Math.max(t, led.tree + 1), 0);
    const bandOf = new Uint32Array(count);
    const treeOf = new Uint32Array(count);
    for (const led of leds) {
      const band = Math.min(REGION_BANDS - 1, Math.max(0, Math.floor(led.h * REGION_BANDS)));
      bandOf[led.globalIndex] = count + led.tree * REGION_BANDS + band;
      treeOf[led.globalIndex] = count + trees * REGION_BANDS + led.tree;
    }
    this.levels = [bandOf, treeOf];
    const units = count + trees * (REGION_BANDS + 1);
    this.size = new Float32Array(units); // LEDs per region unit
    for (const level of this.levels) for (let i = 0; i < count; i++) this.size[level[i]]++;
    this.sumLuma = new Float32Array(units);
    this.sumRed = new Float32Array(units);
    this.held = new Uint8Array(units);

    this.luma = new Tracker(units, LUMA_STEP);
    this.red = new Tracker(units, RED_STEP);
  }

  // The guarded counterpart of a subarray of the effect buffer (e.g. one tree's pixels).
  view(sub) {
    const start = sub.byteOffset - this.target.byteOffset;
    return this.shown.subarray(start, start + sub.length);
  }

  update(dt) {
    const { target, state, next, shown, accept, count, levels, size, sumLuma, sumRed, held } =
      this;
    if (!count) return;
    this.time += dt;

    // LEDs: hold any whose candidate colour would be a reversal it has no allowance for.
    for (let led = 0, i = 0; led < count; led++, i += 3) {
      const r = SEEN[target[i]], g = SEEN[target[i + 1]], b = SEEN[target[i + 2]];
      const hold = this._blocked(led, luminance(r, g, b), redness(r, g, b));
      accept[led] = hold ? 0 : 1;
      next[i] = hold ? state[i] : r;
      next[i + 1] = hold ? state[i + 1] : g;
      next[i + 2] = hold ? state[i + 2] : b;
    }

    // Regions, finest first: hold every LED of a region whose candidate average would be a
    // reversal it has no allowance for. Holding is all-or-nothing, so what's shown is always
    // either the candidate or the previous frame, and tracking it below stays within the limit.
    for (const level of levels) {
      this._sum(next, level);
      held.fill(0);
      for (let i = 0; i < count; i++) {
        const u = level[i];
        if (held[u]) continue;
        held[u] = this._blocked(u, sumLuma[u] / size[u], sumRed[u] / size[u]) ? 2 : 1;
      }
      for (let led = 0, i = 0; led < count; led++, i += 3) {
        if (held[level[led]] !== 2) continue;
        accept[led] = 0;
        next[i] = state[i];
        next[i + 1] = state[i + 1];
        next[i + 2] = state[i + 2];
      }
    }

    state.set(next);
    for (let led = 0, i = 0; led < count; led++, i += 3) {
      if (!accept[led]) continue;
      shown[i] = target[i];
      shown[i + 1] = target[i + 1];
      shown[i + 2] = target[i + 2];
    }

    // Track reversals on what is shown, for every unit.
    for (let led = 0, i = 0; led < count; led++, i += 3) {
      const r = state[i], g = state[i + 1], b = state[i + 2];
      this._track(led, luminance(r, g, b), redness(r, g, b));
    }
    for (const level of levels) {
      this._sum(state, level);
      held.fill(0);
      for (let i = 0; i < count; i++) {
        const u = level[i];
        if (held[u]) continue;
        held[u] = 1;
        this._track(u, sumLuma[u] / size[u], sumRed[u] / size[u]);
      }
    }
  }

  // Whether moving unit u to these values would reverse a measure too soon.
  _blocked(u, l, red) {
    return this.luma.blocked(u, l, this.time) || this.red.blocked(u, red, this.time);
  }

  _track(u, l, red) {
    this.luma.track(u, l, this.time);
    this.red.track(u, red, this.time);
  }

  // Per-region sums of luminance and redness of a frame, for one level.
  _sum(frame, level) {
    const { sumLuma, sumRed, count } = this;
    for (let i = 0; i < count; i++) sumLuma[level[i]] = sumRed[level[i]] = 0;
    for (let led = 0, i = 0; led < count; led++, i += 3) {
      const r = frame[i], g = frame[i + 1], b = frame[i + 2];
      sumLuma[level[led]] += luminance(r, g, b);
      sumRed[level[led]] += redness(r, g, b);
    }
  }
}

// Zigzag (hysteresis) tracking of one measure per unit: a reversal is a move of at least `step`
// against the current direction from the last extreme (or a first move of that size). Keeps
// the times of each unit's last two reversals to space them out.
class Tracker {
  constructor(count, step) {
    this.step = step;
    this.extreme = new Float32Array(count);
    this.dir = new Int8Array(count); // 1 up, -1 down, 0 no move yet
    this.times = new Float64Array(count * 2).fill(-Infinity);
    this.older = new Uint8Array(count); // which of the two slots holds the older time
  }

  isReversal(u, v) {
    const e = this.extreme[u];
    if (this.dir[u] === 1) return v <= e - this.step;
    if (this.dir[u] === -1) return v >= e + this.step;
    return Math.abs(v - e) >= this.step;
  }

  // Whether moving to v would be a reversal within 1/MAX_FLASHES s of the one before last.
  blocked(u, v, time) {
    return this.isReversal(u, v) && time - this.times[u * 2 + this.older[u]] < 1 / MAX_FLASHES;
  }

  // Updates the extreme for a shown value, recording it if it's a reversal.
  track(u, v, time) {
    const dir = this.dir[u];
    if (dir === 1 ? v > this.extreme[u] : dir === -1 && v < this.extreme[u]) {
      this.extreme[u] = v; // continuing in the same direction: new extreme
      return;
    }
    if (!this.isReversal(u, v)) return;
    this.dir[u] = v > this.extreme[u] ? 1 : -1;
    this.extreme[u] = v;
    this.times[u * 2 + this.older[u]] = time;
    this.older[u] ^= 1;
  }
}

// Relative luminance and the WCAG red-flash measure, from linear RGB.
function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function redness(r, g, b) {
  return Math.max(0, r - g - b);
}
