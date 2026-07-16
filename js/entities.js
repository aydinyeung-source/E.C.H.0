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
//   1. SOUND -> INVESTIGATE. A noise within earshot doesn't tell them where YOU
//      are — it tells them where the NOISE was. They break off what they were
//      doing and walk over to look. If you've moved on by the time they get
//      there, they find nothing, lose interest, and go back to wandering. Noise
//      marks a SPOT, not you.
//
//   2. SIGHT -> HUNT. They only actually come for you once they SEE you. That's
//      when they lock onto your real position and give chase; break the sightline
//      and they keep coming for LOS_MEMORY seconds, then lose you.
//
//      There are two ways to be seen, and the second is the one that will kill
//      you: they can pick you out of the dark unaided within SIGHT_RANGE — or you
//      can LOOK AT ONE THAT IS LOOKING BACK, at any distance whatsoever. See the
//      BEING SEEN block below; it is the most important rule in the file.
//
// THE SONAR BREAKS BOTH RULES IN YOUR FACE, and that is the point of it:
//
//   * EVERY thing that hears a ping comes looking. Not just the ones already
//     interested — even one that had given up on you, written you off and
//     wandered away is dragged straight back in. Nothing ignores a ping.
//   * And for PING_SIGHT seconds afterwards, SIGHT_RANGE does not apply. Anything
//     with a clear line to you can see you, at ANY distance.
//
// So the ping is not a free look at the map any more. It is you shouting, in the
// dark, in a lit doorway. Fire it from behind a corner and the three seconds pass
// with a wall between you and everything that just turned around. Fire it standing
// in a long straight corridor and you have personally introduced yourself to
// everything in it.
//
// They can't walk through walls: with a sightline they beeline, otherwise they
// A*-path around the maze.
//
// CRUCIALLY, A HUNT ALWAYS ENDS. Two ways out, and both exist so the game is
// something you can EXPLORE rather than a permanent sprint:
//
//   * GIVING UP. Chase you for CHASE_PATIENCE seconds without landing a hand on
//     you and it stops caring. It goes INDIFFERENT for GIVE_UP_TIME seconds:
//     it wanders off and cannot see, hear or hunt you at all during that. It has
//     tried, it has failed, it has better things to do. Without this an entity
//     that clocked you once would tail you for the entire run and there'd be no
//     time to do anything but run.
//
//   * THE CRUCIFIX. Blinds every one of them, and when the blindness lifts they
//     have COMPLETELY FORGOTTEN you — no last-known position, no noise to chase,
//     nothing. They go back to their routes as though you had never been there.
//     The only way one gets you back is by physically SEEING you again: you, in
//     its sight range, in its line of view. It is a true reset button.
//
// Special states:
//   * ENRAGED (torch beam in the face) — hunts you through walls, never stalks
//   * BLINDED (crucifix)               — can't see/hear/track/catch you, then forgets
//   * INDIFFERENT (gave up)            — ignores you entirely and wanders off
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

// --- BEING SEEN --------------------------------------------------------------
//
// There are TWO ways one of these gets you, and the difference between them is the
// whole stealth game now.
//
// 1. IT WALKS INTO YOU. SIGHT_RANGE (2.5 cells) is what it can pick out of the
//    pitch dark by itself — behind you, round a corner, while it's already hunting.
//    Short, because it's black down here and they have no light.
//
// 2. YOU LOOK AT IT AND IT LOOKS BACK. If it is ON YOUR SCREEN and it is FACING
//    YOU, it has you — at ANY distance. No range limit at all.
//
// The second one is the interesting one, and it is deliberately mutual. Something
// shambling across a junction with its back to you, forty metres off, is safe to
// watch. The same thing turning its head towards you while you're staring straight
// at it is not — you have locked eyes with it down a long corridor, and it is now
// coming, and no amount of distance saves you.
//
// The consequence you'll feel in play: LOOK AWAY. Watching a distant thing is how
// you get caught by it. Turning your back on it is safe until it closes to 15m —
// which is a genuinely horrible choice to have to make, and that's the point.
const SIGHT_RANGE = 15; // 2.5 cells

// The cones. Both are half-angles, stored pre-cosined for a straight dot-product
// test.
//   SCREEN — roughly the camera's horizontal field of view, so "on your screen"
//            means what it says. Wider than the 75deg vertical FOV suggests,
//            because at 16:9 the horizontal spread is about 100deg.
//   GAZE   — how far off its own nose something counts as "looking at you". Kept
//            tighter than the screen cone: it has to be more or less facing you,
//            not merely have you somewhere in the corner of its eye.
const SCREEN_COS = Math.cos(0.87); // ~50deg either side of where you're pointed
const GAZE_COS = Math.cos(0.70);   // ~40deg either side of where it's pointed

// THE STARING CONTEST.
//
// Catching a distant thing's eye for a moment is survivable — look away and it goes
// back to its business. But HOLD its gaze, both of you locked on each other, for
// STARE_TO_AGGRO seconds, and something changes. It doesn't just clock you: it
// FIXATES. For AGGRO_HUNT seconds after that it comes for you and does not stop —
// it knows where you are, breaking line of sight won't shake it, and it will not
// give up inside that window. Only a crucifix cuts it short.
//
// This is what stops the mutual-gaze rule from being a free "peek and duck" — you
// can glance, but you cannot STARE. And it's the worst possible outcome of the very
// thing you're tempted to do when you see one far off: keep watching it.
const STARE_TO_AGGRO = 2;  // seconds of unbroken mutual gaze before it fixates
const AGGRO_HUNT = 10;     // seconds of guaranteed, unshakeable pursuit

// THE CORRIDOR CHASE. Once something is already chasing you, it does not lose you
// just because you sprint out past SIGHT_RANGE down a straight hall — it keeps you
// dead in its sights for the whole length of the corridor. But ONLY while you stay
// roughly in line with it: if either axis (x or z) is within CHASE_ALIGN metres,
// sight is unlimited. Break that line — get more than that off-axis on BOTH axes,
// i.e. duck round a corner — and it drops back to ordinary SIGHT_RANGE and can lose
// you. 9m is a corridor and a half, so it holds the line even when you're both
// hugging opposite walls; you have to actually turn off to shake it.
const CHASE_ALIGN = 9;

// THE PING IS NOW GENUINELY DANGEROUS.
//
// For PING_SIGHT seconds after you fire the sonar, SIGHT_RANGE stops applying: any
// entity with a clear line to you can see you, at any distance. The ring doesn't
// just tell them a noise happened over there — for three seconds it lights YOU up.
// Stand in the open at the end of a long straight corridor and ping, and something
// forty metres away now has you.
//
// This is the cost the sonar always should have had. You were buying a free map of
// the level for four energy; now you are buying it by standing in a spotlight, and
// the right move is to duck round a corner BEFORE you fire, so that the three
// seconds elapse with a wall between you and everything that just turned round.
const PING_SIGHT = 3;
const HEAR_RADIUS = 24;             // how far a sonar ping carries (was 40)
const CLOSE_RANGE = 5;              // inside this a hunter slows to 1x and stalks
const LOS_MEMORY = 2;               // seconds it keeps hunting after losing SIGHT
const INVESTIGATE_TIME = 9;         // seconds it spends looking into a noise

// Giving up. CHASE_PATIENCE is how long it will pursue you before deciding this
// isn't working; GIVE_UP_TIME is how long it then ignores you completely. During
// that window it cannot see or hear you no matter what you do — you get a
// guaranteed stretch of quiet to actually explore, loot and (later) do tasks.
const CHASE_PATIENCE = 30; // it will chase this long before it's WILLING to quit —
                           // and even then only once you've broken its line of sight
const GIVE_UP_TIME = 30;

// A siege runs LONGER than an ordinary chase before they lose heart. They know
// exactly where you are and they know you have to come out, so they're prepared
// to work at it — but not forever. Wait one out and you'll live; you just won't
// have the terminal's reward, and the door will be in pieces.
const SIEGE_PATIENCE = 55;
const SIEGE_STAND_OFF = 1.7; // how close to the door they get before hammering
const BANG_INTERVAL = 0.55;  // seconds between blows

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
// The score is CELLS UNCOVERED, so population scales off that: one more of them
// per 20 new cells you've walked into. It tracks how much you've EXPLORED rather
// than how far you got from spawn, so a player who doubles back and searches
// carefully still draws a crowd eventually.
const POP_PER_METRE = 20;           // cells, not metres — the name is a fossil
const PLACE_COOLDOWN = 45;          // seconds between any two new arrivals
// THE ARRIVAL RING.
//
// The MINIMUM is basically gone. It used to be a big number (40m) doing a job that
// something else already does properly: _place refuses any spot that isn't BEHIND A
// WALL, so a close arrival is already, by construction, one you cannot see. Keeping
// a large minimum on top of that was belt-and-braces, and it meant the thing that
// walks around the corner at you always had to have come from a long way off. 12m
// is now the floor — just far enough that one can't materialise on the other side
// of the wall you are currently touching.
//
// The MAXIMUM cannot be removed, and it's worth being honest about why rather than
// pretending it's a design choice. The map is infinite as a CONCEPT, but only
// CHUNK_RADIUS chunks of it are actually built at any moment — 72m guaranteed in
// every direction. Past that edge there is no geometry: no walls to collide with,
// nothing for the pathfinder to route around, no floor. An entity placed out there
// would drift through solid walls until it wandered back into the built world. The
// 70m cap is not "spawns shouldn't be far away", it's "that is where the world
// currently ends".
//
// (If you want them arriving from further out, the lever is CHUNK_RADIUS in
// world.js — build more world, and this can follow it out. It costs geometry.)
const POP_MIN_DIST = 12;
const POP_MAX_DIST = 70;            // the edge of the guaranteed-built world
const MIN_SEPARATION = 22;
const DESPAWN = 90;                 // drop ones that fall far behind, then re-place

// A breach triggers a MANHUNT (see manhunt()). If nothing is at least this close
// when it fires, one is placed out of sight to come and find you — a breach in a
// quiet corner still has to mean something.
const MANHUNT_NEAR = 45;

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
    this.siege = null;                // {x,z} outside a safe-room door, or null
    this.pingSight = 0;               // >0 = they can see you at ANY range right now

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
    this.siege = null;
    this.pingSight = 0;
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

  // A noise. Anything within earshot breaks off and goes to LOOK — but this only
  // tells it where the NOISE was, not where you are. If you're gone when it
  // arrives, it finds nothing and drifts back to wandering. It will only actually
  // hunt you if it SEES you.
  //
  // The sonar is the loud one. Typing at a
  // terminal are quieter, and pass a smaller radius — but they are still noise,
  // and in here noise is the only currency that matters.
  // `wake` = this noise is loud/strange enough to drag back even something that had
  // given up on you and wandered off. Only the SONAR does that.
  hearNoise(x, z, radius = HEAR_RADIUS, wake = false) {
    let heard = 0;
    for (const e of this.entities) {
      if (e.blindTimer > 0) continue;                      // deafened too
      if (e.giveUpTimer > 0 && !wake) continue;            // it doesn't care any more
      if (Math.hypot(e.x - x, e.z - z) > radius) continue; // too far to carry
      if (wake) e.giveUpTimer = 0;                         // it cares again now
      e.nx = x; // where the noise came from
      e.nz = z;
      e.investigateTimer = INVESTIGATE_TIME;
      e.path = null;
      e.wanderPath = null; // it stops what it was doing
      heard++;
    }
    return heard;
  }

  // THE SONAR. Two things, and both of them are bad for you:
  //
  //   1. EVERYTHING that hears it comes looking. Not just the ones already
  //      interested — the ones that had given up on you, written you off and gone
  //      back to their own business are pulled straight back in. There is no such
  //      thing as an entity that ignores a ping.
  //   2. For the next PING_SIGHT seconds they can see you at ANY range.
  //
  // The ping is no longer a free look at the map. It is you shouting in the dark.
  hearSonar(x, z) {
    this.pingSight = PING_SIGHT;
    return this.hearNoise(x, z, HEAR_RADIUS, true);
  }

  // The safe-room siege. While you're sealed in, anything that already knows
  // something is up converges on the OUTSIDE of the door and stays there working
  // on it. Pass null to call the siege off.
  //
  // Note they don't need to see you to keep at it — they watched you go in, and
  // the door is the only way through. This is the one situation where they'll
  // camp a spot indefinitely, which is what makes the room a trap as much as a
  // refuge.
  setSiege(point) {
    this.siege = point || null;
    if (!point) {
      for (const e of this.entities) e.sieging = false;
    }
  }

  // The terminal task completed: the noise stops, the lights come up, and they
  // scatter. Everything nearby gives up, forgets you and walks away — it is the
  // reward for finishing under pressure.
  disperse(x, z, radius, world) {
    let sent = 0;
    for (const e of this.entities) {
      if (Math.hypot(e.x - x, e.z - z) > radius) continue;
      e.sieging = false;
      this._giveUp(e, { x, z }, world);
      e.giveUpTimer = GIVE_UP_TIME * 1.5; // a long walk back to their own business
      sent++;
    }
    return sent;
  }

  // The halon vent: everything caught in the gas is blinded where it stands.
  // Same helpless state the crucifix causes, but local — this is a room-clearing
  // tool, not a global reset.
  blindNear(x, z, radius, duration) {
    let hit = 0;
    for (const e of this.entities) {
      if (Math.hypot(e.x - x, e.z - z) > radius) continue;
      e.blindTimer = Math.max(e.blindTimer, duration);
      e.huntTimer = 0;
      e.investigateTimer = 0;
      e.enrageTimer = 0;
      e.sieging = false;
      e.chaseTime = 0;
      e.path = null;
      hit++;
    }
    return hit;
  }

  // Crucifix: BLINDS EVERY entity for `duration`. A blinded one can't see, hear,
  // track or catch you — it just gropes around where it stands.
  //
  // And when it comes round, it has FORGOTTEN YOU. Everything that constitutes
  // knowing about you is wiped: the hunt, the noise it was walking towards, the
  // torch rage, the last place it saw you, the route it was taking to get there.
  // It resumes its own life. The ONLY thing that can bring it back onto you is
  // physically seeing you again — in range, in line of sight. That's the point of
  // the crucifix: it doesn't buy you seven seconds, it buys you a clean slate.
  blindAll(duration) {
    for (const e of this.entities) {
      e.blindTimer = duration;
      e.huntTimer = 0;        // it loses you entirely
      e.investigateTimer = 0; // and forgets the noise it was chasing
      e.enrageTimer = 0;      // and snaps out of any torch rage
      e.aggroTimer = 0;       // the crucifix is the ONE thing that ends a fixation
      e.stareTime = 0;
      e.chaseTime = 0;
      e.tx = e.x;             // no last-known position of yours to return to
      e.tz = e.z;
      e.nx = e.x;             // and no noise to go and look into
      e.nz = e.z;
      e.path = null;
      e.wanderPath = null;    // it'll pick a fresh route of its own when it wakes
    }
    return this.entities.length;
  }

  // Torch beam in the face: it tracks you through walls and never stalks.
  // Note this also drags an INDIFFERENT one back into the fight — one that had
  // given up and wandered off will not stay disinterested if you go and shine a
  // light in its eyes. That's on you.
  enrage(entity, duration) {
    if (entity.blindTimer > 0) return;
    entity.giveUpTimer = 0;
    entity.chaseTime = 0; // freshly provoked: full patience again
    entity.enrageTimer = Math.max(entity.enrageTimer, duration);
  }

  // THE MANHUNT. A safe-room door has been breached — you failed the task, and now
  // there is no hiding it. For `duration` seconds every entity that can still see
  // (not the crucifix-blinded ones) KNOWS where you are and keeps knowing it: it
  // tracks your live position through walls and comes straight in, no stalking, no
  // giving up until the timer runs out. Mechanically this is a blanket enrage.
  //
  // And if nothing is close enough to actually threaten you, one is brought in from
  // out of sight (behind a wall — _place guarantees you never watch it arrive) so a
  // breach in an empty stretch of maze still turns into a chase.
  manhunt(duration, playerPos, world) {
    for (const e of this.entities) this.enrage(e, duration);

    if (!playerPos || !world) return;
    const threatNear = this.entities.some(
      (e) => e.blindTimer <= 0 && Math.hypot(e.x - playerPos.x, e.z - playerPos.z) < MANHUNT_NEAR
    );
    if (!threatNear && this._place(playerPos, world)) {
      this.enrage(this.entities[this.entities.length - 1], duration);
    }
  }

  // --- The home screen ------------------------------------------------------
  // One of them, wandering the halls behind the menu. It has no AI: it doesn't
  // know you exist, it can't see you, it will never come for you. It just walks.
  //
  // It uses the SAME pathing as a real one, so it follows actual corridors and
  // turns actual corners instead of gliding through walls. Its eyes are unlit
  // basic material — two red points that stay visible in total darkness — so most
  // of the time all you get is a pair of eyes drifting across the black behind
  // the login form, and occasionally the ambient ping catches its silhouette.
  menuStart(world, origin) {
    if (this.entities.length) return;
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 14;
      const x = origin.x + Math.cos(a) * r;
      const z = origin.z + Math.sin(a) * r;
      if (!world.findPath(origin.x, origin.z, x, z)) continue; // somewhere it can actually walk
      this._spawnAt(x, z);
      return;
    }
  }

  // Menu-only tick: wander, nothing else.
  menuUpdate(dt, world) {
    for (const e of this.entities) this._wander(e, dt, world);
    this._syncEyeLights();
  }

  // Put one out in the world. It must be far away, clear of the others, and —
  // critically — BEHIND A WALL. Not "far enough away", not "lost in the fog":
  // there must be solid geometry between you and the spot, every time.
  //
  // The fog used to count as cover, and it was the wrong idea. Something fading
  // into existence at the far end of a corridor still LOOKS like it spawned, even
  // if it's dim — and the entire fiction here is that these things were already in
  // the maze, minding their own business, long before you turned up. If you never
  // see one arrive, then as far as the game is concerned it was always there. So a
  // wall it is: it walks out from somewhere you couldn't see, like it had been
  // there all along.
  //
  // If no attempt finds a spot behind a wall, we place NOTHING and try again next
  // frame. Being one entity short for a moment is always better than popping one
  // into view — and with a 60m sightline it will be short-handed more often than
  // it used to be. That's the correct trade.
  _place(playerPos, world) {
    for (let attempt = 0; attempt < 40; attempt++) {
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

      // The only test that matters: is there a wall in the way?
      if (!world.segmentBlocked(playerPos.x, playerPos.z, x, z)) continue;

      this._spawnAt(x, z);
      return true;
    }
    return false; // nothing hidden enough right now — retry next frame
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
      chaseTime: 0,        // how long this pursuit has been going on and failing
      giveUpTimer: 0,      // >0 while it has lost interest and is ignoring you
      stareTime: 0,        // seconds of unbroken mutual gaze so far
      aggroTimer: 0,       // >0 while fixated by a staring contest (unshakeable)
      sieging: false,      // camped on a safe-room door, trying to get through it
      bangTimer: 0,        // cadence of its blows against the door
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

  // It's had enough. Drop everything it knows about the player, ignore them for
  // GIVE_UP_TIME, and walk off in roughly the opposite direction so it visibly
  // breaks away instead of loitering on top of you while pretending not to care.
  _giveUp(e, playerPos, world) {
    e.huntTimer = 0;
    e.investigateTimer = 0;
    e.enrageTimer = 0;
    e.aggroTimer = 0; // whatever fixated it has long since worn off by now
    e.stareTime = 0;
    e.chaseTime = 0;
    e.giveUpTimer = GIVE_UP_TIME;
    e.path = null;

    const away = Math.atan2(e.z - playerPos.z, e.x - playerPos.x);
    const spread = away + (Math.random() - 0.5) * 1.2; // not a dead-straight retreat
    const r = 16 + Math.random() * 12;
    e.wanderPath = world.findPath(e.x, e.z, e.x + Math.cos(spread) * r, e.z + Math.sin(spread) * r);
    e.wanderTimer = 8 + Math.random() * 6;
  }

  // Returns true if one caught the player.
  // `playerYaw` is needed for the mutual-gaze rule: we have to know where the
  // player is LOOKING, not just where they are standing.
  update(dt, playerPos, playerYaw, distance, world) {
    // Keep the world populated — but SLOWLY. New ones appear far away and out of
    // sight, and only one can turn up per PLACE_COOLDOWN, so the maze fills in
    // over minutes rather than seconds. If _place can't find a hidden spot it
    // returns false and we keep the cooldown spent-out, so it retries next frame
    // instead of waiting another 45s.
    // The ping's afterglow: while this is running, they can see you at any range.
    if (this.pingSight > 0) this.pingSight -= dt;

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

      // --- Indifferent (it gave up on you) ---
      // It is not blind and not stupid — walk into it and it will still take you.
      // But it is not looking for you, it cannot hear you, and it will not chase.
      // Use the window.
      if (e.giveUpTimer > 0) {
        e.giveUpTimer -= dt;
        e.canSee = false;
        nearest = Math.min(nearest, dPlayer);
        if (dPlayer < KILL_RADIUS) {
          caught = true;
          continue;
        }
        this._wander(e, dt, world);
        continue;
      }

      // --- It got you ---
      // And it does not survive the exchange. Whatever these things are, taking a
      // person costs them everything — it burns itself out doing it and is gone.
      //
      // In a normal run this is flavour: the run is over anyway. Where it MATTERS
      // is that it stops the kill being a state you sit inside. Previously an
      // entity that reached you just stood there catching you, over and over,
      // every frame. Now one catch spends one of them, the maze is quieter for it,
      // and the population cooldown means the space it leaves stays empty a while.
      if (dPlayer < KILL_RADIUS) {
        caught = true;
        nearest = Math.min(nearest, dPlayer);
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue;
      }
      nearest = Math.min(nearest, dPlayer);

      // --- Besieging a safe room ---
      // You sealed yourself in. Anything that was already onto you converges on
      // the far side of the door and goes to work on it. It cannot see you and
      // does not need to: it watched you go in, and there's one way out.
      if (this.siege) {
        const aware =
          e.sieging || e.huntTimer > 0 || e.investigateTimer > 0 || e.enrageTimer > 0;
        if (aware) {
          e.sieging = true;
          e.canSee = false; // the door is between you; nothing has eyes on you
          e.chaseTime += dt;
          if (e.chaseTime >= SIEGE_PATIENCE) {
            this._giveUp(e, playerPos, world); // it can't get through. it leaves.
            continue;
          }

          const dDoor = Math.hypot(this.siege.x - e.x, this.siege.z - e.z);
          if (dDoor > SIEGE_STAND_OFF) {
            this._goTo(e, dt, world, this.siege.x, this.siege.z, INVESTIGATE_SPEED);
          } else {
            // At the door. Face it and hammer. The lunge is what you see through
            // the gap under it, and what the durability drain is metered against
            // (game side: it counts who is standing here).
            e.group.rotation.y = Math.atan2(playerPos.x - e.x, playerPos.z - e.z);
            e.bangTimer -= dt;
            if (e.bangTimer <= 0) {
              e.bangTimer = BANG_INTERVAL;
              e.banging = true; // one blow this frame — the game plays the hit
            }
            const lunge = Math.max(0, e.bangTimer / BANG_INTERVAL - 0.7) * 0.6;
            e.group.position.set(e.x, lunge, e.z);
          }
          continue;
        }
      } else if (e.sieging) {
        e.sieging = false; // siege called off (you left, or the door came down)
      }

      // --- Can it SEE you? That is the only thing that starts a hunt. ---
      //
      // A clear sightline is required for ALL of it — a wall is always a wall — and
      // then any ONE of these three is enough:
      //
      //   a) it's within SIGHT_RANGE. It found you in the dark, unaided.
      //   b) MUTUAL GAZE: it is on your screen AND it is facing you. Any distance.
      //      You locked eyes with it, and that's that.
      //   c) the ping is still lit. For PING_SIGHT seconds after a sonar, distance
      //      and facing both stop mattering entirely — you shouted.
      const clearLine = !world.segmentBlocked(e.x, e.z, playerPos.x, playerPos.z);

      // MUTUAL GAZE is computed at ANY range (not just outside SIGHT_RANGE), because
      // the staring contest below has to know when you're locked on each other even
      // when it's close.
      let mutualGaze = false;
      if (clearLine && dPlayer > 0.001) {
        const tx = dxp / dPlayer;
        const tz = dzp / dPlayer;
        // On your screen? Your forward is -Z at yaw 0.
        const pfx = -Math.sin(playerYaw);
        const pfz = -Math.cos(playerYaw);
        const onScreen = pfx * -tx + pfz * -tz > SCREEN_COS;
        // Looking back? Its forward is its actual heading — so one ambling ACROSS
        // your view with its back to you cannot see you, however hard you stare.
        const efx = Math.sin(e.group.rotation.y);
        const efz = Math.cos(e.group.rotation.y);
        const lookingAtYou = efx * tx + efz * tz > GAZE_COS;
        mutualGaze = onScreen && lookingAtYou;
      }

      // Sustained mutual gaze fixates it (see STARE_TO_AGGRO). The timer only fills
      // while you're actually locked on each other; break it and it drains, so a
      // long on-and-off stare still counts but a flicker doesn't.
      if (mutualGaze) {
        e.stareTime += dt;
        if (e.stareTime >= STARE_TO_AGGRO) e.aggroTimer = AGGRO_HUNT;
      } else {
        e.stareTime = Math.max(0, e.stareTime - dt);
      }
      if (e.aggroTimer > 0) e.aggroTimer -= dt;
      const aggro = e.aggroTimer > 0;
      const enraged = e.enrageTimer > 0;

      // Is it ALREADY in pursuit (from a previous frame)? That's what unlocks the
      // corridor chase below — you can't trigger the unlimited-range sight cold, it
      // only extends a chase that has already started.
      const chasing = e.huntTimer > 0 || aggro || enraged;
      // Roughly in line down a corridor? Within CHASE_ALIGN on EITHER axis.
      const aligned = Math.abs(dxp) <= CHASE_ALIGN || Math.abs(dzp) <= CHASE_ALIGN;
      const chaseSight = chasing && aligned;

      // A clear sightline is required, then any of: within SIGHT_RANGE, mutual gaze,
      // the ping still lit, or a corridor chase (already chasing AND in line).
      const canSee =
        clearLine && (this.pingSight > 0 || dPlayer < SIGHT_RANGE || mutualGaze || chaseSight);
      e.canSee = canSee; // the radar shows a live red dot for anything watching you

      if (enraged) e.enrageTimer -= dt;

      if (canSee) {
        e.tx = playerPos.x;
        e.tz = playerPos.z;
        e.huntTimer = LOS_MEMORY; // it has you; it keeps this for 2s after losing sight
        e.investigateTimer = 0;   // no need to search — it's looking right at you
        e.path = null;
      } else {
        e.huntTimer -= dt;
        if (e.huntTimer > 0 || enraged || aggro) {
          // Still knows where you are: recent sight, torch-rage, or fixated by a
          // staring contest — a fixated one tracks your real position through walls.
          e.tx = playerPos.x;
          e.tz = playerPos.z;
        }
      }

      const hunting = canSee || enraged || aggro || e.huntTimer > 0;

      // --- Patience ---
      // Time spent pursuing you piles up; time not pursuing bleeds it back off at
      // half rate, so a long on-and-off chase still wears it down.
      //
      // BUT IT WILL NOT GIVE UP WHILE IT CAN SEE YOU. That's the whole point: you
      // cannot flat-out outrun it down a straight corridor and wait for it to lose
      // interest — as long as it has eyes on you, it comes, however long that takes.
      // The give-up only fires once you've actually BROKEN its line of sight (and
      // stayed out of it). So the clock keeps running while you're visible, but the
      // reward for a long chase — it quits and leaves you alone for GIVE_UP_TIME —
      // is only paid out the moment you finally turn a corner and get out of sight.
      //
      // A fixated one (aggro) can't give up at all until the fixation lapses.
      if (hunting) {
        e.chaseTime += dt;
        if (e.chaseTime >= CHASE_PATIENCE && !canSee && !aggro) {
          this._giveUp(e, playerPos, world);
          e.canSee = false;
          this._wander(e, dt, world);
          continue;
        }
      } else {
        e.chaseTime = Math.max(0, e.chaseTime - dt * 0.5);
      }

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
      // Beeline ONLY if the body can actually make that line. It's possible to SEE
      // the player and still not be able to walk to them straight: a smashed window
      // or an open doorway ward is a hole you can see through but not fit through.
      // Spot one of those in the way and route AROUND it instead of grinding into
      // the sill — the whole "it knows it's a window" behaviour.
      const seeThroughHole = canSee && world.segmentBlockedForEntity(e.x, e.z, e.tx, e.tz);
      if (!canSee || seeThroughHole) {
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
        } else if (seeThroughHole) {
          // Seen you through a hole it can't use, and no way around it right now:
          // hold and watch rather than mime walking into the glass.
          aimX = e.x;
          aimZ = e.z;
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
