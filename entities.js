// entities.js
// -----------------------------------------------------------------------------
import { installReveal } from "./reveal.js";

// -----------------------------------------------------------------------------
// The threat, now sound-driven.
//
// Entities are BLIND: they don't know where you are until you make noise. Every
// sonar click (see hearSonar) tells every entity your exact position — they home
// toward that last-heard spot. Far from you they rush at CHASE_SPEED (2.5x); once
// within CLOSE_RANGE they drop to BASE_SPEED (1x) and stalk. So pinging to see is
// also what gets you hunted. They still spawn at random around you over time, so
// you can't just never click and wander forever. Contact = death.
// -----------------------------------------------------------------------------

const BODY_COLOR = 0x0a0a0a;
const EYE_COLOR = 0xff1f1f;
const BASE_SPEED = 2.4;             // "1x" — used within CLOSE_RANGE
const CHASE_SPEED = BASE_SPEED * 2.5; // 2.5x — used when alerted and far away
const CLOSE_RANGE = 5;              // metres; inside this the entity slows to 1x
const KILL_RADIUS = 0.9;            // contact distance (XZ) that ends the run
const SPAWN_MIN = 14;
const SPAWN_MAX = 24;
const DESPAWN = 52;                 // remove if it drifts this far from the player
const FIRST_DELAY = 7;              // seconds of grace at the start of a run
const MAX_CAP = 6;

export class EntitySystem {
  constructor(scene) {
    this.scene = scene;
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity; // distance to the closest entity (for footstep audio)

    this.bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    this.headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    this.eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.bodyMat = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    installReveal(this.bodyMat); // the sonar rings reveal their shape
    this.eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR }); // always glowing
  }

  reset() {
    for (const e of this.entities) this.scene.remove(e.group);
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity;
  }

  // Every entity "hears" a sonar ping and updates its target to that location.
  hearSonar(x, z) {
    for (const e of this.entities) {
      e.tx = x;
      e.tz = z;
    }
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

    // Target starts at the spawn spot: it lurks there until it hears a ping.
    this.entities.push({ group, x, z, tx: x, tz: z });
  }

  // Returns true if an entity caught the player. `distance` (explored distance)
  // ramps the max simultaneous entity count.
  update(dt, playerPos, distance) {
    this.spawnCd -= dt;
    const cap = Math.min(1 + Math.floor(distance / 30), MAX_CAP);
    if (this.spawnCd <= 0 && this.entities.length < cap) {
      this._spawn(playerPos);
      this.spawnCd = Math.max(2.5, 6.5 - distance * 0.02);
    }

    let caught = false;
    let nearest = Infinity;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dxp = playerPos.x - e.x;
      const dzp = playerPos.z - e.z;
      const dPlayer = Math.hypot(dxp, dzp); // actual distance (catch + speed tier)

      if (dPlayer < KILL_RADIUS) {
        caught = true;
        nearest = Math.min(nearest, dPlayer);
        continue;
      }
      if (dPlayer > DESPAWN) {
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue;
      }
      nearest = Math.min(nearest, dPlayer);

      // Within CLOSE_RANGE the entity senses you directly: it locks its target to
      // your real position every frame (so you can't hide by going quiet nearby),
      // but it also slows to BASE_SPEED. Farther out it only knows the last ping.
      const inClose = dPlayer < CLOSE_RANGE;
      if (inClose) {
        e.tx = playerPos.x;
        e.tz = playerPos.z;
      }
      const dtx = e.tx - e.x;
      const dtz = e.tz - e.z;
      const dTarget = Math.hypot(dtx, dtz);
      if (dTarget > 0.1) {
        const speed = inClose ? BASE_SPEED : CHASE_SPEED;
        const step = (speed * dt) / dTarget;
        e.x += dtx * step;
        e.z += dtz * step;
        e.group.position.set(e.x, 0, e.z);
      }
      // Always face the player so the eyes track you.
      e.group.rotation.y = Math.atan2(dxp, dzp);
    }
    this.nearest = nearest;
    return caught;
  }
}
