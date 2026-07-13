// entities.js
// -----------------------------------------------------------------------------
import { installReveal } from "./reveal.js";
import { RUN_SPEED as PLAYER_RUN_SPEED } from "./player.js";

// -----------------------------------------------------------------------------
// The threat: sound-driven, sight-driven, and solid.
//
// Entities are BLIND until they either HEAR you (any sonar click tells every
// entity your exact position — see hearSonar) or SEE you (clear line of sight,
// no wall between). While they can see you they lock onto your real position.
// Break line of sight and they keep coming for LOS_MEMORY seconds on the memory
// of where you were; after that they lose you and settle at that last spot.
//
// They CANNOT walk through walls: with a clear sightline they beeline, otherwise
// they A*-path around the maze, and they're pushed out of walls like the player.
// Far away they rush at CHASE_SPEED (2.5x); within CLOSE_RANGE they slow to
// BASE_SPEED (1x) and stalk. Contact = death.
// -----------------------------------------------------------------------------

const BODY_COLOR = 0x0a0a0a;
const EYE_COLOR = 0xff1f1f;
const BASE_SPEED = 2.4;             // "1x" — used within CLOSE_RANGE
// 2.5x when enraged/hunting from range — but HARD-CAPPED below the player's
// sprint so a running player can always break away. Derived from the player's
// actual run speed, so retuning that can never accidentally make entities
// un-outrunnable. (2.4*2.5 = 6.0 vs the 6.46 cap, so it lands at 6.0 — about
// 21% slower than a sprint, and still faster than a 5.1 walk.)
const CHASE_SPEED = Math.min(BASE_SPEED * 2.5, PLAYER_RUN_SPEED * 0.85);
const CLOSE_RANGE = 5;              // metres; inside this the entity slows to 1x
const LOS_MEMORY = 2;               // seconds it keeps chasing after losing SIGHT
const PING_MEMORY = 3;              // seconds a sonar ping exposes you for
const FLEE_SPEED = CHASE_SPEED;     // how fast a warded entity runs away
const KILL_RADIUS = 0.9;            // contact distance (XZ) that ends the run
const ENTITY_RADIUS = 0.35;         // collision radius, so it can't clip walls
const REPATH_INTERVAL = 0.5;        // seconds between A* recomputes while blind
const SPAWN_MIN = 14;
const SPAWN_MAX = 24;
const DESPAWN = 52;                 // remove if it drifts this far from the player
const FIRST_DELAY = 10;             // seconds of grace at the start of a run
const SPAWN_MIN_DISTANCE = 12;      // ...and nothing spawns until you've ventured out
const MAX_CAP = 6;

const _v = new THREE.Vector3(); // scratch for wall collision

export class EntitySystem {
  constructor(scene) {
    this.scene = scene;
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity; // distance to the closest entity (for footstep audio)

    this.bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    this.headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    this.eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.bodyMat = new THREE.MeshPhongMaterial({ color: BODY_COLOR, shininess: 0 });
    installReveal(this.bodyMat); // the sonar rings reveal their shape
    this.eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR }); // always glowing
  }

  reset() {
    for (const e of this.entities) this.scene.remove(e.group);
    this.entities = [];
    this.spawnCd = FIRST_DELAY;
    this.nearest = Infinity;
  }

  // A sonar ping gives you away — but only for PING_MEMORY seconds. Within that
  // window they know where you are and hunt you; once it lapses, if they still
  // can't SEE you, they lose you completely and stop chasing.
  hearSonar(x, z) {
    for (const e of this.entities) {
      if (e.fleeTimer > 0) continue; // a warded entity isn't listening
      e.tx = x;
      e.tz = z;
      e.trackTimer = Math.max(e.trackTimer, PING_MEMORY);
      e.path = null; // the destination moved; recompute the route
    }
  }

  // Brandishing a crucifix: everything within `radius` breaks off, loses you and
  // flees for `duration` seconds. This also snaps it out of a torch rage.
  repel(playerPos, radius, duration) {
    let affected = 0;
    for (const e of this.entities) {
      if (Math.hypot(e.x - playerPos.x, e.z - playerPos.z) > radius) continue;
      e.fleeTimer = duration;
      e.trackTimer = 0;  // it loses you entirely
      e.enrageTimer = 0; // and calms down
      e.path = null;
      affected++;
    }
    return affected;
  }

  // Caught in the torch beam. An ENRAGED entity knows exactly where you are
  // regardless of walls or sight, and never slows down to stalk — it just comes.
  enrage(entity, duration) {
    if (entity.fleeTimer > 0) return; // a warded one is busy running
    entity.enrageTimer = Math.max(entity.enrageTimer, duration);
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

    // Target starts at the spawn spot: it lurks there until it sees or hears you.
    this.entities.push({
      group, x, z,
      tx: x, tz: z,       // last known player position
      trackTimer: 0,      // >0 while it still knows where you are
      fleeTimer: 0,       // >0 while warded off by a crucifix
      enrageTimer: 0,     // >0 while enraged by the torch beam
      path: null,
      pathTimer: 0,
      canSee: false,
    });
  }

  // Returns true if an entity caught the player. `distance` (explored distance)
  // ramps the max simultaneous entity count. `world` provides line-of-sight,
  // pathfinding and wall collision.
  update(dt, playerPos, distance, world) {
    this.spawnCd -= dt;
    const cap = Math.min(1 + Math.floor(distance / 30), MAX_CAP);
    // Nothing hunts you at the very start: you get both a grace period AND have
    // to actually venture away from spawn before anything appears.
    const maySpawn = this.spawnCd <= 0 && distance > SPAWN_MIN_DISTANCE;
    if (maySpawn && this.entities.length < cap) {
      this._spawn(playerPos);
      this.spawnCd = Math.max(2.5, 6.5 - distance * 0.02);
    }

    let caught = false;
    let nearest = Infinity;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dxp = playerPos.x - e.x;
      const dzp = playerPos.z - e.z;
      const dPlayer = Math.hypot(dxp, dzp);

      if (dPlayer > DESPAWN) {
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue;
      }

      // --- Warded off (crucifix) --------------------------------------------
      // It has broken off entirely: it can't see you, can't catch you, and runs.
      if (e.fleeTimer > 0) {
        e.fleeTimer -= dt;
        e.canSee = false;
        nearest = Math.min(nearest, dPlayer);
        const fx = e.x - playerPos.x;
        const fz = e.z - playerPos.z;
        const fd = Math.hypot(fx, fz) || 1;
        _v.set(e.x + (fx / fd) * FLEE_SPEED * dt, 0, e.z + (fz / fd) * FLEE_SPEED * dt);
        world.collide(_v, ENTITY_RADIUS);
        e.x = _v.x;
        e.z = _v.z;
        e.group.position.set(e.x, 0, e.z);
        e.group.rotation.y = Math.atan2(fx, fz); // facing away
        continue;
      }

      if (dPlayer < KILL_RADIUS) {
        caught = true;
        nearest = Math.min(nearest, dPlayer);
        continue;
      }
      nearest = Math.min(nearest, dPlayer);

      // --- Do we know where you are? ----------------------------------------
      // Sight beats everything. Otherwise the tracking timer runs down: it was
      // set to PING_MEMORY (3s) by a sonar ping, or LOS_MEMORY (2s) by having
      // just seen you. When it hits zero without a sightline, it LOSES you.
      const canSee = !world.segmentBlocked(e.x, e.z, playerPos.x, playerPos.z);
      e.canSee = canSee; // the radar shows a live red dot for anything watching you

      // ENRAGED (you shone the torch in its face): it knows where you are through
      // walls, and never loses you until the rage burns out.
      const enraged = e.enrageTimer > 0;
      if (enraged) e.enrageTimer -= dt;

      if (canSee || enraged) {
        e.tx = playerPos.x;
        e.tz = playerPos.z;
        if (canSee) {
          e.trackTimer = LOS_MEMORY;
          e.path = null; // it can walk straight at you; no route needed
        }
      } else {
        e.trackTimer -= dt;
        if (e.trackTimer > 0) {
          // Still knows where you are: keep hunting your current position.
          e.tx = playerPos.x;
          e.tz = playerPos.z;
        }
      }

      // Lost you: stop chasing and just lurk where you last gave yourself away.
      if (!canSee && !enraged && e.trackTimer <= 0) {
        e.group.rotation.y = Math.atan2(dxp, dzp);
        continue;
      }

      // --- Steering ---------------------------------------------------------
      let aimX = e.tx;
      let aimZ = e.tz;
      if (!canSee) {
        // No sightline: route around the walls instead of grinding into them.
        e.pathTimer -= dt;
        if (!e.path || !e.path.length || e.pathTimer <= 0) {
          e.path = world.findPath(e.x, e.z, e.tx, e.tz);
          e.pathTimer = REPATH_INTERVAL;
        }
        if (e.path && e.path.length) {
          if (Math.hypot(e.path[0].x - e.x, e.path[0].z - e.z) < 0.6) e.path.shift();
          if (e.path.length) {
            aimX = e.path[0].x;
            aimZ = e.path[0].z;
          }
        }
      }

      const ax = aimX - e.x;
      const az = aimZ - e.z;
      const dAim = Math.hypot(ax, az);
      if (dAim > 0.05) {
        // Enraged, it never drops to a stalk — it just keeps coming at full pace.
        const speed = !enraged && dPlayer < CLOSE_RANGE ? BASE_SPEED : CHASE_SPEED;
        const step = (speed * dt) / dAim;
        _v.set(e.x + ax * step, 0, e.z + az * step);
        world.collide(_v, ENTITY_RADIUS); // solid: pushed out of walls, slides along them
        e.x = _v.x;
        e.z = _v.z;
        e.group.position.set(e.x, 0, e.z);
      }
      // Always face the player so the eyes track you.
      e.group.rotation.y = Math.atan2(dxp, dzp);
    }
    this.nearest = nearest;
    return caught;
  }
}
