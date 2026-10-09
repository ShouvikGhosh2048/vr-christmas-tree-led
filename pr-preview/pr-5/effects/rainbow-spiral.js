// A rainbow that corkscrews up the tree. Uses each LED's 3D placement (height + angle around
// the trunk), so the stripes follow the tree's shape regardless of how the strip is wound.

export default {
  name: 'Rainbow Spiral',

  params: {
    speed: { value: 0.25, min: -2, max: 2, step: 0.05 },
    twist: { value: 1, min: -4, max: 4, step: 0.25 }, // stripe turns per tree height
    bands: { value: 1, min: 1, max: 6, step: 1 }, // rainbows around the trunk
  },

  render(ctx) {
    const { leds, time, params } = ctx;
    for (const led of leds) {
      const around = (led.angle / (2 * Math.PI)) * params.bands;
      const hue = around + led.h * params.twist - time * params.speed;
      led.set(ctx.hsv(hue, 1, 1));
    }
  },
};
