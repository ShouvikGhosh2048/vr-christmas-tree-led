import * as THREE from 'three';

// LED values are treated as display (sRGB) values; convert to linear for the renderer.
export const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = Math.pow(i / 255, 2.2);

const BULB_RADIUS = 0.008;
const HALO_SIZE = 0.075;
const BULB_OFF = 0.03;

const haloVertex = /* glsl */ `
  attribute vec3 haloColor;
  uniform float size;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    // Camera-facing quad centred on the LED.
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * size;
    vColor = haloColor;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const haloFragment = /* glsl */ `
  uniform float intensity;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = (exp(-d * d * 12.0) + 0.3 * exp(-d * d * 3.0)) * (1.0 - d);
    gl_FragColor = vec4(vColor * a * intensity, 1.0);
    #include <colorspace_fragment>
  }
`;

// Draws every LED in the scene with two instanced meshes (bulbs + additive glow halos),
// i.e. two draw calls no matter how many LEDs there are. Bloom post-processing is avoided
// because it is expensive and unreliable in WebXR.
export class LedView {
  constructor(leds) {
    const n = leds.length;
    this.count = n;

    this.bulbColors = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.bulbColors.setUsage(THREE.DynamicDrawUsage);
    this.haloColors = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.haloColors.setUsage(THREE.DynamicDrawUsage);

    this.bulbs = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BULB_RADIUS, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      n,
    );
    this.bulbs.instanceColor = this.bulbColors;

    const haloGeometry = new THREE.PlaneGeometry(1, 1);
    haloGeometry.setAttribute('haloColor', this.haloColors);
    this.halos = new THREE.InstancedMesh(
      haloGeometry,
      new THREE.ShaderMaterial({
        vertexShader: haloVertex,
        fragmentShader: haloFragment,
        uniforms: { size: { value: HALO_SIZE }, intensity: { value: 1.4 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      n,
    );

    const m = new THREE.Matrix4();
    leds.forEach((led, i) => {
      m.makeTranslation(led.world.x, led.world.y, led.world.z);
      this.bulbs.setMatrixAt(i, m);
      this.halos.setMatrixAt(i, m);
    });
    for (const mesh of [this.bulbs, this.halos]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.needsUpdate = true;
    }

    this.object = new THREE.Group();
    this.object.add(this.bulbs, this.halos);
  }

  update(pixels, brightness) {
    const bulb = this.bulbColors.array;
    const halo = this.haloColors.array;
    for (let i = 0; i < this.count * 3; i++) {
      const v = LUT[pixels[i]] * brightness;
      halo[i] = v;
      bulb[i] = BULB_OFF + v * (1 - BULB_OFF);
    }
    this.bulbColors.needsUpdate = true;
    this.haloColors.needsUpdate = true;
  }
}

// Average linear color of a pixel range, used to tint the foliage and ground near each tree.
export function averageColor(pixels, out) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    r += LUT[pixels[i]];
    g += LUT[pixels[i + 1]];
    b += LUT[pixels[i + 2]];
  }
  const n = pixels.length / 3 || 1;
  return out.setRGB(r / n, g / n, b / n, THREE.LinearSRGBColorSpace);
}

// Strip wire connecting consecutive LEDs.
export function createWire(strip) {
  const positions = strip.leds.flatMap((l) => [l.world.x, l.world.y, l.world.z]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x0b2410 }));
}
