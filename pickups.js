// pickups.js
// -----------------------------------------------------------------------------
// Things lying on the ground, glowing faintly so they read as beacons in the
// pitch black and give you a reason to push deeper:
//   * MEAT      — decayed lumps; eat one to refill energy.
//   * CRUCIFIX  — rare; brandish it to ward off everything nearby.
// Both are MeshBasic, so they're self-lit and visible without the sonar. Walk
// over one to take it (if you have room); it then relocates elsewhere, so there
// is always something out there to find.
// -----------------------------------------------------------------------------

const COUNT = 13;        // items live around the player at once (was 8)
const PICK_RADIUS = 1.5; // how close you must be to take one
const MIN_D = 8;         // relocate distance range from the player — closer now,
const MAX_D = 34;        // so there's more to find and less starving
export const MEAT_ENERGY = 40;

// Weighted item table. Crucifixes are now RARE — they're a full escape button,
// so finding them constantly would defang the whole game. The torch is rarer.
const ITEM_TABLE = [
  ["meat", 0.62],
  ["battery", 0.22],
  ["crucifix", 0.09],
  ["torch", 0.07],
];

function rollType() {
  let r = Math.random();
  for (const [type, w] of ITEM_TABLE) {
    r -= w;
    if (r <= 0) return type;
  }
  return "meat";
}

export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.items = [];

    this.meatGeo = new THREE.SphereGeometry(0.28, 8, 6);
    this.meatMat = new THREE.MeshBasicMaterial({ color: 0xa5301a }); // dim, gory red
    // A crucifix: an upright bar with a crossbar, pale and faintly holy.
    this.crossMat = new THREE.MeshBasicMaterial({ color: 0xf2ead0 });
    this.crossVGeo = new THREE.BoxGeometry(0.09, 0.62, 0.09);
    this.crossHGeo = new THREE.BoxGeometry(0.38, 0.09, 0.09);
    // A torch: a dark barrel with a bright lens.
    this.torchBodyGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.5, 8);
    this.torchBodyMat = new THREE.MeshBasicMaterial({ color: 0x4a4a52 });
    this.torchLensGeo = new THREE.CylinderGeometry(0.13, 0.09, 0.12, 8);
    this.torchLensMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
    // A battery: a small cell with a bright cap.
    this.battGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.32, 8);
    this.battMat = new THREE.MeshBasicMaterial({ color: 0x2f7d4f });
    this.battCapGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8);
    this.battCapMat = new THREE.MeshBasicMaterial({ color: 0xd8d040 });

    for (let i = 0; i < COUNT; i++) {
      const group = new THREE.Group();
      scene.add(group);
      this.items.push({ group, type: null, phase: Math.random() * Math.PI * 2 });
    }
  }

  _build(item, type) {
    item.group.clear();
    if (type === "meat") {
      const mesh = new THREE.Mesh(this.meatGeo, this.meatMat);
      mesh.scale.set(1, 0.55, 1); // squashed lump
      item.group.add(mesh);
    } else if (type === "crucifix") {
      const v = new THREE.Mesh(this.crossVGeo, this.crossMat);
      const h = new THREE.Mesh(this.crossHGeo, this.crossMat);
      h.position.y = 0.16;
      item.group.add(v, h);
    } else if (type === "torch") {
      const body = new THREE.Mesh(this.torchBodyGeo, this.torchBodyMat);
      const lens = new THREE.Mesh(this.torchLensGeo, this.torchLensMat);
      lens.position.y = 0.3;
      item.group.add(body, lens);
    } else {
      const cell = new THREE.Mesh(this.battGeo, this.battMat);
      const cap = new THREE.Mesh(this.battCapGeo, this.battCapMat);
      cap.position.y = 0.19;
      item.group.add(cell, cap);
    }
    item.type = type;
  }

  _relocate(item, playerPos) {
    const a = Math.random() * Math.PI * 2;
    const d = MIN_D + Math.random() * (MAX_D - MIN_D);
    this._build(item, rollType());
    item.group.position.set(
      playerPos.x + Math.cos(a) * d,
      item.type === "meat" ? 0.35 : 0.45,
      playerPos.z + Math.sin(a) * d
    );
  }

  reset(playerPos) {
    for (const it of this.items) this._relocate(it, playerPos);
  }

  // Gentle throb so they read as findable.
  animate(time) {
    for (const it of this.items) {
      const s = 1 + 0.16 * Math.sin(time * 3 + it.phase);
      it.group.scale.set(s, s, s);
      if (it.type !== "meat") it.group.rotation.y = time * 0.7; // slow turn
    }
  }

  // Take anything within reach that `canAccept(type)` says you have room for.
  // Returns the list of types picked up this frame.
  update(playerPos, canAccept) {
    const taken = [];
    for (const it of this.items) {
      const dx = playerPos.x - it.group.position.x;
      const dz = playerPos.z - it.group.position.z;
      if (dx * dx + dz * dz >= PICK_RADIUS * PICK_RADIUS) continue;
      if (!canAccept(it.type)) continue; // no room — leave it on the ground
      taken.push(it.type);
      this._relocate(it, playerPos);
    }
    return taken;
  }
}
