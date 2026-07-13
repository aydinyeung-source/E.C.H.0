// entities.js
// -----------------------------------------------------------------------------
import { installReveal } from "./reveal.js";
import { RUN_SPEED as PLAYER_RUN_SPEED } from "./player.js";

// -----------------------------------------------------------------------------
// The inhabitants.
//
// These things are NOT spawned at you. They already live here. They are out in
// the maze from the moment you arrive, wandering their own routes, minding their
// own business — and they will happily keep doing that forever if you leave them
// alone. The world is populated; it is not reacting to you.
//
// What wakes them is the SONAR. It is a sound nothing down here has ever made,
// and everything within earshot turns toward it. That's the whole bargain of the
// game: the only way to see is to announce yourself.
//
// A woken entity hunts you. It hunts using:
//   * SIGHT  — a clear sightline within SIGHT_RANGE locks onto your real position
//   * SOUND  — a sonar ping within HEAR_RADIUS gives you away for PING_MEMORY
// Lose both and, after the timer lapses, it forgets you and goes back to
// wandering. They can't walk through walls: with a sightline they beeline,
// otherwise they A*-path around the maze.
//
// Special states:
//   * ENRAGED (torch beam in the face) — tracks you through walls, never stalks
//   * BLINDED (crucifix)               — can't see/hear/track/catch you at all
// -----------------------------------------------------------------------------

const BODY_COLOR = 0x0a0a0a;
const EYE_COLOR = 0xff1f1f;

const WANDER_SPEED = 1.3;           // an unbothered amble
const BASE_SPEED = 2.4;             // "1x" — used within CLOSE_RANGE
// 2.5x when hunting from range — but HARD-CAPPED below the player's sprint so a
// running player can always break away. Derived from the player's actual run
// speed, so retuning that can never accidentally make them un-outrunnable.
const CHASE_SPEED = Math.min(BASE_SPEED * 2.5, PLAYER_RUN_SPEED * 0.85);

const SIGHT_RANGE = 20;             // how far they can actually see you
const HEAR_RADIUS = 40;             // how far a sonar ping carries
const CLOSE_RANGE = 5;              // inside this a hunter slows to 1x and stalks
const LOS_MEMORY = 2;               // seconds it keeps hunting after losing SIGHT
const PING_MEMORY = 3;              // seconds a sonar ping exposes you for

const KILL_RADIUS = 0.9;
const ENTITY_RADIUS = 0.35;
const REPATH_INTERVAL = 0.5;

// Population. They're placed out in the world, far away and out of sight — never
// dropped on top of you — and kept well apart from each other so you never get
// pincered down one corridor.
const BASE_POP = 4;
const MAX_POP = 7;
const POP_MIN_DIST = 30;            // always well beyond SIGHT_RANGE
const POP_MAX_DIST = 50;
const MIN_SEPARATION = 22;
const DESPAWN = 60;                 // drop ones that fall far behind, then re-place

const _v = new THREE.Vector3();

export class EntitySystem {
  constructor(scene) {
    this.scene = scene;
    this.entities = [];
    this.nearest = Infinity;

    this.bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    this.headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    this.eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.bodyMat = new THREE.MeshPhongMaterial({ color: BODY_COLOR, shininess: 0 });
    installReveal(this.bodyMat); // the sonar rings reveal their shape
    this.eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR });
  }

  // Wipe and re-populate the world around the spawn point.
  reset(playerPos) {
    for (const e of this.entities) this.scene.remove(e.group);
    this.entities = [];
    this.nearest = Infinity;
    if (playerPos) {
      for (let i = 0; i < BASE_POP; i++) this._place(playerPos);
    }
  }

  // The sonar: an unfamiliar sound. Everything within earshot turns toward it.
  hearSonar(x, z) {
    let heard = 0;
    for (const e of this.entities) {
      if (e.blindTimer > 0) continue;                     // deafened too
      if (Math.hypot(e.x - x, e.z - z) > HEAR_RADIUS) continue; // too far to carry
      e.tx = x;
      e.tz = z;
      e.trackTimer = Math.max(e.trackTimer, PING_MEMORY);
      e.path = null;
      e.wanderPath = null; // it stops what it was doing
      heard++;
    }
    return heard;
  }

  // Crucifix: BLINDS EVERY entity for `duration`. A blinded one can't see, hear,
  // track or catch you — it just gropes around where it stands.
  blindAll(duration) {
    for (const e of this.entities) {
      e.blindTimer = duration;
      e.trackTimer = 0;
      e.enrageTimer = 0;
      e.path = null;
    }
    return this.entities.length;
  }

  // Torch beam in the face: it tracks you through walls and never stalks.
  enrage(entity, duration) {
    if (entity.blindTimer > 0) return;
    entity.enrageTimer = Math.max(entity.enrageTimer, duration);
  }

  // Put one out in the world: far away, out of sight, clear of the others.
  _place(playerPos) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 14; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = POP_MIN_DIST + Math.random() * (POP_MAX_DIST - POP_MIN_DIST);
      x = playerPos.x + Math.cos(angle) * dist;
      z = playerPos.z + Math.sin(angle) * dist;
      let clear = true;
      for (const other of this.entities) {
        if (Math.hypot(x - other.x, z - other.z) < MIN_SEPARATION) {
          clear = false;
          break;
        }
      }
      if (clear) break;
    }

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

    this.entities.push({
      group, x, z,
      tx: x, tz: z,      // last known player position (only once it knows)
      trackTimer: 0,     // >0 while it knows where you are
      blindTimer: 0,
      enrageTimer: 0,
      path: null,
      pathTimer: 0,
      wanderPath: null,  // its own aimless route
      wanderTimer: 0,
      canSee: false,
    });
  }

  // Unbothered: amble along its own route, pick a new one when it runs out.
  _wander(e, dt, world) {
    e.wanderTimer -= dt;
    if (!e.wanderPath || !e.wanderPath.length || e.wanderTimer <= 0) {
      const a = Math.random() * Math.PI * 2;
      const r = 8 + Math.random() * 18;
      e.wanderPath = world.findPath(e.x, e.z, e.x + Math.cos(a) * r, e.z + Math.sin(a) * r);
      e.wanderTimer = 6 + Math.random() * 8;
    }
    if (!e.wanderPath || !e.wanderPath.length) return;

    if (Math.hypot(e.wanderPath[0].x - e.x, e.wanderPath[0].z - e.z) < 0.6) e.wanderPath.shift();
    const next = e.wanderPath[0];
    if (!next) return;

    const ax = next.x - e.x;
    const az = next.z - e.z;
    const d = Math.hypot(ax, az);
    if (d < 0.05) return;
    const step = (WANDER_SPEED * dt) / d;
    _v.set(e.x + ax * step, 0, e.z + az * step);
    world.collide(_v, ENTITY_RADIUS);
    e.x = _v.x;
    e.z = _v.z;
    e.group.position.set(e.x, 0, e.z);
    e.group.rotation.y = Math.atan2(ax, az);
  }

  // Returns true if one caught the player.
  update(dt, playerPos, distance, world) {
    // Keep the world populated. New ones appear far away and out of sight — the
    // world is stocked, they are never dropped on top of you.
    const target = Math.min(BASE_POP + Math.floor(distance / 60), MAX_POP);
    if (this.entities.length < target) this._place(playerPos);

    let caught = false;
    let nearest = Infinity;

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dxp = playerPos.x - e.x;
      const dzp = playerPos.z - e.z;
      const dPlayer = Math.hypot(dxp, dzp);

      if (dPlayer > DESPAWN) { // wandered out of the simulated region
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue;
      }

      // --- Blinded (crucifix) ---
      if (e.blindTimer > 0) {
        e.blindTimer -= dt;
        e.canSee = false;
        nearest = Math.min(nearest, dPlayer);
        e.group.rotation.y += dt * 1.6; // turning blindly on the spot
        continue;
      }

      if (dPlayer < KILL_RADIUS) {
        caught = true;
        nearest = Math.min(nearest, dPlayer);
        continue;
      }
      nearest = Math.min(nearest, dPlayer);

      // --- Does it know about you? ---
      // Sight only works within SIGHT_RANGE — it's pitch black down here, they
      // can't pick you out from across the level.
      const canSee =
        dPlayer < SIGHT_RANGE && !world.segmentBlocked(e.x, e.z, playerPos.x, playerPos.z);
      e.canSee = canSee; // the radar shows a live red dot for anything watching you

      const enraged = e.enrageTimer > 0;
      if (enraged) e.enrageTimer -= dt;

      if (canSee || enraged) {
        e.tx = playerPos.x;
        e.tz = playerPos.z;
        if (canSee) {
          e.trackTimer = LOS_MEMORY;
          e.path = null;
        }
      } else {
        e.trackTimer -= dt;
        if (e.trackTimer > 0) {
          e.tx = playerPos.x;
          e.tz = playerPos.z;
        }
      }

      // --- Unbothered: it never knew, or it has forgotten you. Back to its day.
      if (!canSee && !enraged && e.trackTimer <= 0) {
        this._wander(e, dt, world);
        continue;
      }

      // --- Hunting ---
      let aimX = e.tx;
      let aimZ = e.tz;
      if (!canSee) {
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
        // Enraged, it never drops to a stalk — it just keeps coming.
        const speed = !enraged && dPlayer < CLOSE_RANGE ? BASE_SPEED : CHASE_SPEED;
        const step = (speed * dt) / dAim;
        _v.set(e.x + ax * step, 0, e.z + az * step);
        world.collide(_v, ENTITY_RADIUS);
        e.x = _v.x;
        e.z = _v.z;
        e.group.position.set(e.x, 0, e.z);
      }
      e.group.rotation.y = Math.atan2(dxp, dzp); // eyes on you
    }

    this.nearest = nearest;
    return caught;
  }
}
