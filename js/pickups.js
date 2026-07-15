// pickups.js
// -----------------------------------------------------------------------------
// Loot that is IN the world, not spawned around you.
//
// Each cell deterministically rolls for what's lying in it (see chunkItems in
// world.js): a 5% spawn gate, then a 75/20/5 meat/torch/crucifix pick. So the
// supplies are part of the level — an abandoned place with things left in it —
// rather than a pool of items that follows the player about. It also means the
// daily challenge gives everyone the same supplies in the same places.
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

    // A CARCASS, not a snack. Built from a few dark, wet lumps of flesh with a
    // bone shard poking out and a blood pool spreading beneath it — grim, not
    // appetising. Colours are deep and dried-blood dark, because it's been here a
    // while and nothing down here is fresh.
    this.meatGeo = new THREE.SphereGeometry(0.24, 8, 6);
    this.meatMat = new THREE.MeshBasicMaterial({ color: 0x5e120b });   // dark meat
    this.meatDarkMat = new THREE.MeshBasicMaterial({ color: 0x330807 }); // clotted, near-black
    this.boneMat = new THREE.MeshBasicMaterial({ color: 0xbdb298 });   // dirty bone
    this.boneGeo = new THREE.BoxGeometry(0.07, 0.07, 0.4);
    this.bloodMat = new THREE.MeshBasicMaterial({
      color: 0x2a0604, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    });
    this.bloodGeo = new THREE.CircleGeometry(0.42, 14);
    // The crucifix, modelled LYING FLAT: a long shaft along X with a crossbar
    // across it. Nothing stands up — it fell here.
    this.crossMat = new THREE.MeshBasicMaterial({ color: 0xf2ead0 });
    this.crossShaftGeo = new THREE.BoxGeometry(0.6, 0.08, 0.08);
    this.crossBarGeo = new THREE.BoxGeometry(0.08, 0.08, 0.34);
    // The torch, modelled ON ITS SIDE (the cylinder is rotated to lie along X).
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

  // Everything here is built LYING ON THE FLOOR — it fell, it wasn't placed.
  _mesh(type) {
    const group = new THREE.Group();

    if (type === "meat") {
      // A blood pool, flat on the ground.
      const pool = new THREE.Mesh(this.bloodGeo, this.bloodMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = -0.13;
      pool.scale.set(1, 0.8, 1);
      group.add(pool);
      // The main mass of flesh, squashed and slumped.
      const m = new THREE.Mesh(this.meatGeo, this.meatMat);
      m.scale.set(1.2, 0.6, 0.95);
      group.add(m);
      // A torn-off second lump, darker and off to one side.
      const m2 = new THREE.Mesh(this.meatGeo, this.meatDarkMat);
      m2.scale.set(0.7, 0.45, 0.7);
      m2.position.set(0.22, -0.03, -0.12);
      group.add(m2);
      // A bone shard jutting out of it.
      const bone = new THREE.Mesh(this.boneGeo, this.boneMat);
      bone.position.set(-0.14, 0.02, 0.05);
      bone.rotation.set(0.2, 0.5, 0.15);
      group.add(bone);
    } else if (type === "crucifix") {
      // Lying flat: long shaft with a crossbar across it near the top.
      const shaft = new THREE.Mesh(this.crossShaftGeo, this.crossMat);
      const bar = new THREE.Mesh(this.crossBarGeo, this.crossMat);
      bar.position.x = 0.14;
      group.add(shaft, bar);
    } else {
      // Torch on its side — the cylinders are rotated to run along X.
      const body = new THREE.Mesh(this.torchBodyGeo, this.torchBodyMat);
      body.rotation.z = Math.PI / 2;
      const lens = new THREE.Mesh(this.torchLensGeo, this.torchLensMat);
      lens.rotation.z = Math.PI / 2;
      lens.position.x = 0.3;
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
        // Rest it ON the floor, and spin it any which way with a slight tumble, so
        // it reads as something dropped rather than stood on display.
        const restY = spec.type === "meat" ? 0.16 : spec.type === "torch" ? 0.11 : 0.06;
        group.position.set(spec.x, restY, spec.z);
        group.rotation.y = Math.random() * Math.PI * 2;
        group.rotation.z = (Math.random() - 0.5) * 0.18;
        group.rotation.x = (Math.random() - 0.5) * 0.18;
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

  // No spinning — it's lying where it fell, not rotating on a pedestal. Just the
  // faintest breath of a scale pulse so it stays findable in the dark without
  // looking like an arcade pickup. Rotation is set once, at spawn, and left alone.
  animate(time) {
    for (const items of this.byChunk.values()) {
      for (const it of items) {
        const s = 1 + 0.06 * Math.sin(time * 2.2 + it.phase);
        it.group.scale.set(s, s, s);
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
