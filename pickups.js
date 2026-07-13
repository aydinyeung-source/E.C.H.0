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

const COUNT = 8;              // items live around the player at once
const PICK_RADIUS = 1.5;      // how close you must be to take one
const MIN_D = 10;             // relocate distance range from the player
const MAX_D = 42;
const CRUCIFIX_CHANCE = 0.22; // ...of any given item being a crucifix
export const MEAT_ENERGY = 40;

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
    } else {
      const v = new THREE.Mesh(this.crossVGeo, this.crossMat);
      const h = new THREE.Mesh(this.crossHGeo, this.crossMat);
      h.position.y = 0.16;
      item.group.add(v, h);
    }
    item.type = type;
  }

  _relocate(item, playerPos) {
    const a = Math.random() * Math.PI * 2;
    const d = MIN_D + Math.random() * (MAX_D - MIN_D);
    this._build(item, Math.random() < CRUCIFIX_CHANCE ? "crucifix" : "meat");
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
      if (it.type === "crucifix") it.group.rotation.y = time * 0.7; // slow turn
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
