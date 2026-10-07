// Random sparkles that fade out. A classic 1D strip effect: it only looks at the pixel buffer,
// and relies on the buffer persisting between frames (like FastLED/WLED).

const WARM_WHITE = [255, 197, 143]; // FastLED's Tungsten40W color temperature
const CLASSIC = [
  [255, 0, 0],
  [0, 200, 0],
  [0, 60, 255],
  [255, 140, 0],
  [180, 0, 255],
];

export default {
  name: 'Twinkle',

  params: {
    rate: { value: 0.4, min: 0.05, max: 3, step: 0.05 }, // sparkles per LED per second
    fade: { value: 2.5, min: 0.5, max: 10, step: 0.5 },
    multicolor: { value: 1, min: 0, max: 1, step: 1 },
  },

  render(ctx) {
    const { leds, params, dt } = ctx;
    ctx.fade(1 - Math.exp(-params.fade * dt));

    const chance = params.rate * dt;
    for (const led of leds) {
      if (ctx.random() < chance) {
        const c = params.multicolor ? CLASSIC[ctx.randomInt(0, CLASSIC.length - 1)] : WARM_WHITE;
        led.set(c);
      }
    }
  },
};
