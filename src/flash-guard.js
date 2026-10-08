import { GLOW_GAIN, LUT, bulbColor } from './leds.js';
import { GLOW_LEDS, NEEDLE_GLOW_RESPONSE, NEEDLE_GLOW_RESPONSE_MIN } from './tree.js';

// Photosensitivity guard between the effects and the display. Effects are arbitrary files and
// can strobe, so everything that is drawn (bulbs, halos, leaf glow, tree lights) reads the
// guarded copy, never the effect's pixel buffer. The effect buffer itself is untouched, so
// effects that rely on it persisting between frames behave exactly as before.
//
// Modelled on WCAG 2.3's flash rule: nothing flashes more than 3 times in any second, a flash
// being a pair of opposite changes of 10% or more in relative luminance, or of 20/320 in linear
// R − G − B (the "red flash" measure, which also catches red ↔ green swaps at equal
// luminance). Both kinds count towards the same limit.
//
// It's applied to each thing that's drawn, measured as drawn:
// - each LED's bulb, via the same bulbColor the renderer uses;
// - each LED's halo, at its peak (GLOW_GAIN × the LED's linear color);
// - each needle spray's leaf glow: the weighted sum of its LEDs' colors through the needles'
//   per-channel response, taking the response that gives the most luminance (the brightest)
//   and, for redness, the most red-leaning one (the most red, least green and blue) (only
//   while leaf glow is on);
// - each REGION_BANDS-th of each tree's height and each whole tree, so plain block flashing is
//   caught: its bulbs' average, and its glow from its average color × the larger of
//   HALO_OVERLAP halos' worth of halo peak (halos are additive) and the tree light, which
//   emits TREE_LIGHT_GAIN × that average (main.js). A region only counts its own LEDs, so
//   changes elsewhere can't cancel it out.
// Glow values are uncapped, so changes between bright values still count. Measured at full
// brightness; the brightness control is applied after this.
//
// A flash edge is a reversal of either measure by a flash-sized step. A thing's luminance and
// redness often cross their thresholds a frame or two apart for one change, so a reversal of a
// measure that wasn't part of the last edge, in the same direction as the other measure's in
// it and within MERGE s, counts as part of that edge (a measure's own up-and-down never does).
// Each edge must come at least EDGE_SPACING s after the edge before last, which spaces flashes
// out evenly and allows at most MAX_FLASHES in any second, while a single quick flash
// (a sparkle: up then straight back down) passes. A change that would come too soon is held
// back: the LED, or every LED in the spray or region, keeps its colour until it's allowed.
// Other changes pass untouched, so effects that stay under the limit look exactly as written.
//
// It isn't watertight: a pattern that balances one part of a region against another, with
// groups taking turns, can still flash a large area, and denser halo overlap (a tree seen from
// far away) can add up to more than allowed for.
const LUMA_STEP = 0.1;
const RED_STEP = 20 / 320;
const MAX_FLASHES = 3;
const MERGE = 0.1;
// 1/MAX_FLASHES plus a 20% margin, after allowing for a merged reversal coming up to MERGE s
// after its edge: an independent measurement of the same output can place a reversal a few
// frames differently (where values sit right at a threshold), and should still count at most
// MAX_FLASHES in any second.
const EDGE_SPACING = (1.2 + MERGE) / MAX_FLASHES;
const REGION_BANDS = 4;
const HALO_OVERLAP = 2;
export const TREE_LIGHT_GAIN = 1.2;
const REGION_GLOW_GAIN = Math.max(HALO_OVERLAP * GLOW_GAIN, TREE_LIGHT_GAIN);
const [RESPONSE_R, RESPONSE_G, RESPONSE_B] = NEEDLE_GLOW_RESPONSE;
// The most red-leaning needle response: no needle's glow redness is above this one's.
const [RED_LEAN_G, RED_LEAN_B] = [NEEDLE_GLOW_RESPONSE_MIN[1], NEEDLE_GLOW_RESPONSE_MIN[2]];
// Leaf glow luminance per unit of spray weight, for a fully lit white LED (the most it can be).
const LEAF_LUMA_MAX = 0.2126 * RESPONSE_R + 0.7152 * RESPONSE_G + 0.0722 * RESPONSE_B;
// Per LED: halo luminance and redness, bulb ditto, then linear RGB (for sums).
const V = 7;

export class FlashGuard {
  // `pixels` is the shared effect buffer; `leds` the model's LEDs (tree, h, globalIndex);
  // `foliages` each tree's foliage, with its sprays' LED indices and weights.
  constructor(pixels, leds, foliages) {
    const count = pixels.length / 3;
    this.target = pixels;
    this.count = count;
    this.time = 0;
    this.started = false; // whether a frame has been shown yet
    this.leafGlow = true; // whether leaf glow is drawn; sprays only hold changes back if so
    // Each LED shows either the effect's colour or its previous one. `shown` holds those bytes;
    // `state` and `next` the values (V per LED) of the shown and candidate colours.
    this.shown = new Uint8ClampedArray(pixels.length);
    this.state = new Float32Array(count * V);
    this.next = new Float32Array(count * V);
    this.accept = new Uint8Array(count); // whether each LED takes its candidate this frame
    this.bulb = new Float32Array(3);
    const black = new Uint8Array(pixels.length); // what's shown before the first frame
    for (let led = 0; led < count; led++) this._values(black, led, this.state);
    this.next.set(this.state);

    // Sprays: up to GLOW_LEDS LED indices (-1 = none) and weights each, and their leaf glow
    // measures (luminance, redness) for `next`. For each LED, the sprays it's in:
    // ledSprays[from[i]..from[i + 1]]. Only sprays whose glow can change by a flash-sized step
    // are kept: the rest are too far from any LED for it to matter.
    const ledIndex = [], ledWeight = [];
    for (const f of foliages) {
      for (let k = 0; k < f.ledIndex.length; k += GLOW_LEDS) {
        let weight = 0;
        for (let j = k; j < k + GLOW_LEDS && f.ledIndex[j] >= 0; j++) weight += f.ledWeight[j];
        if (weight * LEAF_LUMA_MAX < LUMA_STEP && weight * RESPONSE_R < RED_STEP) continue;
        ledIndex.push(...f.ledIndex.subarray(k, k + GLOW_LEDS));
        ledWeight.push(...f.ledWeight.subarray(k, k + GLOW_LEDS));
      }
    }
    this.sprayLed = Int32Array.from(ledIndex);
    this.sprayWeight = Float32Array.from(ledWeight);
    const sprays = (this.sprays = this.sprayLed.length / GLOW_LEDS);
    this.sprayM = new Float32Array(sprays * 2);
    this.from = new Int32Array(count + 1);
    for (const led of this.sprayLed) if (led >= 0) this.from[led + 1]++;
    for (let i = 0; i < count; i++) this.from[i + 1] += this.from[i];
    this.ledSprays = new Int32Array(this.from[count]);
    const fill = this.from.slice(0, count);
    this.sprayLed.forEach((led, k) => {
      if (led >= 0) this.ledSprays[fill[led]++] = Math.floor(k / GLOW_LEDS);
    });
    // Sprays touched by changing LEDs this frame (only those can change), and work lists.
    this.active = new Int32Array(sprays);
    this.pass = new Int32Array(sprays);
    this.queue = new Int32Array(sprays);
    this.queueLength = 0;
    this.listed = new Int32Array(sprays); // frame a spray was last listed as active
    this.queued = new Int32Array(sprays); // pass a spray was last queued for
    this.frame = 0;
    this.passId = 0;

    // Regions: each LED's band and tree; `members` list each region's LEDs.
    const trees = leds.reduce((t, led) => Math.max(t, led.tree + 1), 0);
    const bandOf = new Uint32Array(count);
    const treeOf = new Uint32Array(count);
    for (const led of leds) {
      const band = Math.min(REGION_BANDS - 1, Math.max(0, Math.floor(led.h * REGION_BANDS)));
      bandOf[led.globalIndex] = led.tree * REGION_BANDS + band;
      treeOf[led.globalIndex] = trees * REGION_BANDS + led.tree;
    }
    this.levels = [bandOf, treeOf];
    const regions = (this.regions = trees * (REGION_BANDS + 1));
    this.members = Array.from({ length: regions }, () => []);
    for (const level of this.levels) for (let i = 0; i < count; i++) this.members[level[i]].push(i);
    this.sums = new Float32Array(regions * V); // per region: the sum of its LEDs' values
    this.rm = new Float32Array(4); // a region's light luminance, redness, bulb ditto

    // Things that are tracked ("units"): halos, bulbs, sprays, region glows, region bulbs.
    this.HALO = 0;
    this.BULB = count;
    this.SPRAY = 2 * count;
    this.REGION_GLOW = 2 * count + sprays;
    this.REGION_BULB = this.REGION_GLOW + regions;
    this.units = new Units(this.REGION_BULB + regions);
  }

  // The guarded counterpart of a subarray of the effect buffer (e.g. one tree's pixels).
  view(sub) {
    const start = sub.byteOffset - this.target.byteOffset;
    return this.shown.subarray(start, start + sub.length);
  }

  update(dt) {
    const { target, shown, state, next, accept, count, members, units, sprayM } = this;
    if (!count) return;
    const time = (this.time += dt);
    const frame = ++this.frame;
    const seed = !this.started;
    this.started = true;

    // LEDs: hold any whose bulb or halo would make a flash edge it has no allowance for. Note
    // the sprays of LEDs whose colour changes: only those can change.
    let activeLength = 0;
    for (let led = 0, i = 0; led < count; led++, i += 3) {
      const same =
        target[i] === shown[i] && target[i + 1] === shown[i + 1] && target[i + 2] === shown[i + 2];
      if (same) {
        accept[led] = 0; // unchanged: nothing to do
        continue;
      }
      this._values(target, led, next);
      const o = led * V;
      accept[led] = 1;
      if (
        units.blocked(this.HALO + led, next[o], next[o + 1], time) ||
        units.blocked(this.BULB + led, next[o + 2], next[o + 3], time)
      ) {
        accept[led] = 0;
        for (let k = 0; k < V; k++) next[o + k] = state[o + k];
      }
      for (let j = this.from[led]; j < this.from[led + 1]; j++) {
        const s = this.ledSprays[j];
        if (this.listed[s] === frame) continue;
        this.listed[s] = frame;
        this.active[activeLength++] = s;
      }
    }
    if (seed) {
      activeLength = 0;
      for (let s = 0; s < this.sprays; s++) this.active[activeLength++] = s;
    }
    this._sumRegions(next);
    this._sprayMeasures(this.active, activeLength);

    // Sprays and regions: hold every LED of one that would make an edge it has no allowance
    // for. An LED can be in several, so holding one can change another; repeat, re-checking
    // only what changed, until nothing new is held. Holding only ever reverts LEDs to the
    // previous frame, so this ends, and everything then shows either a checked candidate or
    // its previous frame.
    this.pass.set(this.active.subarray(0, activeLength));
    let passLength = activeLength;
    for (let changed = true; changed; ) {
      changed = false;
      this.queueLength = 0;
      this.passId++;
      if (this.leafGlow) {
        for (let p = 0; p < passLength; p++) {
          const s = this.pass[p];
          if (!units.blocked(this.SPRAY + s, sprayM[s * 2], sprayM[s * 2 + 1], time)) continue;
          for (let k = s * GLOW_LEDS; k < (s + 1) * GLOW_LEDS; k++) {
            const led = this.sprayLed[k];
            if (led < 0 || !accept[led]) continue;
            this._hold(led);
            changed = true;
          }
        }
      }
      for (let r = 0; r < this.regions; r++) {
        const m = this._regionMeasures(r);
        if (
          !units.blocked(this.REGION_GLOW + r, m[0], m[1], time) &&
          !units.blocked(this.REGION_BULB + r, m[2], m[3], time)
        ) {
          continue;
        }
        for (const led of members[r]) {
          if (!accept[led]) continue;
          this._hold(led);
          changed = true;
        }
      }
      // Next pass: the sprays whose LEDs were just held.
      [this.pass, this.queue] = [this.queue, this.pass];
      passLength = this.queueLength;
      this._sprayMeasures(this.pass, passLength);
    }

    for (let led = 0, i = 0; led < count; led++, i += 3) {
      if (!accept[led]) continue;
      shown[i] = target[i];
      shown[i + 1] = target[i + 1];
      shown[i + 2] = target[i + 2];
      for (let k = led * V; k < led * V + V; k++) state[k] = next[k];
    }

    // Track flash edges on what is shown (now `state`, which the spray measures and region
    // sums above describe). Unchanged LEDs and sprays have nothing new to track. The first
    // frame only sets the starting values: nothing was shown before it, so it isn't a change.
    for (let led = 0; led < count; led++) {
      if (!accept[led] && !seed) continue;
      const o = led * V;
      units.track(this.HALO + led, state[o], state[o + 1], time, seed);
      units.track(this.BULB + led, state[o + 2], state[o + 3], time, seed);
    }
    units.trackList(this.SPRAY, this.active, activeLength, sprayM, time, seed);
    for (let r = 0; r < this.regions; r++) {
      const m = this._regionMeasures(r);
      units.track(this.REGION_GLOW + r, m[0], m[1], time, seed);
      units.track(this.REGION_BULB + r, m[2], m[3], time, seed);
    }
  }

  // An LED's values for its colour in `pixels`, written to out[led * V ...].
  _values(pixels, led, out) {
    const i = led * 3, o = led * V, bulb = this.bulb;
    const r = LUT[pixels[i]], g = LUT[pixels[i + 1]], b = LUT[pixels[i + 2]];
    bulbColor(r, g, b, bulb, 0);
    out[o] = GLOW_GAIN * luminance(r, g, b);
    out[o + 1] = GLOW_GAIN * redness(r, g, b);
    out[o + 2] = luminance(bulb[0], bulb[1], bulb[2]);
    out[o + 3] = redness(bulb[0], bulb[1], bulb[2]);
    out[o + 4] = r;
    out[o + 5] = g;
    out[o + 6] = b;
  }

  // Reverts an LED's candidate to its previous colour, keeping region sums up to date and
  // queueing its sprays for a re-check.
  _hold(led) {
    const { next, state, sums } = this, o = led * V;
    this.accept[led] = 0;
    for (const level of this.levels) {
      const s = level[led] * V;
      for (let k = 0; k < V; k++) sums[s + k] += state[o + k] - next[o + k];
    }
    for (let k = 0; k < V; k++) next[o + k] = state[o + k];
    for (let j = this.from[led]; j < this.from[led + 1]; j++) {
      const s = this.ledSprays[j];
      if (this.queued[s] === this.passId) continue;
      this.queued[s] = this.passId;
      this.queue[this.queueLength++] = s;
    }
  }

  // Leaf glow measures from `next` for the sprays list[0..length), into sprayM: their weighted
  // LED colours through the needle response.
  _sprayMeasures(list, length) {
    const next = this.next, sprayLed = this.sprayLed, sprayWeight = this.sprayWeight;
    const sprayM = this.sprayM;
    for (let p = 0; p < length; p++) {
      const s = list[p];
      let r = 0, g = 0, b = 0;
      for (let k = s * GLOW_LEDS, end = k + GLOW_LEDS; k < end; k++) {
        const led = sprayLed[k];
        if (led < 0) break;
        const w = sprayWeight[k], o = led * V;
        r += next[o + 4] * w;
        g += next[o + 5] * w;
        b += next[o + 6] * w;
      }
      const red = r * RESPONSE_R - g * RED_LEAN_G - b * RED_LEAN_B;
      sprayM[s * 2] = 0.2126 * r * RESPONSE_R + 0.7152 * g * RESPONSE_G + 0.0722 * b * RESPONSE_B;
      sprayM[s * 2 + 1] = red > 0 ? red : 0;
    }
  }

  // Each region's sum of its LEDs' values in a frame.
  _sumRegions(frame) {
    const { sums, count } = this;
    sums.fill(0);
    for (const level of this.levels) {
      for (let led = 0; led < count; led++) {
        const s = level[led] * V, o = led * V;
        for (let k = 0; k < V; k++) sums[s + k] += frame[o + k];
      }
    }
  }

  // Region r's measures (from its sums): glow from its average linear colour, bulbs as the
  // average of its LEDs' bulb measures.
  _regionMeasures(r) {
    const { sums, rm } = this, s = r * V, n = this.members[r].length;
    const red = sums[s + 4] / n, green = sums[s + 5] / n, blue = sums[s + 6] / n;
    rm[0] = REGION_GLOW_GAIN * luminance(red, green, blue);
    rm[1] = REGION_GLOW_GAIN * redness(red, green, blue);
    rm[2] = sums[s + 2] / n;
    rm[3] = sums[s + 3] / n;
    return rm;
  }
}

// Flash edge tracking for many units, each with two measures (luminance, redness): per
// measure, zigzag tracking (the last extreme and the direction since it) and its direction in
// the unit's last edge (0 if it wasn't part of it); per unit, the times of its last two edges.
class Units {
  constructor(n) {
    this.extreme = new Float32Array(n * 2);
    this.dir = new Int8Array(n * 2); // 1 up, -1 down, 0 no move yet
    this.inEdge = new Int8Array(n * 2);
    this.edges = new Float64Array(n * 2).fill(-Infinity);
    this.older = new Uint8Array(n); // which of the two slots holds the older time
  }

  // Whether moving unit u to luminance l and redness red would be a flash edge within
  // EDGE_SPACING s of its edge before last.
  blocked(u, l, red, time) {
    const i = u * 2, older = this.older[u];
    if (time - this.edges[i + older] >= EDGE_SPACING) return false;
    const dl = reversal(this.extreme, this.dir, i, l, LUMA_STEP);
    const dr = reversal(this.extreme, this.dir, i + 1, red, RED_STEP);
    return isNewEdge(dl, dr, time - this.edges[i + (older ^ 1)], this.inEdge, i);
  }

  // Records reversals dl, dr (0 = none) of unit u's measures at `time`: a new flash edge, or
  // part of the last one.
  _record(u, dl, dr, time) {
    if (!dl && !dr) return;
    const i = u * 2, older = this.older[u], inEdge = this.inEdge;
    if (isNewEdge(dl, dr, time - this.edges[i + (older ^ 1)], inEdge, i)) {
      this.edges[i + older] = time;
      this.older[u] = older ^ 1;
      inEdge[i] = dl;
      inEdge[i + 1] = dr;
    } else {
      if (dl) inEdge[i] = dl;
      if (dr) inEdge[i + 1] = dr;
    }
  }

  // track() for units base + list[0..length), with measures m[s * 2], m[s * 2 + 1]: the same
  // logic inlined, as it runs for thousands of sprays a frame.
  trackList(base, list, length, m, time, seed) {
    const { extreme, dir } = this;
    for (let p = 0; p < length; p++) {
      const s = list[p], u = base + s, i = u * 2, l = m[s * 2], red = m[s * 2 + 1];
      if (seed) {
        extreme[i] = l;
        extreme[i + 1] = red;
        continue;
      }
      let e = extreme[i], d = dir[i];
      const dl =
        d === 1 ? (l <= e - LUMA_STEP ? -1 : 0)
        : d === -1 ? (l >= e + LUMA_STEP ? 1 : 0)
        : l >= e + LUMA_STEP ? 1 : l <= e - LUMA_STEP ? -1 : 0;
      if (dl) {
        dir[i] = dl;
        extreme[i] = l;
      } else if (d === 1 ? l > e : d === -1 && l < e) {
        extreme[i] = l;
      }
      e = extreme[i + 1];
      d = dir[i + 1];
      const dr =
        d === 1 ? (red <= e - RED_STEP ? -1 : 0)
        : d === -1 ? (red >= e + RED_STEP ? 1 : 0)
        : red >= e + RED_STEP ? 1 : red <= e - RED_STEP ? -1 : 0;
      if (dr) {
        dir[i + 1] = dr;
        extreme[i + 1] = red;
      } else if (d === 1 ? red > e : d === -1 && red < e) {
        extreme[i + 1] = red;
      }
      if (dl || dr) this._record(u, dl, dr, time);
    }
  }

  // Updates unit u's extremes for its shown luminance and redness, recording a flash edge if
  // they make one. `seed` only sets the starting values.
  track(u, l, red, time, seed) {
    const extreme = this.extreme, dir = this.dir, i = u * 2;
    if (seed) {
      extreme[i] = l;
      extreme[i + 1] = red;
      return;
    }
    const dl = reversal(extreme, dir, i, l, LUMA_STEP);
    const dr = reversal(extreme, dir, i + 1, red, RED_STEP);
    follow(extreme, dir, i, l, dl);
    follow(extreme, dir, i + 1, red, dr);
    this._record(u, dl, dr, time);
  }
}

// The direction (1 or -1) in which moving measure i to v reverses it by at least `step` from
// its last extreme (or first moves it that far), else 0.
function reversal(extreme, dir, i, v, step) {
  const e = extreme[i], d = dir[i];
  if (d === 1) return v <= e - step ? -1 : 0;
  if (d === -1) return v >= e + step ? 1 : 0;
  return v >= e + step ? 1 : v <= e - step ? -1 : 0;
}

// Whether reversals in directions dl, dr (0 = none) are a new flash edge, given the time since
// the last edge and the measures' directions in it (inEdge[i], inEdge[i + 1]). A reversal is
// part of the last edge only within MERGE s, if its measure wasn't part of that edge and it
// goes the same way as the other measure did.
function isNewEdge(dl, dr, sinceLast, inEdge, i) {
  if (!dl && !dr) return false;
  if (sinceLast >= MERGE) return true;
  if (dl && (inEdge[i] !== 0 || dl !== inEdge[i + 1])) return true;
  return dr !== 0 && (inEdge[i + 1] !== 0 || dr !== inEdge[i]);
}

// Moves measure i's extreme for value v, given its reversal direction d (0 if none).
function follow(extreme, dir, i, v, d) {
  if (d) {
    dir[i] = d;
    extreme[i] = v;
  } else if (dir[i] === 1 ? v > extreme[i] : dir[i] === -1 && v < extreme[i]) {
    extreme[i] = v; // continuing in the same direction: new extreme
  }
}

// Relative luminance and the WCAG red-flash measure, from linear RGB.
function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function redness(r, g, b) {
  return Math.max(0, r - g - b);
}
