import * as THREE from 'three';

const SNOW_COUNT = 1500;
const SNOW_BOX = { x: 24, y: 10, z: 24 };

// Night sky, snowy ground, moonlight, stars and falling snow.
export function createEnvironment(scene) {
  scene.background = new THREE.Color(0x050a18);
  scene.fog = new THREE.FogExp2(0x050a18, 0.035);

  scene.add(new THREE.HemisphereLight(0x3a4a70, 0x0a0a10, 0.9));
  const moon = new THREE.DirectionalLight(0x8899cc, 0.5);
  moon.position.set(-5, 10, 3);
  scene.add(moon);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const starPositions = [];
  for (let i = 0; i < 1500; i++) {
    const v = new THREE.Vector3().randomDirection();
    v.y = Math.abs(v.y) + 0.05;
    v.normalize().multiplyScalar(90);
    starPositions.push(v.x, v.y, v.z);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  scene.add(
    new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, fog: false }),
    ),
  );

  const snow = new Float32Array(SNOW_COUNT * 3);
  for (let i = 0; i < SNOW_COUNT; i++) {
    snow[i * 3] = (Math.random() - 0.5) * SNOW_BOX.x;
    snow[i * 3 + 1] = Math.random() * SNOW_BOX.y;
    snow[i * 3 + 2] = (Math.random() - 0.5) * SNOW_BOX.z;
  }
  const snowGeometry = new THREE.BufferGeometry();
  const snowAttr = new THREE.BufferAttribute(snow, 3).setUsage(THREE.DynamicDrawUsage);
  snowGeometry.setAttribute('position', snowAttr);
  const snowPoints = new THREE.Points(
    snowGeometry,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.025, transparent: true, opacity: 0.8 }),
  );
  snowPoints.frustumCulled = false;
  scene.add(snowPoints);

  let t = 0;
  return {
    update(dt) {
      t += dt;
      for (let i = 0; i < SNOW_COUNT; i++) {
        const o = i * 3;
        snow[o + 1] -= dt * (0.35 + (i % 7) * 0.04);
        snow[o] += Math.sin(t * 0.7 + i) * dt * 0.08;
        if (snow[o + 1] < 0) snow[o + 1] += SNOW_BOX.y;
      }
      snowAttr.needsUpdate = true;
    },
  };
}
