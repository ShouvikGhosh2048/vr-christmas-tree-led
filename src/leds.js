import * as THREE from 'three';

// LED values are treated as display (sRGB) values; convert to linear for the renderer.
export const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = Math.pow(i / 255, 2.2);

const BULB_RADIUS = 0.008;
const HALO_SIZE = 0.075;
const HALO_INTENSITY = 1.4;
const HALO_PEAK = 1.3; // halo falloff at its centre; keep in sync with haloFragment
// The glow's peak relative to the LED value. The bulb is drawn at that peak (the part of the
// glow it hides) so it reads as the light source rather than a dull disk in front of a
// brighter glow.
const BULB_GAIN = HALO_PEAK * HALO_INTENSITY;
// The glow's peak gain on an LED's linear value; the flash guard measures halos with it.
export const GLOW_GAIN = HALO_PEAK * HALO_INTENSITY;
// Halo pushed this far behind the bulb (along the view ray) so it never draws over it.
// A quad facing the view axis cuts through off-axis bulbs otherwise, lighting a crescent on
// one edge. 2× the radius stays clear up to ~63° off-axis (tan θ < 2).
const HALO_PUSH = 2 * BULB_RADIUS;
// Halos fade out between these eye distances (m). Up close a halo fills much of the view
// (and can outlive its bulb at the near plane), which turns twinkling into large-area flashes.
const HALO_FADE_NEAR = 0.06;
const HALO_FADE_FAR = 0.15;
const BULB_OFF = 0.03;

const haloVertex = /* glsl */ `
  attribute vec3 haloColor;
  uniform float size;
  uniform float push;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    // Camera-facing quad, centred on the LED before the push below.
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // Push it back behind the bulb, growing it to match so its apparent size is unchanged.
    float dist = length(mv.xyz);
    float grow = (dist + push) / dist;
    mv.xyz *= grow;
    mv.xy += position.xy * size * grow;
    float fade = smoothstep(${HALO_FADE_NEAR.toFixed(3)}, ${HALO_FADE_FAR.toFixed(3)}, dist);
    vColor = haloColor * fade;
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
    // Peaks at 1.3 at the centre (HALO_PEAK).
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
        uniforms: {
          size: { value: HALO_SIZE },
          push: { value: HALO_PUSH },
          intensity: { value: HALO_INTENSITY },
        },
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
    for (let i = 0; i < this.count * 3; i += 3) {
      const r = LUT[pixels[i]] * brightness;
      const g = LUT[pixels[i + 1]] * brightness;
      const b = LUT[pixels[i + 2]] * brightness;
      halo[i] = r;
      halo[i + 1] = g;
      halo[i + 2] = b;
      bulbColor(r, g, b, bulb, i);
    }
    this.bulbColors.needsUpdate = true;
    this.haloColors.needsUpdate = true;
  }
}

// Bulb color for a linear LED color, written to out[o..o+2]. Shared with the flash guard so it
// measures exactly what's drawn.
export function bulbColor(r, g, b, out, o) {
  // At the glow's peak, eased so the brightest channel reaches 1 only at full value:
  // BULB_GAIN·m / (1 + (BULB_GAIN − 1)·m). All channels share the scale, keeping the hue.
  const m = Math.max(r, g, b);
  const gain = BULB_GAIN / (1 + (BULB_GAIN - 1) * m);
  const lr = r * gain, lg = g * gain, lb = b * gain;
  // Unlit grey, topped up only to the BULB_OFF luminance floor: unlit bulbs stay visible and a
  // fade never dips darker than an unlit bulb. Lit bulbs are their pure colour once their
  // luminance passes BULB_OFF; dim blue and red keep a slight grey until then.
  const off = Math.max(0, BULB_OFF - (0.2126 * lr + 0.7152 * lg + 0.0722 * lb));
  out[o] = off + lr;
  out[o + 1] = off + lg;
  out[o + 2] = off + lb;
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
