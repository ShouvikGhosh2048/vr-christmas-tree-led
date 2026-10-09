// A glowing horizontal band that sweeps up through the tree, changing color each pass.
// A "volumetric" effect: it uses led.pos (meters, relative to the tree base), not strip order.

export default {
  name: 'Rising Band',

  params: {
    speed: { value: 0.6, min: 0.1, max: 3, step: 0.1 }, // meters per second
    width: { value: 0.18, min: 0.03, max: 0.8, step: 0.01 }, // meters
    wobble: { value: 0.08, min: 0, max: 0.3, step: 0.01 },
  },

  setup(ctx) {
    ctx.state.pass = -1;
  },

  render(ctx) {
    const { leds, time, params, tree } = ctx;
    const travel = tree.height + params.width * 4;
    const distance = time * params.speed;
    const pass = Math.floor(distance / travel);
    const center = (distance % travel) - params.width * 2;

    if (pass !== ctx.state.pass) {
      ctx.state.pass = pass;
      ctx.state.color = ctx.hsv(pass * 0.17, 0.9, 1);
    }

    for (const led of leds) {
      const y = led.pos.y + Math.sin(led.angle * 3 + time * 2) * params.wobble;
      const d = (y - center) / params.width;
      const k = Math.exp(-d * d);
      led.set(ctx.scale(ctx.state.color, 0.04 + 0.96 * k));
    }
  },
};
