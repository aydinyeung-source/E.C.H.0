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
// Awareness is TWO-STAGE, and the distinction is the whole stealth game:
//
//   1. SOUND -> INVESTIGATE. A sonar ping within HEAR_RADIUS doesn't tell them
//      where YOU are — it tells them where the NOISE was. They break off what
//      they were doing and walk over to look. If you've moved on by the time
//      they get there, they find nothing, lose interest, and go back to
//      wandering. Pinging marks a SPOT, not you.
//
//   2. SIGHT -> HUNT. They only actually come for you once they SEE you: a clear
//      sightline within SIGHT_RANGE. That's when they lock onto your real
//      position and give chase. Break the sightline and they keep coming for
//      LOS_MEMORY seconds, then lose you.
//
// So a ping in a corridor you're about to leave is survivable. A ping while
// standing in their line of sight is not.
//
// They can't walk through walls: with a sightline they beeline, otherwise they
// A*-path around the maze.
//
// Special states:
//   * ENRAGED (torch beam in the face) — hunts you through walls, never stalks
//   * BLINDED (crucifix)               — can't see/hear/track/catch you at all
// -----------------------------------------------------------------------------

const BODY_COLOR = 0x0a0a0a;
const EYE_COLOR = 0xff1f1f;

const WANDER_SPEED = 1.3;           // an unbothered amble
const INVESTIGATE_SPEED = 2.2;      // a purposeful walk toward a strange noise
const BASE_SPEED = 2.2;             // "1x" — a hunter stalking you at close range
// 2.5x when hunting from range — but HARD-CAPPED below the player's sprint so a
// running player can always break away. Derived from the player's actual run
// speed, so retuning that can never accidentally make them un-outrunnable.
// (2.2*2.5 = 5.5 vs the 6.46 cap, so it lands at 5.5 — faster than your 5.1 walk,
// comfortably slower than your 7.6 sprint.)
const CHASE_SPEED = Math.min(BASE_SPEED * 2.5, PLAYER_RUN_SPEED * 0.85);

// How far they can actually see you. Deliberately SHORT: it is pitch black down
// here and they have no light of their own. Standing at the far end of a long
// straight corridor is NOT automatically being seen — you have to be close for
// them to pick you out of the dark. This is what makes a straight run past an
// open junction survivable.
const SIGHT_RANGE = 12;
const HEAR_RADIUS = 24;             // how far a sonar ping carries (was 40)
const CLOSE_RANGE = 5;              // inside this a hunter slows to 1x and stalks
const LOS_MEMORY = 2;               // seconds it keeps hunting after losing SIGHT
const INVESTIGATE_TIME = 9;         // seconds it spends looking into a noise

const KILL_RADIUS = 0.9;
const ENTITY_RADIUS = 0.35;
const REPATH_INTERVAL = 0.5;

// Population. SPARSE — this place is abandoned, not infested. You start with ONE
// thing out there somewhere, and the world only ever gets more crowded slowly, as
// a reward for surviving distance.
//
// PLACE_COOLDOWN is the important one. Without it the top-up ran every single
// frame, so the instant something despawned or the target ticked up, a
// replacement appeared immediately — the population was always pinned at max and
// two of them were on you inside twenty seconds. Now a new inhabitant can only
// turn up once every PLACE_COOLDOWN seconds, so thinning them out actually buys
// you real quiet time.
const BASE_POP = 1;
const MAX_POP = 3;
const POP_PER_METRE = 120;          // +1 to the target every 120m survived
const PLACE_COOLDOWN = 45;          // seconds between any two new arrivals
const POP_MIN_DIST = 30;            // always well beyond SIGHT_RANGE
const POP_MAX_DIST = 50;
const FOG_HIDE_DIST = 42;           // past here the fog has eaten everything anyway
const MIN_SEPARATION = 22;
const DESPAWN = 60;                 // drop ones that fall far behind, then re-place

// Their eyes give off the faintest red light. It reaches barely a couple of
// metres — it will never light your way — but if one is close and behind you, the
// wall beside you picks up a dim red wash. It's a warning you catch out of the
// corner of your eye, so you're not forced to stare at the radar the whole run.
const EYE_LIGHT_COLOR = 0xff2a2a;
const EYE_LIGHT_INTENSITY = 0.55;
const EYE_LIGHT_RANGE = 5;          // metres; falls off to nothing well before you

const _v = new THREE.Vector3();

export class EntitySystem {
  constructor(scene) {
    this.scene = scene;
    this.entities = [];
    this.nearest = Infinity;
    this.placeTimer = PLACE_COOLDOWN; // no new arrivals for the first stretch

    // A FIXED pool of eye lights, created once and never added/removed. Three.js
    // bakes the light count into every shader it compiles, so adding or removing
    // a live light forces a full material recompile — which would hitch the frame
    // exactly when something turns up behind you. Instead these always exist; an
    // unused one just sits at intensity 0, which costs nothing visually and keeps
    // the light count constant.
    this.eyeLights = [];
    for (let i = 0; i < MAX_POP; i++) {
      const light = new THREE.PointLight(EYE_LIGHT_COLOR, 0, EYE_LIGHT_RANGE, 2);
      scene.add(light);
      this.eyeLights.push(light);
    }

    this.bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    this.headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    this.eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.bodyMat = new THREE.MeshPhongMaterial({ color: BODY_COLOR, shininess: 0 });
    installReveal(this.bodyMat); // the sonar rings reveal their shape
    this.eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR });
  }

  // Wipe and re-populate the world around the spawn point.
  reset(playerPos, world) {
    for (const e of this.entities) this.scene.remove(e.group);
    this.entities = [];
    this.nearest = Infinity;
    this.placeTimer = PLACE_COOLDOWN;
    for (const light of this.eyeLights) light.intensity = 0;
    if (playerPos && world) {
      for (let i = 0; i < BASE_POP; i++) this._place(playerPos, world);
    }
  }

  // Park an eye light on each living entity and switch the spares off. Called
  // every frame, after the entity list has settled.
  _syncEyeLights() {
    for (let i = 0; i < this.eyeLights.length; i++) {
      const light = this.eyeLights[i];
      const e = this.entities[i];
      if (!e) {
        light.intensity = 0; // stays in the scene — see the pool comment above
        continue;
      }
      light.position.set(e.x, 1.62, e.z); // between the eyes
      // A blinded one's eyes gutter down to almost nothing.
      light.intensity = e.blindTimer > 0 ? EYE_LIGHT_INTENSITY * 0.25 : EYE_LIGHT_INTENSITY;
    }
  }

  // The sonar: an unfamiliar sound. Anything within earshot breaks off and goes
  // to LOOK — but this only tells it where the NOISE was, not where you are. If
  // you're gone when it arrives, it finds nothing and drifts back to wandering.
  // It will only actually hunt you if it SEES you.
  hearSonar(x, z) {
    let heard = 0;
    for (const e of this.entities) {
      if (e.blindTimer > 0) continue;                           // deafened too
      if (Math.hypot(e.x - x, e.z - z) > HEAR_RADIUS) continue; // too far to carry
      e.nx = x; // where the noise came from
      e.nz = z;
      e.investigateTimer = INVESTIGATE_TIME;
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
      e.huntTimer = 0;        // it loses you entirely
      e.investigateTimer = 0; // and forgets the noise it was chasing
      e.enrageTimer = 0;      // and snaps out of any torch rage
      e.path = null;
    }
    return this.entities.length;
  }

  // Torch beam in the face: it tracks you through walls and never stalks.
  enrage(entity, duration) {
    if (entity.blindTimer > 0) return;
    entity.enrageTimer = Math.max(entity.enrageTimer, duration);
  }

  // Put one out in the world. It must be far away, clear of the others, and —
  // critically — SOMEWHERE YOU CANNOT SEE. You must never watch one appear: it's
  // unfair, it wrecks a run, and it destroys the fiction that they were already
  // here. A spot only counts as hidden if a wall stands between you and it, or
  // it's so far out that the fog has swallowed it entirely.
  //
  // If no attempt finds a hidden spot, we place NOTHING and try again next frame.
  // Being one entity short for a moment is always better than popping one into
  // view.
  _place(playerPos, world) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = POP_MIN_DIST + Math.random() * (POP_MAX_DIST - POP_MIN_DIST);
      const x = playerPos.x + Math.cos(angle) * dist;
      const z = playerPos.z + Math.sin(angle) * dist;

      let clear = true;
      for (const other of this.entities) {
        if (Math.hypot(x - other.x, z - other.z) < MIN_SEPARATION) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      const behindWall = world.segmentBlocked(playerPos.x, playerPos.z, x, z);
      const lostToFog = dist > FOG_HIDE_DIST;
      if (!behindWall && !lostToFog) continue; // you'd have SEEN that. try again.

      this._spawnAt(x, z);
      return true;
    }
    return false; // nowhere hidden right now — leave it, we'll retry next frame
  }

  _spawnAt(x, z) {
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
      tx: x, tz: z,        // last known PLAYER position (only once it has seen you)
      nx: x, nz: z,        // where the last NOISE came from
      huntTimer: 0,        // >0 while it's actively hunting you (needs sight)
      investigateTimer: 0, // >0 while it's going to look into a noise
      blindTimer: 0,
      enrageTimer: 0,
      path: null,
      pathTimer: 0,
      wanderPath: null,    // its own aimless route
      wanderTimer: 0,
      canSee: false,
    });
  }

  // Walk to a fixed point, routing around walls. Used for investigating a noise.
  _goTo(e, dt, world, gx, gz, speed) {
    e.pathTimer -= dt;
    if (!e.path || !e.path.length || e.pathTimer <= 0) {
      e.path = world.findPath(e.x, e.z, gx, gz);
      e.pathTimer = REPATH_INTERVAL;
    }

    let aimX = gx;
    let aimZ = gz;
    if (e.path && e.path.length) {
      if (Math.hypot(e.path[0].x - e.x, e.path[0].z - e.z) < 0.6) e.path.shift();
      if (e.path.length) {
        aimX = e.path[0].x;
        aimZ = e.path[0].z;
      }
    }

    const ax = aimX - e.x;
    const az = aimZ - e.z;
    const d = Math.hypot(ax, az);
    if (d < 0.4) return; // arrived — it stands here and looks around
    const step = (speed * dt) / d;
    _v.set(e.x + ax * step, 0, e.z + az * step);
    world.collide(_v, ENTITY_RADIUS);
    e.x = _v.x;
    e.z = _v.z;
    e.group.position.set(e.x, 0, e.z);
    e.group.rotation.y = Math.atan2(ax, az);
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
    // Keep the world populated — but SLOWLY. New ones appear far away and out of
    // sight, and only one can turn up per PLACE_COOLDOWN, so the maze fills in
    // over minutes rather than seconds. If _place can't find a hidden spot it
    // returns false and we keep the cooldown spent-out, so it retries next frame
    // instead of waiting another 45s.
    this.placeTimer -= dt;
    const target = Math.min(BASE_POP + Math.floor(distance / POP_PER_METRE), MAX_POP);
    if (this.entities.length < target && this.placeTimer <= 0) {
      if (this._place(playerPos, world)) this.placeTimer = PLACE_COOLDOWN;
    }

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

      // --- Can it SEE you? That is the only thing that starts a hunt. ---
      // Sight is bounded by SIGHT_RANGE — it's pitch black down here, they can't
      // pick you out from across the level.
      const canSee =
        dPlayer < SIGHT_RANGE && !world.segmentBlocked(e.x, e.z, playerPos.x, playerPos.z);
      e.canSee = canSee; // the radar shows a live red dot for anything watching you

      const enraged = e.enrageTimer > 0;
      if (enraged) e.enrageTimer -= dt;

      if (canSee) {
        e.tx = playerPos.x;
        e.tz = playerPos.z;
        e.huntTimer = LOS_MEMORY; // it has you; it keeps this for 2s after losing sight
        e.investigateTimer = 0;   // no need to search — it's looking right at you
        e.path = null;
      } else {
        e.huntTimer -= dt;
        if (e.huntTimer > 0 || enraged) {
          // Still knows where you are (recent sight, or torch-rage through walls).
          e.tx = playerPos.x;
          e.tz = playerPos.z;
        }
      }

      const hunting = canSee || enraged || e.huntTimer > 0;

      // --- Investigating a noise (not you) ---
      // It heard the sonar and is going to look. It does NOT know where you are —
      // it only knows where the sound came from. Get out of the way and it will
      // arrive, find nothing, and give up.
      if (!hunting) {
        if (e.investigateTimer > 0) {
          e.investigateTimer -= dt;
          this._goTo(e, dt, world, e.nx, e.nz, INVESTIGATE_SPEED);
        } else {
          this._wander(e, dt, world); // back to its day
        }
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

    this._syncEyeLights();
    this.nearest = nearest;
    return caught;
  }
}
