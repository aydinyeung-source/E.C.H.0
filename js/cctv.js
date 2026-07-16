// cctv.js
// -----------------------------------------------------------------------------
// SECURITY CAMERAS.
//
// Every so often, mounted high in a corner ahead of you, there is a camera — and
// it is watching. In the dark all you see is its little red recording light, and
// it turns, slowly, to keep that light pointed at you wherever you go. Ping the
// sonar and the ring reveals the rest of it: a housing on a drop-arm from the
// ceiling, lens fixed on you. It does nothing. It just watches. That's the point.
//
// It is purely atmospheric — it does not hunt you, alert anything, or affect a
// single mechanic. It is there to make the corridor feel occupied and observed.
//
// The housing uses the world's own reveal material (invisible until a ping washes
// over it, then fades back to black), so it belongs to the building. The red light
// is a self-lit MeshBasicMaterial, so it is always there in the dark, following.

import { CELL, WALL_H } from "./world.js";
import { installReveal } from "./reveal.js";

const MAX_CAMS = 1;          // one at a time — a rarity, not wallpaper
const FIRST_DELAY = 20;      // seconds before the first can appear
const SPAWN_INTERVAL = 24;   // between attempts once none is up
const SPAWN_CHANCE = 0.45;   // chance an attempt actually places one
const MIN_DIST = 5;          // metres from you it can appear
const MAX_DIST = 12;
const DESPAWN_DIST = 20;     // drop it once you've walked this far off
const HEAD_Y = WALL_H - 0.52; // where the swivel head hangs, just under the ceiling

export class SecurityCameras {
  constructor(scene) {
    this.scene = scene;
    this.cams = [];
    this.timer = FIRST_DELAY;

    this.housingMat = new THREE.MeshPhongMaterial({ color: 0x3b3b44, shininess: 4 });
    installReveal(this.housingMat); // dark until a ping reveals it, like the walls
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0xff2323 }); // always-on red eye

    this.boxGeo = new THREE.BoxGeometry(0.26, 0.2, 0.42);
    this.plateGeo = new THREE.BoxGeometry(0.24, 0.05, 0.24);
    this.armGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6);
    this.lensGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.13, 12);
    this.ledGeo = new THREE.SphereGeometry(0.032, 8, 8);

    this._aim = new THREE.Object3D(); // scratch, for smooth swivel
  }

  reset() {
    for (const c of this.cams) this.scene.remove(c.group);
    this.cams = [];
    this.timer = FIRST_DELAY;
  }

  update(dt, playerPos, world) {
    // Drop any you've left well behind.
    for (let i = this.cams.length - 1; i >= 0; i--) {
      const c = this.cams[i];
      if (Math.hypot(c.x - playerPos.x, c.z - playerPos.z) > DESPAWN_DIST) {
        this.scene.remove(c.group);
        this.cams.splice(i, 1);
      }
    }

    // Occasionally hang a new one, if there's room in the quota.
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = SPAWN_INTERVAL;
      if (this.cams.length < MAX_CAMS && Math.random() < SPAWN_CHANCE) {
        this._place(playerPos, world);
      }
    }

    // Every one of them tracks you. Smoothly — a motor turning to keep its eye on
    // you — rather than snapping, which reads as mechanical and patient.
    const follow = 1 - Math.exp(-dt * 5);
    for (const c of this.cams) {
      this._aim.position.set(c.x, HEAD_Y, c.z);
      this._aim.lookAt(playerPos.x, 1.2, playerPos.z);
      // c.group is unrotated, so the head's local frame is the world frame.
      c.head.quaternion.slerp(this._aim.quaternion, follow);
    }
  }

  // Hang one on a ceiling corner near you, with a clear line to where you stand so
  // it can actually watch — you notice it already looking at you.
  _place(playerPos, world) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = MIN_DIST + Math.random() * (MAX_DIST - MIN_DIST);
      // Snap to the nearest cell corner (a wall junction) so it reads as mounted.
      const x = Math.round((playerPos.x + Math.cos(a) * d) / CELL) * CELL;
      const z = Math.round((playerPos.z + Math.sin(a) * d) / CELL) * CELL;

      const dist = Math.hypot(x - playerPos.x, z - playerPos.z);
      if (dist < MIN_DIST || dist > MAX_DIST + CELL) continue;
      if (world.segmentBlocked(x, z, playerPos.x, playerPos.z)) continue; // needs to see you

      // Don't stack two on the same corner.
      if (this.cams.some((c) => c.x === x && c.z === z)) continue;

      this.cams.push(this._build(x, z));
      return true;
    }
    return false;
  }

  _build(x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);

    // Ceiling plate + drop arm (static).
    const plate = new THREE.Mesh(this.plateGeo, this.housingMat);
    plate.position.y = WALL_H - 0.025;
    const arm = new THREE.Mesh(this.armGeo, this.housingMat);
    arm.position.y = WALL_H - 0.28;
    g.add(plate, arm);

    // The swivel head: body, lens on +Z, and the recording light beside it.
    const head = new THREE.Group();
    head.position.y = HEAD_Y;
    const body = new THREE.Mesh(this.boxGeo, this.housingMat);
    const lens = new THREE.Mesh(this.lensGeo, this.housingMat);
    lens.rotation.x = Math.PI / 2; // barrel points along +Z
    lens.position.z = 0.26;
    const led = new THREE.Mesh(this.ledGeo, this.ledMat);
    led.position.set(0.1, 0.08, 0.22);
    head.add(body, lens, led);
    g.add(head);

    this.scene.add(g);
    return { group: g, head, x, z };
  }
}
