import * as THREE from 'three';

// A floating text sprite (used for the effect name above each tree).
export function createLabel(width = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }),
  );
  sprite.scale.set(width, (width * canvas.height) / canvas.width, 1);

  sprite.setText = (text, color = '#e8ecf4') => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(8, 12, 28, 0.6)';
    g.beginPath();
    g.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 24);
    g.fill();
    g.fillStyle = color;
    g.font = '600 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let t = text;
    while (g.measureText(t).width > canvas.width - 40 && t.length > 4) t = t.slice(0, -2);
    if (t !== text) t = `${t.slice(0, -1)}…`;
    g.fillText(t, canvas.width / 2, canvas.height / 2 + 2);
    texture.needsUpdate = true;
  };
  return sprite;
}
