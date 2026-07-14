// pickups.js
// -----------------------------------------------------------------------------
// Loot that is IN the world, not spawned around you.
//
// Each chunk deterministically rolls for what's lying in it (see chunkItems in
// world.js): 15% a scrap of meat, 5% a torch, 5% a crucifix. So the supplies are
// part of the level — an abandoned place with things left in it — rather than a
// pool of items that follows the player about. It also means the daily challenge
// gives everyone the same supplies in the same places.
//
// Items stream in and out with their chunk. Anything you pick up is remembered by
// its stable id and does NOT come back if you walk away and return.
// -----------------------------------------------------------------------------

import { chunkItems } from "./world.js";

const PICK_RADIUS = 1.5;
export const MEAT_ENERGY = 40;

export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.byChunk = new Map(); // chunk key -> live item objects
    this.collected = new Set(); // item ids already taken this run

    this.meatGeo = new THREE.SphereGeometry(0.28, 8, 6);
    this.meatMat = new THREE.MeshBasicMaterial({ color: 0xa5301a }); // dim, gory red
    this.crossMat = new THREE.MeshBasicMaterial({ color: 0xf2ead0 });
    this.crossVGeo = new THREE.BoxGeometry(0.09, 0.62, 0.09);
    this.crossHGeo = new THREE.BoxGeometry(0.38, 0.09, 0.09);
    this.torchBodyGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.5, 8);
    this.torchBodyMat = new THREE.MeshBasicMaterial({ color: 0x4a4a52 });
    this.torchLensGeo = new THREE.CylinderGeometry(0.13, 0.09, 0.12, 8);
    this.torchLensMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
  }

  reset() {
    for (const items of this.byChunk.values()) {
      for (const it of items) this.scene.remove(it.group);
    }
    this.byChunk.clear();
    this.collected.clear();
  }

  _mesh(type) {
    const group = new THREE.Group();
    if (type === "meat") {
      const m = new THREE.Mesh(this.meatGeo, this.meatMat);
      m.scale.set(1, 0.55, 1); // squashed lump
      group.add(m);
    } else if (type === "crucifix") {
      const v = new THREE.Mesh(this.crossVGeo, this.crossMat);
      const h = new THREE.Mesh(this.crossHGeo, this.crossMat);
      h.position.y = 0.16;
      group.add(v, h);
    } else {
      const body = new THREE.Mesh(this.torchBodyGeo, this.torchBodyMat);
      const lens = new THREE.Mesh(this.torchLensGeo, this.torchLensMat);
      lens.position.y = 0.3;
      group.add(body, lens);
    }
    return group;
  }

  // Bring items in and out with their chunks.
  sync(world) {
    for (const key of world.chunks.keys()) {
      if (this.byChunk.has(key)) continue;
      const [cx, cy] = key.split(":").map(Number);
      const live = [];
      for (const spec of chunkItems(cx, cy)) {
        if (this.collected.has(spec.id)) continue; // already taken — stays taken
        const group = this._mesh(spec.type);
        group.position.set(spec.x, spec.type === "meat" ? 0.35 : 0.45, spec.z);
        this.scene.add(group);
        live.push({ ...spec, group, phase: Math.random() * Math.PI * 2 });
      }
      this.byChunk.set(key, live);
    }

    for (const [key, items] of this.byChunk) {
      if (world.chunks.has(key)) continue;
      for (const it of items) this.scene.remove(it.group);
      this.byChunk.delete(key);
    }
  }

  // Gentle throb so they read as findable in the dark.
  animate(time) {
    for (const items of this.byChunk.values()) {
      for (const it of items) {
        const s = 1 + 0.16 * Math.sin(time * 3 + it.phase);
        it.group.scale.set(s, s, s);
        if (it.type !== "meat") it.group.rotation.y = time * 0.7;
      }
    }
  }

  // Take anything in reach that `canAccept(type)` says we have room for.
  // Returns the types picked up this frame.
  update(playerPos, canAccept) {
    const taken = [];
    for (const [key, items] of this.byChunk) {
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        const dx = playerPos.x - it.x;
        const dz = playerPos.z - it.z;
        if (dx * dx + dz * dz >= PICK_RADIUS * PICK_RADIUS) continue;
        if (!canAccept(it.type)) continue; // no room — leave it on the floor
        taken.push(it.type);
        this.collected.add(it.id); // gone for good
        this.scene.remove(it.group);
        items.splice(k, 1);
      }
    }
    return taken;
  }
}
