// HTML control panel for the flat-screen view (handy while writing effects).
export function createDesktopUI(root, app) {
  const { effects } = app;
  root.innerHTML = `
    <h1>🎄 LED Trees <span class="fps" data-id="fps"></span></h1>
    <label><span>Tree</span><select data-id="target"></select></label>
    <label><span>Effect</span><select data-id="effect"></select></label>
    <label><span>Brightness <b data-id="brightnessValue"></b></span>
      <input data-id="brightness" type="range" min="0" max="1" step="0.01"></label>
    <label class="check"><input data-id="leafGlow" type="checkbox"> Leaf glow</label>
    <div class="params" data-id="params"></div>
    <div class="error" data-id="error"></div>
    <button data-id="reload" title="Re-import every file in effects/">Reload effects</button>
    <div class="status" data-id="status"></div>
    <details>
      <summary>Controls</summary>
      <b>Desktop</b>
      <ul><li>Drag: orbit · Right-drag: pan · Scroll: zoom</li><li>WASD / arrows: walk</li></ul>
      <b>VR (Quest)</b>
      <ul>
        <li>Left stick: move</li>
        <li>Right stick: snap turn / fly up-down</li>
        <li>Right trigger: aim + release to teleport</li>
        <li>A / B: next / previous effect</li>
        <li>X: switch tree · Y: menu</li>
      </ul>
    </details>`;
  const el = Object.fromEntries([...root.querySelectorAll('[data-id]')].map((e) => [e.dataset.id, e]));

  el.target.addEventListener('change', () => {
    app.setTarget(el.target.value === 'all' ? 'all' : Number(el.target.value));
  });
  el.effect.addEventListener('change', () => app.setEffect(el.effect.value));
  el.brightness.addEventListener('input', () => effects.setBrightness(Number(el.brightness.value)));
  el.leafGlow.addEventListener('change', () => app.setLeafGlow(el.leafGlow.checked));
  el.reload.addEventListener('click', async () => {
    el.reload.disabled = true;
    try {
      await effects.reload();
    } finally {
      el.reload.disabled = false;
    }
  });

  function rebuild() {
    el.target.innerHTML = [
      `<option value="all">All trees</option>`,
      ...app.model.trees.map((t, i) => `<option value="${i}">${t.id}</option>`),
    ].join('');
    el.target.value = String(app.target);

    const runner = app.runner();
    el.effect.innerHTML = effects.list
      .map((id) => `<option value="${id}">${effects.effects.get(id).name}</option>`)
      .join('');
    if (runner) el.effect.value = runner.id;

    el.params.innerHTML = '';
    for (const [key, spec] of Object.entries(runner?.def.params ?? {})) {
      const label = document.createElement('label');
      label.innerHTML = `<span>${spec.label ?? key} <b></b></span><input type="range">`;
      const input = label.querySelector('input');
      const value = label.querySelector('b');
      Object.assign(input, { min: spec.min, max: spec.max, step: spec.step ?? 'any', value: runner.params[key] });
      value.textContent = runner.params[key];
      input.addEventListener('input', () => {
        app.setParam(key, Number(input.value));
        value.textContent = input.value;
      });
      el.params.append(label);
    }

    const errors = [...effects.loadErrors];
    if (runner?.error) errors.unshift(`${runner.def.name} crashed: ${runner.error}`);
    el.error.textContent = errors.join('\n');
    syncSettings();
  }

  function syncSettings() {
    el.brightness.value = effects.brightness;
    el.brightnessValue.textContent = `${Math.round(effects.brightness * 100)}%`;
    el.leafGlow.checked = app.leafGlow;
  }

  effects.addEventListener('change', rebuild);
  effects.addEventListener('params', syncSettings);
  rebuild();

  return {
    setStatus(text) {
      el.status.textContent = text;
    },
    setFps(fps) {
      el.fps.textContent = `${Math.round(fps)} fps`;
    },
  };
}
