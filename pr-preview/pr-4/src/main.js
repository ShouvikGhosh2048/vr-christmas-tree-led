import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildModel } from './model.js';
import {
  createTreeMesh,
  drapeStripsOnFoliage,
  bindFoliageToLeds,
  updateFoliageGlow,
  clearFoliageGlow,
} from './tree.js';
import { LedView, averageColor, createWire } from './leds.js';
import { EffectManager } from './effects.js';
import { FlashGuard, TREE_LIGHT_GAIN } from './flash-guard.js';

import { createEnvironment } from './environment.js';
import { createLabel } from './label.js';
import { Locomotion } from './locomotion.js';
import { VRPanel } from './vrpanel.js';
import { createDesktopUI } from './desktop-ui.js';

const TREE_LIGHT_RANGE = 3.5; // meters; each tree's light fades out by this distance

// Per-viewer preferences remembered in this browser (may be unavailable, e.g. private mode).
function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`led-trees.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(`led-trees.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

async function main() {
  const res = await fetch('config/scene.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load config/scene.json (${res.status})`);
  const config = await res.json();

  // --- Renderer, scene, camera ---------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);
  const env = createEnvironment(scene);

  // In VR the camera and controllers live inside this rig; locomotion moves the rig.
  const rig = new THREE.Group();
  scene.add(rig);
  const spawn = new THREE.Vector3(...(config.spawn?.position ?? [0, 0, 1.5]));

  // --- Trees and LEDs ------------------------------------------------------------------------
  const model = buildModel(config);

  // Trees first: LEDs are draped onto the generated foliage before anything uses their positions.
  const treeViews = model.trees.map((tree) => {
    const { group, foliage } = createTreeMesh(tree);
    drapeStripsOnFoliage(tree, foliage);
    bindFoliageToLeds(foliage, tree.leds);
    scene.add(group);
    for (const strip of tree.strips) scene.add(createWire(strip));

    // No distance falloff (decay 0), so nothing it lights gets more than the light's own color
    // (the flash guard relies on that); `distance` still fades it out smoothly.
    const light = new THREE.PointLight(0xffffff, 0, TREE_LIGHT_RANGE, 0);
    light.position.set(tree.position[0], tree.position[1] + tree.height * 0.35, tree.position[2]);
    scene.add(light);

    const label = createLabel();
    label.position.set(tree.position[0], tree.position[1] + tree.height + 0.35, tree.position[2]);
    scene.add(label);
    return { tree, foliage, light, label, avg: new THREE.Color() };
  });

  const ledView = new LedView(model.leds);
  // Everything drawn reads the flash-limited copy of the effect pixels.
  const guard = new FlashGuard(model.pixels, model.leds, treeViews.map((view) => view.foliage));
  scene.add(ledView.object);

  // --- Effects -------------------------------------------------------------------------------
  const effects = new EffectManager(model);
  await effects.loadAll();
  if (!effects.list.length) throw new Error(`No effects loaded.\n${effects.loadErrors.join('\n')}`);

  const assign = config.effects ?? {};
  model.trees.forEach((tree, i) => {
    const wanted = assign.trees?.[tree.id] ?? assign.default;
    effects.setEffect(i, effects.effects.has(wanted) ? wanted : effects.list[0]);
  });

  // Shared controller for the desktop panel and the VR menu.
  const app = {
    model,
    effects,
    target: 'all', // 'all' or a tree index
    targets() {
      return this.target === 'all' ? model.trees.map((_, i) => i) : [this.target];
    },
    targetName() {
      return this.target === 'all' ? 'All trees' : model.trees[this.target].id;
    },
    runner() {
      return effects.runners[this.targets()[0]];
    },
    setTarget(target) {
      this.target = target;
      effects.dispatchEvent(new Event('change'));
    },
    cycleTarget(d) {
      const options = ['all', ...model.trees.map((_, i) => i)];
      const i = options.indexOf(this.target);
      this.setTarget(options[(i + d + options.length) % options.length]);
    },
    setEffect(id) {
      for (const i of this.targets()) effects.setEffect(i, id);
    },
    cycleEffect(d) {
      const list = effects.list;
      const i = list.indexOf(this.runner()?.id);
      this.setEffect(list[(i + d + list.length) % list.length]);
    },
    // Parameters belong to an effect, so with "All trees" only trees running the displayed
    // effect change; another effect's same-named parameter may have a different range.
    setParam(key, value) {
      const id = this.runner()?.id;
      for (const i of this.targets()) {
        if (effects.runners[i]?.id === id) effects.setParam(i, key, value);
      }
    },
    leafGlow: loadSetting('leafGlow', true), // LEDs lighting up the needles around them
    setLeafGlow(on) {
      this.leafGlow = on;
      saveSetting('leafGlow', on);
      if (!on) for (const view of treeViews) clearFoliageGlow(view.foliage);
      effects.dispatchEvent(new Event('params'));
    },
  };

  const updateLabels = () => {
    treeViews.forEach((view, i) => {
      const runner = effects.runners[i];
      if (runner?.error) view.label.setText(`⚠ ${runner.def.name}: ${runner.error}`, '#ff8080');
      else view.label.setText(runner?.def.name ?? '', '#e8ecf4');
    });
  };
  effects.addEventListener('change', updateLabels);
  updateLabels();

  const desktopUI = createDesktopUI(document.getElementById('ui'), app);
  desktopUI.setStatus(`${model.leds.length} LEDs`);
  const panel = new VRPanel(app);

  // --- VR input ------------------------------------------------------------------------------
  const locomotion = new Locomotion(renderer, scene, rig, camera, {
    onConnect(hand) {
      if (hand.handedness === 'left') panel.attachTo(hand.grip);
    },
    onButton(name) {
      if (name === 'A') app.cycleEffect(1);
      else if (name === 'B') app.cycleEffect(-1);
      else if (name === 'X') app.cycleTarget(1);
      else if (name === 'Y') {
        panel.toggle();
        locomotion.menuOpen = panel.open;
      }
    },
    onMenuNav(dir) {
      panel.nav(dir);
    },
  });

  // --- Desktop camera ------------------------------------------------------------------------
  // Frame all trees: look at their middle from a bit behind the VR spawn point.
  const center = new THREE.Vector3();
  for (const t of model.trees) center.add(new THREE.Vector3(...t.position));
  center.divideScalar(model.trees.length);
  const tallest = Math.max(...model.trees.map((t) => t.height));
  center.y = tallest * 0.45;
  camera.position.set(spawn.x, 1.7, spawn.z + tallest * 0.8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  const keys = new Set();
  addEventListener('keydown', (e) => {
    if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  function desktopWalk(dt) {
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    if (!f && !r) return;
    camera.getWorldDirection(_fwd).setY(0).normalize();
    _right.crossVectors(_fwd, camera.up);
    const move = _fwd.multiplyScalar(f * 2 * dt).addScaledVector(_right, r * 2 * dt);
    camera.position.add(move);
    controls.target.add(move);
  }

  const savedView = { position: new THREE.Vector3(), target: new THREE.Vector3() };
  renderer.xr.addEventListener('sessionstart', () => {
    savedView.position.copy(camera.position);
    savedView.target.copy(controls.target);
    controls.enabled = false;
    rig.position.copy(spawn);
    rig.rotation.set(0, 0, 0);
    rig.add(camera);
  });
  renderer.xr.addEventListener('sessionend', () => {
    scene.add(camera);
    camera.position.copy(savedView.position);
    controls.target.copy(savedView.target);
    controls.enabled = true;
    controls.update();
    onResize();
  });

  // Only offer VR once the session handlers above exist; entering earlier would skip them.
  document.body.appendChild(VRButton.createButton(renderer));

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  addEventListener('resize', onResize);

  // --- Frame loop ----------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let fpsFrames = 0;
  let fpsTime = 0;

  renderer.setAnimationLoop(() => {
    // Cap the step animations take after a stall, but measure FPS from the real elapsed time.
    const elapsed = clock.getDelta();
    const dt = Math.min(elapsed, 0.1);
    const time = clock.elapsedTime;

    effects.update(time, dt);
    guard.leafGlow = app.leafGlow; // leaf glow only limits changes while it's drawn
    guard.update(elapsed); // real time, so its one-second window matches what's displayed
    ledView.update(guard.shown, effects.brightness);

    for (const view of treeViews) {
      averageColor(guard.view(view.tree.pixels), view.avg).multiplyScalar(effects.brightness);
      if (app.leafGlow) updateFoliageGlow(view.foliage, guard.shown, effects.brightness);
      // The light emits exactly TREE_LIGHT_GAIN × the average color (color scaled to a max
      // channel of 1, intensity carrying the rest), so the flash guard's tree check bounds it.
      const peak = Math.max(view.avg.r, view.avg.g, view.avg.b, 1e-6);
      view.light.color.copy(view.avg).multiplyScalar(1 / peak);
      view.light.intensity = peak * TREE_LIGHT_GAIN;
    }

    env.update(dt);
    if (renderer.xr.isPresenting) {
      locomotion.update(dt);
    } else {
      desktopWalk(dt);
      controls.update();
    }

    fpsFrames++;
    fpsTime += elapsed;
    if (fpsTime >= 0.5) {
      const fps = fpsFrames / fpsTime;
      desktopUI.setFps(fps);
      if (renderer.xr.isPresenting) panel.setFps(fps, renderer.xr.getSession()?.frameRate ?? 72);
      fpsFrames = 0;
      fpsTime = 0;
    }

    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('fatal');
  el.hidden = false;
  el.textContent = `Failed to start:\n${e.message}`;
});
