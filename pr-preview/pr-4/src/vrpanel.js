import * as THREE from 'three';
import { createLabel } from './label.js';

const W = 512;
const H = 640;
const ROW_H = 52;
const ROWS_TOP = 80;
const VISIBLE_ROWS = Math.floor((H - ROWS_TOP - 96) / ROW_H); // leave room for error + footer

// Menu attached above the left controller. Y toggles it; while open, the left stick
// selects a row (up/down) and changes its value (left/right).
export class VRPanel {
  constructor(app) {
    this.app = app;
    this.selected = 0;
    this.scroll = 0; // first visible row
    this.fps = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const width = 0.2;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, (width * H) / W),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, fog: false }),
    );
    this.mesh.position.set(0, 0.13, -0.03);
    this.mesh.rotation.x = -0.5;
    this.mesh.visible = false;

    // Small always-on FPS readout above the controller (hidden while the full menu is open).
    this.fpsBadge = createLabel(0.1);
    this.fpsBadge.position.set(0, 0.05, -0.02);

    const redraw = () => this.draw();
    app.effects.addEventListener('change', redraw);
    app.effects.addEventListener('params', redraw);
  }

  get open() {
    return this.mesh.visible;
  }

  attachTo(object) {
    object.add(this.mesh, this.fpsBadge);
  }

  toggle() {
    this.mesh.visible = !this.mesh.visible;
    this.fpsBadge.visible = !this.mesh.visible;
    this.draw();
  }

  rows() {
    const { app } = this;
    const { effects } = app;
    const runner = app.runner();
    const rows = [
      { label: 'Tree', value: app.targetName(), change: (d) => app.cycleTarget(d) },
      { label: 'Effect', value: runner?.def.name ?? '—', change: (d) => app.cycleEffect(d) },
      {
        label: 'Brightness',
        value: `${Math.round(effects.brightness * 100)}%`,
        change: (d) => effects.setBrightness(Math.round((effects.brightness + d * 0.1) * 10) / 10),
      },
      { label: 'Leaf glow', value: app.leafGlow ? 'On' : 'Off', change: () => app.setLeafGlow(!app.leafGlow) },
    ];
    for (const [key, spec] of Object.entries(runner?.def.params ?? {})) {
      const step = spec.step ?? (spec.max - spec.min) / 20;
      rows.push({
        label: spec.label ?? key,
        value: formatValue(runner.params[key]),
        change: (d) => app.setParam(key, stepValue(runner.params[key], d, spec, step)),
      });
    }
    return rows;
  }

  nav(dir) {
    const rows = this.rows();
    if (dir === 'up') this.selected = (this.selected - 1 + rows.length) % rows.length;
    else if (dir === 'down') this.selected = (this.selected + 1) % rows.length;
    else rows[this.selected]?.change(dir === 'right' ? 1 : -1);
    this.draw();
  }

  // target: the headset's refresh rate, used to color the readout.
  setFps(fps, target = 72) {
    this.fps = fps;
    const ratio = fps / target;
    const color = ratio >= 0.95 ? '#7dffa0' : ratio >= 0.8 ? '#ffd36b' : '#ff7070';
    this.fpsBadge.setText(`${Math.round(fps)} fps`, color);
    if (this.open) this.draw();
  }

  draw() {
    if (!this.open) return;
    const { g } = this;
    const rows = this.rows();
    this.selected = Math.min(this.selected, rows.length - 1);

    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10, 16, 32, 0.9)';
    g.beginPath();
    g.roundRect(0, 0, W, H, 28);
    g.fill();

    g.fillStyle = '#ffd36b';
    g.font = '700 34px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('LED Trees', 28, 40);
    g.fillStyle = '#8890a8';
    g.font = '24px system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(`${Math.round(this.fps)} fps`, W - 28, 40);
    g.textAlign = 'left';

    // Scroll so the selected row is always visible.
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + VISIBLE_ROWS) this.scroll = this.selected - VISIBLE_ROWS + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, rows.length - VISIBLE_ROWS));

    g.fillStyle = '#8890a8';
    g.font = '22px system-ui, sans-serif';
    g.textAlign = 'center';
    if (this.scroll > 0) g.fillText('▲', W / 2, ROWS_TOP - 8);
    if (this.scroll + VISIBLE_ROWS < rows.length) g.fillText('▼', W / 2, ROWS_TOP + VISIBLE_ROWS * ROW_H + 8);
    g.textAlign = 'left';

    rows.slice(this.scroll, this.scroll + VISIBLE_ROWS).forEach((row, j) => {
      const i = this.scroll + j;
      const y = ROWS_TOP + j * ROW_H;
      if (i === this.selected) {
        g.fillStyle = 'rgba(80, 110, 200, 0.45)';
        g.beginPath();
        g.roundRect(14, y, W - 28, ROW_H - 6, 12);
        g.fill();
      }
      g.font = '26px system-ui, sans-serif';
      g.fillStyle = '#aab3cc';
      g.fillText(row.label, 30, y + ROW_H / 2 - 3);
      g.textAlign = 'right';
      g.fillStyle = '#ffffff';
      g.fillText(i === this.selected ? `‹ ${row.value} ›` : row.value, W - 30, y + ROW_H / 2 - 3);
      g.textAlign = 'left';
    });

    const error = this.app.runner()?.error;
    g.font = '20px system-ui, sans-serif';
    if (error) {
      g.fillStyle = '#ff8080';
      g.fillText(`Error: ${error}`.slice(0, 44), 28, H - 70);
    }
    g.fillStyle = '#8890a8';
    g.fillText('Stick: select / change   A/B: next/prev effect', 28, H - 32);
    this.texture.needsUpdate = true;
  }
}

// One step up/down on the grid min, min + step, min + 2·step, ..., clamped to [min, max].
function stepValue(value, d, spec, step) {
  const index = Math.round((value - spec.min) / step) + d;
  const v = Math.min(spec.max, Math.max(spec.min, spec.min + index * step));
  return Number(v.toFixed(10)); // drop float noise like 0.30000000000000004
}

function formatValue(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
