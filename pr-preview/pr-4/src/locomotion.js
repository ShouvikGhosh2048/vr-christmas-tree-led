import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// Quest Touch controller gamepad layout (xr-standard mapping).
const TRIGGER = 0;
const FACE_BUTTONS = { right: { 4: 'A', 5: 'B' }, left: { 4: 'X', 5: 'Y' } };

const MOVE_SPEED = 2; // m/s
const FLY_SPEED = 1.2; // m/s
const SNAP_ANGLE = Math.PI / 6;
const DEADZONE = 0.15;
const PRESS = 0.7;
const RELEASE = 0.3;
const MAX_HEIGHT = 6;

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _head = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Moves the player rig (the parent of the XR camera and controllers):
//   left stick   smooth move, relative to where you look
//   right stick  left/right snap turn, up/down fly
//   right trigger hold to aim a teleport arc, release to jump
// Face buttons and (while the menu is open) left-stick flicks are forwarded to handlers.
export class Locomotion {
  constructor(renderer, scene, rig, camera, handlers) {
    this.renderer = renderer;
    this.rig = rig;
    this.camera = camera;
    this.handlers = handlers;
    this.menuOpen = false;
    this.hands = { left: null, right: null };

    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      rig.add(ray, grip);

      const hand = { ray, grip, source: null, handedness: null, pressed: {}, latched: false, trigger: false };
      ray.addEventListener('connected', (e) => {
        hand.source = e.data;
        hand.handedness = e.data.handedness;
        this.hands[hand.handedness] = hand;
        handlers.onConnect?.(hand);
      });
      ray.addEventListener('disconnected', () => {
        if (this.hands[hand.handedness] === hand) this.hands[hand.handedness] = null;
        hand.source = null;
        this._hideArc();
      });
    }

    this._createTeleportVisuals(scene);
  }

  update(dt) {
    for (const side of ['left', 'right']) {
      const hand = this.hands[side];
      const gp = hand?.source?.gamepad;
      if (!gp) continue;

      for (const [idx, name] of Object.entries(FACE_BUTTONS[side])) {
        const down = !!gp.buttons[idx]?.pressed;
        if (down && !hand.pressed[idx]) this.handlers.onButton?.(name);
        hand.pressed[idx] = down;
      }

      const sx = gp.axes[2] ?? 0;
      const sy = gp.axes[3] ?? 0;
      if (side === 'left') {
        if (this.menuOpen) this._menuNav(hand, sx, sy);
        else this._move(sx, sy, dt);
      } else {
        this._turnAndFly(hand, sx, sy, dt);
        this._teleport(hand, !!gp.buttons[TRIGGER]?.pressed);
      }
    }
  }

  _move(sx, sy, dt) {
    if (Math.hypot(sx, sy) < DEADZONE) return;
    this.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) return;
    _fwd.normalize();
    _right.crossVectors(_fwd, UP);
    this.rig.position
      .addScaledVector(_fwd, -sy * MOVE_SPEED * dt)
      .addScaledVector(_right, sx * MOVE_SPEED * dt);
  }

  _turnAndFly(hand, sx, sy, dt) {
    if (Math.abs(sx) > PRESS && !hand.latched) {
      hand.latched = true;
      this._rotateAroundHead(-Math.sign(sx) * SNAP_ANGLE);
    } else if (Math.abs(sx) < RELEASE) {
      hand.latched = false;
    }

    if (Math.abs(sy) > RELEASE && Math.abs(sy) > Math.abs(sx)) {
      const y = this.rig.position.y - sy * FLY_SPEED * dt;
      this.rig.position.y = Math.min(MAX_HEIGHT, Math.max(0, y));
    }
  }

  // Rotate around the head, not the rig origin, so the world doesn't swing around you.
  _rotateAroundHead(angle) {
    this.camera.getWorldPosition(_head);
    this.rig.position.sub(_head).applyAxisAngle(UP, angle).add(_head);
    this.rig.rotation.y += angle;
  }

  _menuNav(hand, sx, sy) {
    const mag = Math.max(Math.abs(sx), Math.abs(sy));
    if (mag > PRESS && !hand.latched) {
      hand.latched = true;
      const dir = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'right' : 'left') : sy > 0 ? 'down' : 'up';
      this.handlers.onMenuNav?.(dir);
    } else if (mag < RELEASE) {
      hand.latched = false;
    }
  }

  _createTeleportVisuals(scene) {
    this.arcPoints = 64;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.arcPoints * 3), 3));
    this.arc = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x66ffaa }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.24, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x66ffaa }),
    );
    this.marker.visible = false;
    this.hit = null;
    scene.add(this.arc, this.marker);
  }

  _teleport(hand, triggerDown) {
    if (triggerDown) {
      this._updateArc(hand.ray);
    } else if (hand.trigger) {
      if (this.hit) {
        this.camera.getWorldPosition(_head);
        this.rig.position.x += this.hit.x - _head.x;
        this.rig.position.z += this.hit.z - _head.z;
        this.rig.position.y = 0;
      }
      this._hideArc();
    }
    hand.trigger = triggerDown;
  }

  // Simple ballistic arc from the controller until it hits the ground plane (y = 0).
  _updateArc(ray) {
    const pos = this.arc.geometry.attributes.position;
    ray.getWorldPosition(_p);
    ray.getWorldQuaternion(_q);
    _v.set(0, 0, -1).applyQuaternion(_q).multiplyScalar(7);
    const step = 0.03;
    this.hit = null;
    let count = 0;
    for (let i = 0; i < this.arcPoints; i++) {
      pos.setXYZ(i, _p.x, _p.y, _p.z);
      count = i + 1;
      if (_p.y <= 0) {
        _p.y = 0;
        pos.setXYZ(i, _p.x, 0, _p.z);
        this.hit = _p.clone();
        break;
      }
      _p.addScaledVector(_v, step);
      _v.y -= 9.8 * step;
    }
    pos.needsUpdate = true;
    this.arc.geometry.setDrawRange(0, count);
    this.arc.material.color.set(this.hit ? 0x66ffaa : 0xff6666);
    this.arc.visible = true;
    this.marker.visible = !!this.hit;
    if (this.hit) this.marker.position.copy(this.hit).setY(0.01);
  }

  _hideArc() {
    this.arc.visible = false;
    this.marker.visible = false;
    this.hit = null;
  }
}
