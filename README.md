# vr-christmas-tree-led
A recreation of [Matt Parker's christmas tree video](https://www.youtube.com/watch?v=TvlpIojusBE) in VR.

Christmas trees wrapped in LED strips, running effects you write as plain JavaScript files.
Works in a desktop browser and in VR on Meta Quest (WebXR). No build step: it's static files
served by GitHub Pages, with Three.js loaded from a CDN.

## Running it

**Locally:**

```bash
npx serve -l 3000 .
```

Then open http://localhost:3000. On desktop: drag to orbit, right-drag to pan, WASD to walk.
The panel in the top-left switches effects, tweaks their parameters, sets brightness, toggles
**Leaf glow** (LEDs lighting the needles around them) and shows FPS.

**On the Quest while developing:** plug the headset in via USB (developer mode on), then

```bash
adb reverse tcp:3000 tcp:3000
```

and open `http://localhost:3000` in the Quest browser. `localhost` counts as a secure
origin, so WebXR works without HTTPS. Without a headset, the
[Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik)
Chrome extension lets you test VR controls.

**GitHub Pages:** repo Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
The site appears at `https://<user>.github.io/vr-christmas-tree-led/`. Push to update.

## VR controls (Quest Touch controllers)

| Input | Action |
|---|---|
| Left stick | Move (relative to where you look) |
| Right stick ←/→ | Snap turn 30° |
| Right stick ↑/↓ | Fly up / down |
| Right trigger | Hold to aim teleport arc, release to jump |
| A / B | Next / previous effect |
| X | Cycle which tree the controls apply to (all / each tree) |
| Y | Toggle wrist menu (left stick then selects rows and changes values) |

An FPS readout floats above the left controller: green at ≥95% of the headset's refresh rate,
yellow at ≥80%, red below. If it drops, try turning **Leaf glow** off in the menu.

## Scene config: `config/scene.json`

```jsonc
{
  "spawn": { "position": [0, 0, 2.5] },           // where you stand when entering VR
  "trees": [
    {
      "id": "big",
      "position": [-2.4, 0, -3.8],                 // meters
      "height": 4.5,
      "baseRadius": 1.7,
      "trunkHeight": 0.35,                         // optional, default 12% of height
      "strips": [
        {
          "ledCount": 500,
          "turns": 10,                             // wraps around the tree
          "startHeight": 0.38, "endHeight": 4.42,  // optional
          "offset": 0,                             // from mid-length of the outer needles; - tucks in, + lifts out
          "startAngleDeg": 0                       // optional; offset a second strip with this
        }
      ]
    }
  ],
  "effects": {
    "default": "rainbow-spiral",                   // effect id = file name without .js
    "trees": { "small": "twinkle" }                // per-tree overrides
  }
}
```

A tree can have several strips. LEDs are spaced evenly along each strip's length, like a real strip.

Trees are generated procedurally (seeded, so they look the same every load): a trunk, whorls of
branches and fir-needle sprays. Each strip is wound on the tree's cone and then *draped* onto the
generated foliage, so the lights sit in the branches rather than floating outside them.

## Writing an effect

1. Create `effects/my-effect.js`.
2. Add `"my-effect.js"` to `effects/index.json`. GitHub Pages can't list folders, so this file is the manifest.
3. Click **Reload effects** on desktop (or refresh). On the Quest, refresh the page.

```js
export default {
  name: 'My Effect',

  // Optional. Shows up as sliders on desktop and rows in the VR menu.
  params: {
    speed: { value: 1, min: 0, max: 5, step: 0.1 },
  },

  // Optional. Called once when the effect starts on a tree.
  setup(ctx) {
    ctx.state.offset = ctx.random();
  },

  // Called every frame.
  render(ctx) {
    for (const led of ctx.leds) {
      led.set(ctx.hsv(led.h + ctx.time * ctx.params.speed, 1, 1));
    }
  },
};
```

Each tree runs its own instance of an effect. Keep per-tree data in `ctx.state`, not in
module-level variables, because two trees may run the same module at once.

Effects can `import` shared helper files (e.g. `./palette.js`), but **Reload effects** only
refreshes the effect files themselves. Browsers cache every other module for the lifetime of
the page, so after editing a shared helper, refresh the page. If an effect throws,
only its tree turns dim red and shows the error. Everything else keeps running.

### `ctx`

| Field | |
|---|---|
| `time`, `dt`, `frame` | Seconds since start, seconds since last frame, frame counter |
| `leds` | Every LED on this tree, in strip order |
| `strips` | `[{ index, id, length, lengthMeters, leds, pixels }]` |
| `tree` | `{ id, index, height, baseRadius, position }` |
| `params` | Current parameter values |
| `state` | Your own scratch object, persisted between frames |
| `fill(c)`, `clear()`, `fade(amount)` | Whole-tree helpers. `fade(0.1)` removes 10% (FastLED's `fadeToBlackBy`) |
| `hsv(h, s, v)` | `h` wraps 0..1, `s`/`v` 0..1 → `[r, g, b]` |
| `rgb`, `lerpColor(a, b, t)`, `scale(c, f)` | Color helpers |
| `noise3(x, y, z)` | Smooth 3D noise, 0..1 |
| `random()`, `randomInt(min, max)` | |

### Each LED

| Field | |
|---|---|
| `set(r, g, b)` / `set([r, g, b])` | Channels 0–255 (clamped) |
| `get()` | `[r, g, b]` |
| `index` | Position in `ctx.leds` |
| `strip`, `indexInStrip` | Which strip and where along it (what a real controller addresses) |
| `u` | 0..1 along its strip |
| `h` | 0..1 height within the tree |
| `angle` | 0..2π around the trunk |
| `pos` | `{x, y, z}` meters, relative to the tree base (y up) |

The pixel buffer is persistent: colors stay until you change them, the same as on a FastLED/WLED
controller. Call `ctx.clear()` or `ctx.fade()` if you want a fresh frame.

### Hardware compatibility

Colors are 8-bit RGB in one flat buffer per strip (`strip.pixels`, a `Uint8ClampedArray` of
`r, g, b, r, g, b, ...`), in physical LED order. That's exactly what a WLED/FastLED controller
takes. A tree maps to a controller and a strip maps to an output/segment, so the same effect files
could later drive real LEDs, e.g. by streaming `strip.pixels` to WLED over UDP (DDP / E1.31).

## Project layout

```
index.html            entry point + import map
config/scene.json     trees, strips, default effects
effects/              effect files + index.json manifest
src/
  main.js             bootstrap, render loop, app state
  model.js            trees → strips → LEDs, shared pixel buffer
  strip.js            helix + arc-length resampling
  tree.js             procedural fir, strip draping, LED glow on needles
  leds.js             instanced bulbs + glow halos
  effects.js          effect loader/runner, ctx
  color.js            color + noise helpers
  locomotion.js       VR movement, turning, teleport, buttons
  vrpanel.js          VR wrist menu
  desktop-ui.js       desktop control panel
  environment.js      sky, snow, ground, lights
```
