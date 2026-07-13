// entities.js
// -----------------------------------------------------------------------------
import { installReveal } from "./reveal.js";

// -----------------------------------------------------------------------------
// The threat. Figures spawn out in the dark and home straight toward the player,
// phasing through walls (no cheap safety). They are pitch black — only a sonar
// pulse lights them up — except for faint red eyes that glint in the void so you
// catch them coming. They move slower than a walk, so you can outrun them, but
// stop moving and one will reach you. Contact = death.
// -----------------------------------------------------------------------------

const BODY_COLOR = 0x0a0a0a;   // near-black; only the sonar reveals the shape
const EYE_COLOR = 0xff1f1f;    // always-visible red glints
const SPEED = 2.5;             // slower than the player's 3.4 walk (escapable)
const KILL_RADIUS = 0.9;       // contact distance (XZ) that ends the run
const SPAWN_MIN = 14;          // never spawn closer than this
const SPAWN_MAX = 24;
const DESPAWN = 44;            // give up chasing once this far behind
const FIRST_DELAY = 7;         // seconds of grace at the start of a run
const MAX_CAP = 5;

export class EntitySystem {
  constructor(scene) {
    this.scene = scene;
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity; // distance to the closest entity (for footstep audio)

    // Shared assets — only a handful of entities exist at once.
    this.bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    this.headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    this.eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.bodyMat = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    installReveal(this.bodyMat); // the sonar rings reveal their shape
    this.eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR }); // unlit = always glowing
  }

  // Clear all entities and reset the spawn timer for a fresh run.
  reset() {
    for (const e of this.entities) this.scene.remove(e.group);
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity;
  }

  _spawn(playerPos) {
    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = playerPos.x + Math.cos(angle) * dist;
    const z = playerPos.z + Math.sin(angle) * dist;

    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    body.position.y = 0.75;
    const head = new THREE.Mesh(this.headGeo, this.bodyMat);
    head.position.y = 1.6;
    const eyeL = new THREE.Mesh(this.eyeGeo, this.eyeMat);
    eyeL.position.set(-0.09, 1.62, 0.2);
    const eyeR = new THREE.Mesh(this.eyeGeo, this.eyeMat);
    eyeR.position.set(0.09, 1.62, 0.2);
    group.add(body, head, eyeL, eyeR);
    group.position.set(x, 0, z);
    this.scene.add(group);

    this.entities.push({ group, x, z });
  }

  // Advance all entities toward the player. Returns true if one caught them.
  // `distance` (explored distance) ramps the max count so it gets worse deeper in.
  update(dt, playerPos, distance) {
    this.spawnCd -= dt;
    const cap = Math.min(1 + Math.floor(distance / 35), MAX_CAP);
    if (this.spawnCd <= 0 && this.entities.length < cap) {
      this._spawn(playerPos);
      this.spawnCd = Math.max(2.5, 6.5 - distance * 0.02); // spawn faster over time
    }

    let caught = false;
    let nearest = Infinity;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dx = playerPos.x - e.x;
      const dz = playerPos.z - e.z;
      const d = Math.hypot(dx, dz);

      if (d < KILL_RADIUS) {
        caught = true;
        nearest = Math.min(nearest, d);
        continue;
      }
      if (d > DESPAWN) {
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue; // leaving; don't count toward "nearest"
      }

      nearest = Math.min(nearest, d);
      const inv = 1 / (d || 1);
      e.x += dx * inv * SPEED * dt;
      e.z += dz * inv * SPEED * dt;
      e.group.position.set(e.x, 0, e.z);
      e.group.rotation.y = Math.atan2(dx, dz); // face the player (eyes forward)
    }
    this.nearest = nearest;
    return caught;
  }
}
