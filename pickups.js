// pickups.js
// -----------------------------------------------------------------------------
// Decayed meat scattered on the ground — the only way to refill energy. Each is
// a dim red lump that glows faintly (MeshBasic, so visible in the pitch black)
// and throbs, acting as a beacon to hunt toward. Walk over one to eat it: your
// energy refills and the lump relocates elsewhere, so there's always something
// out there to find.
// -----------------------------------------------------------------------------

const COUNT = 6;             // meat lumps live around the player at once
const PICK_RADIUS = 1.5;     // how close you must be to eat one
const MIN_D = 10;            // relocate distance range from the player
const MAX_D = 40;
export const MEAT_ENERGY = 40; // energy restored per meat

export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    const geo = new THREE.SphereGeometry(0.28, 8, 6);
    for (let i = 0; i < COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xa5301a }); // dim, gory red
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(1, 0.55, 1); // squashed lump
      scene.add(mesh);
      this.items.push({ mesh, phase: Math.random() * Math.PI * 2 });
    }
  }

  _relocate(item, playerPos) {
    const a = Math.random() * Math.PI * 2;
    const d = MIN_D + Math.random() * (MAX_D - MIN_D);
    item.mesh.position.set(playerPos.x + Math.cos(a) * d, 0.35, playerPos.z + Math.sin(a) * d);
  }

  reset(playerPos) {
    for (const it of this.items) this._relocate(it, playerPos);
  }

  // Gentle throb so the lumps read as "alive"/findable.
  animate(time) {
    for (const it of this.items) {
      const s = 1 + 0.18 * Math.sin(time * 3 + it.phase);
      it.mesh.scale.set(s, 0.55 * s, s);
    }
  }

  // Eat any meat within reach; returns total energy gained this frame.
  update(playerPos) {
    let gained = 0;
    for (const it of this.items) {
      const dx = playerPos.x - it.mesh.position.x;
      const dz = playerPos.z - it.mesh.position.z;
      if (dx * dx + dz * dz < PICK_RADIUS * PICK_RADIUS) {
        gained += MEAT_ENERGY;
        this._relocate(it, playerPos);
      }
    }
    return gained;
  }
}
