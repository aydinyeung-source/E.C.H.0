// saferoom.js
// -----------------------------------------------------------------------------
// THE SAFE ROOM SIEGE.
//
// Every so often (8% of chunks) the hallways open into a sealed room with a heavy
// door. It is the only place in the game you are safe — and getting safe is what
// makes you unsafe.
//
// THE LOOP:
//   1. FIND IT. A locked door with a 4-digit serial stencilled on it. The sonar
//      brings it back as a bright cyan echo instead of the usual green, so you
//      can pick it out of a corridor at a glance.
//   2. FIND THE SWITCH. The matching KeySwitch is bolted to a wall somewhere out
//      in the hallways, 3-5 cells away, carrying the SAME serial. You have to go
//      out there, read it in the dark, and know it's the right one. Pulling it
//      unlocks the door — it does not open it.
//   3. GET IN. The door stays shut. You have to physically shove it open with
//      your body. Walk into a still-locked door and you just bounce off it.
//   4. THE SIEGE. The door swings shut behind you and you are safe — and
//      everything that was following you now knows exactly where you are and has
//      nowhere else to be. They pile up outside and start working on the door.
//   5. THE TASK. The terminal at the back needs codes typed into it. Using it
//      locks your camera to the screen — you cannot watch the door while you
//      work. The door loses durability the whole time.
//   6. THE PLANKS. Three loose planks on the floor. Hold [E] on the door to nail
//      one in: +30% durability. Every second spent boarding up is a second not
//      spent on the task.
//   7. FINISH IT. The terminal chimes, the things outside scatter, and the
//      locker pops open with something in it.
//
// AND IF THE DOOR GOES DOWN:
//   The frame is destroyed for good. The room is now just a room with a dead end
//   and three of them in it. But the terminal still works, and the reward is
//   still in the locker — and typing at it makes NOISE. That's the gamble: the
//   safest place in the game becomes the worst place in the game, and it's still
//   the only place with a reward. The panic button by the door is the one thing
//   standing between you and that being the end of the run.
// -----------------------------------------------------------------------------

import { CELL, WALL_H, chunkRoom, isWall } from "./world.js";
import { installReveal } from "./reveal.js";

const LOAD_RADIUS = 2;          // chunks around the player whose rooms get built

const DOOR_H = 2.7;
const DOOR_T = 0.34;
const DOOR_MAX = 100;
// Durability drain, per second, PER besieger standing at the door. One thing out
// there gives you about a minute; three give you twenty seconds. The pressure is
// how many of them you brought with you.
const DECAY_PER_ENTITY = 1.7;
const PLANK_REPAIR = 30;
const REPAIR_HOLD = 1.5;        // seconds of holding [E] to nail one in
const PUSH_DIST = 1.6;          // how close you must be to shoulder the door
const REACH = 2.5;              // interaction reach for everything else
const OPEN_TIME = 2.2;          // how long the door stands open before swinging to
const THUD_COOLDOWN = 0.7;

const PLANK_COUNT = 3;
const TASK_CODES = 3;           // codes to type before the task is done
const TYPE_NOISE_SAFE = 13;     // how far your typing carries with the door intact
const TYPE_NOISE_BREACHED = 30; // ...and with the door gone. A dinner bell.
const TYPE_NOISE_INTERVAL = 2.0;

const PANIC_RADIUS = 20;
const PANIC_STUN = 5;

const REWARDS = ["meat", "torch", "crucifix"];

// Cyan: the colour of everything man-made and functional in here. It exists to be
// unmistakable against the green sonar and the yellow walls — if you see cyan,
// something in that direction can be used.
const ECHO_CYAN = 0x27e0ff;

// A canvas texture of the 4-digit serial, self-lit so it can actually be READ in
// the pitch dark. This is the one concession: without it the whole mechanic would
// be "wander around hoping", because you cannot read stencilled paint by echo.
function makeSerialTexture(serial) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#04161c";
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = "#27e0ff";
  g.lineWidth = 4;
  g.strokeRect(6, 6, 244, 116);
  g.fillStyle = "#8ff4ff";
  g.font = "bold 74px 'Courier New', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "#27e0ff";
  g.shadowBlur = 18;
  g.fillText(serial, 128, 68);
  return new THREE.CanvasTexture(c);
}

export class SafeRooms {
  constructor(scene, world, audio, entities, inv, fx) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.entities = entities;
    this.inv = inv; // { give(type,n), has(type), take(type) }
    this.fx = fx;   // { halon(), taskDone(), breach() } — screen/HUD effects

    this.rooms = new Map();     // chunk key -> room state (SURVIVES streaming)
    this.playerIsSafe = false;
    this.active = null;         // the room you're standing in or at
    this.prompt = null;         // { text, kind } for the HUD
    this.terminal = null;       // { room, typed } while the camera is on a screen
    this.hud = null;            // { pct, sieging } for the durability bar
    this._repair = 0;           // seconds of [E] held on the door so far
    this._thud = 0;
    this._typeNoise = 0;

    // --- Shared materials ---------------------------------------------------
    // The door and the switch echo CYAN, not green. installReveal takes a private
    // tint for exactly this. Over-bright on purpose (>1) so the ring hitting them
    // reads as a hard flash rather than a tint.
    const cyanFlash = new THREE.Color(ECHO_CYAN).multiplyScalar(2.6);
    this.doorMat = new THREE.MeshPhongMaterial({ color: 0x8e99a6, shininess: 10 });
    installReveal(this.doorMat, cyanFlash);
    this.wreckMat = new THREE.MeshPhongMaterial({ color: 0x3a3f46, shininess: 0 });
    installReveal(this.wreckMat);
    this.switchMat = new THREE.MeshPhongMaterial({ color: 0xc4342c, shininess: 8 });
    installReveal(this.switchMat, cyanFlash);
    this.metalMat = new THREE.MeshPhongMaterial({ color: 0x767f8a, shininess: 6 });
    installReveal(this.metalMat);
    this.woodMat = new THREE.MeshPhongMaterial({ color: 0x8a6a3c, shininess: 0 });
    installReveal(this.woodMat);

    // Self-lit bits. These IGNORE the darkness — a screen, a glowing button and a
    // stencilled number are meant to be findable, and a room you can't find is
    // just a wall.
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x1cff8f });
    this.panicMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    this.plankGlowMat = new THREE.MeshBasicMaterial({ color: 0xe8b464 });
    this.leverMat = new THREE.MeshBasicMaterial({ color: 0xffe36b });
    // Whatever the locker coughs up, in the same colours the item has everywhere
    // else — you should recognise it on the floor without reading a label.
    this.rewardMats = {
      meat: new THREE.MeshBasicMaterial({ color: 0xa5301a }),
      torch: new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
      crucifix: new THREE.MeshBasicMaterial({ color: 0xf2ead0 }),
    };

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.plateGeo = new THREE.PlaneGeometry(0.7, 0.35);
  }

  reset() {
    for (const room of this.rooms.values()) this._unload(room);
    this.rooms.clear();
    this.playerIsSafe = false;
    this.active = null;
    this.prompt = null;
    this.terminal = null;
    this.hud = null;
    this._repair = 0;
    this.world.extraBounds = [];
    this.world.pathGate = null;
  }

  // --- Room state -----------------------------------------------------------
  _state(spec) {
    let room = this.rooms.get(spec.key);
    if (room) return room;

    // The task's codes are derived from the serial, so the daily challenge sets
    // everyone the identical task in the identical room.
    const n = Number(spec.serial);
    const codes = [];
    for (let k = 0; k < TASK_CODES; k++) {
      codes.push(String(1000 + ((n * (k + 7) * 37) % 9000)));
    }

    room = {
      spec,
      group: null,
      door: { state: "locked", durability: DOOR_MAX, openTimer: 0 },
      switchPulled: false,
      task: { index: 0, done: false },
      lockerOpen: false,
      panicUsed: false,
      reward: REWARDS[n % REWARDS.length],
      props: [], // planks, and later the locker's contents
      _propsSpawned: false,
      meshes: {},
      bounds: null,
    };
    this.rooms.set(spec.key, room);
    return room;
  }

  // --- Build / tear down ----------------------------------------------------
  _load(room) {
    if (room.group) return;
    const s = room.spec;
    const g = new THREE.Group();
    room.meshes = {};

    // --- The door ----------------------------------------------------------
    const d = s.door;
    const door = new THREE.Mesh(this.boxGeo, this.doorMat);
    const width = CELL * 0.94;
    door.scale.set(d.horiz ? width : DOOR_T, DOOR_H, d.horiz ? DOOR_T : width);
    door.position.set(d.x, DOOR_H / 2, d.z);
    g.add(door);
    room.meshes.door = door;

    // The serial, stencilled on both faces so it reads from either side. Built
    // once and kept on the room state — walking away and back must not mint a
    // fresh canvas texture every time.
    if (!room.serialMat) {
      room.serialMat = new THREE.MeshBasicMaterial({
        map: makeSerialTexture(s.serial),
        transparent: true,
      });
    }
    const serialMat = room.serialMat;
    for (const sign of [1, -1]) {
      const plate = new THREE.Mesh(this.plateGeo, serialMat);
      plate.position.set(
        d.x + (d.horiz ? 0 : sign * (DOOR_T / 2 + 0.02)),
        1.95,
        d.z + (d.horiz ? sign * (DOOR_T / 2 + 0.02) : 0)
      );
      if (d.horiz) plate.rotation.y = sign > 0 ? 0 : Math.PI;
      else plate.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
      g.add(plate);
      door.userData.plates = door.userData.plates || [];
      door.userData.plates.push(plate);
    }
    room.meshes.plates = door.userData.plates;

    // --- The KeySwitch, out in the hallways --------------------------------
    const sw = this._switchPlacement(s);
    room.switchPos = sw;
    const box = new THREE.Mesh(this.boxGeo, this.switchMat);
    box.scale.set(0.42, 0.62, 0.18);
    box.position.set(sw.x, 1.5, sw.z);
    box.rotation.y = sw.yaw;
    g.add(box);
    const lever = new THREE.Mesh(this.boxGeo, this.leverMat);
    lever.scale.set(0.1, 0.3, 0.1);
    lever.position.set(sw.x, 1.32, sw.z);
    lever.translateZ(0.14);
    lever.rotation.y = sw.yaw;
    g.add(lever);
    room.meshes.lever = lever;
    const swPlate = new THREE.Mesh(this.plateGeo, serialMat);
    swPlate.scale.set(0.62, 0.62, 1);
    swPlate.position.set(sw.x, 2.05, sw.z);
    swPlate.rotation.y = sw.yaw;
    swPlate.translateZ(0.02);
    g.add(swPlate);

    // --- Terminal + locker on the back wall --------------------------------
    const back = this._backWall(s);
    const term = new THREE.Mesh(this.boxGeo, this.metalMat);
    term.scale.set(1.1, 1.3, 0.7);
    term.position.set(back.termX, 0.65, back.termZ);
    term.rotation.y = back.yaw;
    g.add(term);
    const screen = new THREE.Mesh(this.plateGeo, this.screenMat);
    screen.scale.set(1.2, 1.6, 1);
    screen.position.set(back.termX, 1.15, back.termZ);
    screen.rotation.y = back.yaw;
    screen.translateZ(0.37);
    g.add(screen);
    room.meshes.screen = screen;
    room.termPos = { x: back.termX, z: back.termZ };

    const locker = new THREE.Mesh(this.boxGeo, this.metalMat);
    locker.scale.set(0.9, 1.8, 0.5);
    locker.position.set(back.lockX, 0.9, back.lockZ);
    locker.rotation.y = back.yaw;
    g.add(locker);
    room.meshes.locker = locker;
    room.lockPos = { x: back.lockX, z: back.lockZ };

    // --- The panic button, on the wall beside the door ----------------------
    const panic = this._panicPlacement(s);
    const btn = new THREE.Mesh(this.boxGeo, this.panicMat);
    btn.scale.set(0.3, 0.3, 0.12);
    btn.position.set(panic.x, 1.5, panic.z);
    btn.rotation.y = panic.yaw;
    g.add(btn);
    room.meshes.panic = btn;
    room.panicPos = panic;

    // --- Planks (once — a plank you took stays taken) ------------------------
    if (!room._propsSpawned) {
      room._propsSpawned = true;
      for (let k = 0; k < PLANK_COUNT; k++) {
        const a = (k / PLANK_COUNT) * Math.PI * 2 + 0.7;
        room.props.push({
          type: "plank",
          x: s.cxWorld + Math.cos(a) * 3.1,
          z: s.czWorld + Math.sin(a) * 3.1,
          rot: a,
        });
      }
    }
    for (const p of room.props) {
      if (p.mesh) continue;
      p.mesh = this._propMesh(p);
      g.add(p.mesh);
    }

    this.scene.add(g);
    room.group = g;
    this._applyDoorVisual(room);
    this._rebuildBounds();
  }

  _propMesh(p) {
    const mat = p.type === "plank" ? this.plankGlowMat : this.rewardMats[p.type] || this.screenMat;
    const m = new THREE.Mesh(this.boxGeo, mat);
    if (p.type === "plank") m.scale.set(1.5, 0.09, 0.28);
    else m.scale.set(0.32, 0.32, 0.32);
    m.position.set(p.x, p.type === "plank" ? 0.1 : 0.42, p.z);
    m.rotation.y = p.rot || 0;
    return m;
  }

  _unload(room) {
    if (!room.group) return;
    this.scene.remove(room.group);
    room.group = null;
    room.meshes = {};
    for (const p of room.props) p.mesh = null;
  }

  // Bolt the switch to a REAL wall of a hallway cell out beyond the room. If the
  // cell it picked somehow has no walls at all (an open junction), we fall back to
  // standing it in the middle of the floor rather than dropping it into the void.
  _switchPlacement(s) {
    const [ci, cj] = s.switchCell;
    const cx = (ci + 0.5) * CELL;
    const cz = (cj + 0.5) * CELL;
    const faces = [
      { on: isWall(1, ci, cj), x: ci * CELL + 0.22, z: cz, yaw: Math.PI / 2 },        // west wall
      { on: isWall(1, ci + 1, cj), x: (ci + 1) * CELL - 0.22, z: cz, yaw: -Math.PI / 2 }, // east
      { on: isWall(0, ci, cj), x: cx, z: cj * CELL + 0.22, yaw: 0 },                  // south
      { on: isWall(0, ci, cj + 1), x: cx, z: (cj + 1) * CELL - 0.22, yaw: Math.PI },  // north
    ];
    const found = faces.find((f) => f.on);
    return found || { x: cx, z: cz, yaw: 0 };
  }

  // The wall opposite the door: where the terminal and the locker live, so you
  // are always facing AWAY from the door while you work. That's the whole tension.
  _backWall(s) {
    const inset = 0.75;
    const mid = { x: s.cxWorld, z: s.czWorld };
    const side = s.door.side;
    if (side === "W") {
      return { termX: s.maxX - inset, termZ: mid.z - 2.2, lockX: s.maxX - inset, lockZ: mid.z + 2.4, yaw: -Math.PI / 2 };
    }
    if (side === "E") {
      return { termX: s.minX + inset, termZ: mid.z - 2.2, lockX: s.minX + inset, lockZ: mid.z + 2.4, yaw: Math.PI / 2 };
    }
    if (side === "S") {
      return { termX: mid.x - 2.2, termZ: s.maxZ - inset, lockX: mid.x + 2.4, lockZ: s.maxZ - inset, yaw: Math.PI };
    }
    return { termX: mid.x - 2.2, termZ: s.minZ + inset, lockX: mid.x + 2.4, lockZ: s.minZ + inset, yaw: 0 };
  }

  // The panic button sits INSIDE, on the wall next to the door — within a lunge of
  // it, because that's where you'll be when you need it.
  _panicPlacement(s) {
    const d = s.door;
    const inward = {
      W: [1, 0], E: [-1, 0], S: [0, 1], N: [0, -1],
    }[d.side];
    const along = d.horiz ? [1, 0] : [0, 1];
    return {
      x: d.x + inward[0] * 0.45 + along[0] * 2.1,
      z: d.z + inward[1] * 0.45 + along[1] * 2.1,
      yaw: d.horiz ? (d.side === "S" ? 0 : Math.PI) : (d.side === "W" ? Math.PI / 2 : -Math.PI / 2),
    };
  }

  // --- Collision + pathing --------------------------------------------------
  // Two boxes per door, and the difference between them is the entire safe-room
  // fiction:
  //   SOLID — present while the door is shut. Stops everyone, blocks sightlines.
  //   WARD  — an `entityOnly` box, present whenever the door is NOT destroyed,
  //           INCLUDING while it stands open. You walk through the doorway; they
  //           cannot, even with it hanging wide open. That's what "they cannot
  //           cross the threshold" actually means in code.
  // Destroy the door and BOTH boxes go. Now it's just a hole, and they come in.
  _rebuildBounds() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (!room.group) continue;
      const d = room.spec.door;
      if (room.door.state === "breached") continue;

      const half = DOOR_T / 2;
      const box = d.horiz
        ? { minX: d.i * CELL, maxX: (d.i + 1) * CELL, minZ: d.z - half, maxZ: d.z + half }
        : { minX: d.x - half, maxX: d.x + half, minZ: d.j * CELL, maxZ: (d.j + 1) * CELL };

      if (room.door.state === "open") out.push({ ...box, entityOnly: true });
      else out.push(box);
    }
    this.world.extraBounds = out;
  }

  // The pathfinder's veto: while a door still stands, its edge is a wall as far as
  // the entities are concerned, so they route to the OUTSIDE of it and stop.
  _pathGate(type, i, j) {
    const id = type + ":" + i + ":" + j;
    for (const room of this.rooms.values()) {
      if (room.spec.door.id !== id) continue;
      return room.door.state !== "breached";
    }
    return false;
  }

  // --- Per-frame ------------------------------------------------------------
  sync(playerPos) {
    const cx = Math.floor(playerPos.x / (CELL * 6));
    const cy = Math.floor(playerPos.z / (CELL * 6));
    const near = new Set();

    for (let x = cx - LOAD_RADIUS; x <= cx + LOAD_RADIUS; x++) {
      for (let y = cy - LOAD_RADIUS; y <= cy + LOAD_RADIUS; y++) {
        const spec = chunkRoom(x, y);
        if (!spec) continue;
        near.add(spec.key);
        this._load(this._state(spec));
      }
    }
    for (const [key, room] of this.rooms) {
      if (!near.has(key) && room.group) {
        this._unload(room);
        this._rebuildBounds();
      }
    }
    this.world.pathGate = (t, i, j) => this._pathGate(t, i, j);
  }

  update(dt, player, holdingInteract, world) {
    this.sync(player.pos);

    const px = player.pos.x;
    const pz = player.pos.z;
    this._thud = Math.max(0, this._thud - dt);

    // Which room are we dealing with? The nearest loaded one within 18m — beyond
    // that nothing it owns is reachable anyway.
    let room = null;
    let best = 18 * 18;
    for (const r of this.rooms.values()) {
      if (!r.group) continue;
      const dx = r.spec.cxWorld - px;
      const dz = r.spec.czWorld - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        room = r;
      }
    }
    this.active = room;
    this.prompt = null;
    this.hud = null;

    if (!room) {
      this.playerIsSafe = false;
      this.entities.setSiege(null);
      return;
    }

    const s = room.spec;
    const inside =
      px > s.minX + 0.2 && px < s.maxX - 0.2 && pz > s.minZ + 0.2 && pz < s.maxZ - 0.2;
    const breached = room.door.state === "breached";

    // --- SAFE ---------------------------------------------------------------
    // Sealed in, with the door intact. Nothing can reach you. Everything that was
    // on your trail is now stacked up outside it.
    this.playerIsSafe = inside && !breached;
    this.entities.setSiege(this.playerIsSafe ? s.outside : null);

    this._door(dt, room, player, world);
    this._siege(dt, room);
    this._props(room, player);
    this._terminalNoise(dt, room, player);
    this._interactions(room, player, holdingInteract, dt);

    if (!breached && (room.door.durability < DOOR_MAX || this.playerIsSafe)) {
      this.hud = { pct: room.door.durability / DOOR_MAX, sieging: !!this.entities.siege };
    }
  }

  // --- The door: push-to-open, bounce, decay, breach ------------------------
  _door(dt, room, player, world) {
    const d = room.spec.door;
    const st = room.door;
    const px = player.pos.x;
    const pz = player.pos.z;
    const dist = Math.hypot(d.x - px, d.z - pz);

    if (st.state === "open") {
      st.openTimer -= dt;
      // Never swing shut ON the player — that would shove you into solid geometry.
      if (dist < 1.15) st.openTimer = Math.max(st.openTimer, 0.35);
      if (st.openTimer <= 0) {
        st.state = "closed";
        this.audio.doorShut();
        this._rebuildBounds();
      }
    }

    // PUSH TO OPEN. Unlocking is not opening. You have to put your shoulder into
    // it — which means committing to walking INTO the thing you're hiding from.
    if ((st.state === "closed" || st.state === "locked") && dist < PUSH_DIST && player.moving) {
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      const tx = (d.x - px) / (dist || 1);
      const tz = (d.z - pz) / (dist || 1);
      if (fx * tx + fz * tz > 0.35) {
        if (st.state === "closed") {
          st.state = "open";
          st.openTimer = OPEN_TIME;
          this.audio.doorOpen();
          this._rebuildBounds();
        } else if (this._thud <= 0) {
          this._thud = THUD_COOLDOWN;
          this.audio.doorThud(); // locked. you bounce off it.
        }
      }
    }

    this._applyDoorVisual(room);
  }

  _applyDoorVisual(room) {
    const mesh = room.meshes.door;
    if (!mesh) return;
    const st = room.door;
    const d = room.spec.door;

    if (st.state === "breached") {
      mesh.material = this.wreckMat;
      // Hanging off its hinges: dropped, tilted, and shoved out of the frame.
      mesh.scale.set(d.horiz ? CELL * 0.94 : DOOR_T, DOOR_H * 0.45, d.horiz ? DOOR_T : CELL * 0.94);
      mesh.position.set(d.x, 0.22, d.z);
      mesh.rotation.set(d.horiz ? 0.5 : 0, 0, d.horiz ? 0 : 0.5);
      for (const p of room.meshes.plates || []) p.visible = false;
      return;
    }

    // Open = swung aside. Simply sliding it out of the doorway reads correctly and
    // costs nothing.
    const swing = st.state === "open" ? 1 : 0;
    const along = d.horiz ? [1, 0] : [0, 1];
    mesh.position.set(d.x + along[0] * swing * CELL * 0.9, DOOR_H / 2, d.z + along[1] * swing * CELL * 0.9);

    // Splintering: as the durability falls the door sinks and darkens, so you can
    // SEE how much is left without reading the bar.
    const t = st.durability / DOOR_MAX;
    mesh.scale.set(d.horiz ? CELL * 0.94 : DOOR_T, DOOR_H * (0.75 + 0.25 * t), d.horiz ? DOOR_T : CELL * 0.94);
    for (const p of room.meshes.plates || []) p.visible = swing === 0;
  }

  // --- The siege: they hammer, the door gives ------------------------------
  _siege(dt, room) {
    const st = room.door;
    if (st.state === "breached") return;

    let banging = 0;
    for (const e of this.entities.entities) {
      if (!e.sieging) continue;
      banging++;
      if (e.banging) {
        e.banging = false;
        this.audio.doorHit(this.playerIsSafe); // muffled from outside, loud from in
      }
    }

    if (!banging || !this.playerIsSafe) return;

    st.durability -= DECAY_PER_ENTITY * banging * dt;
    if (st.durability <= 0) {
      st.durability = 0;
      st.state = "breached";
      this.playerIsSafe = false;
      this.entities.setSiege(null); // no door to besiege — they come in
      this._rebuildBounds();
      this._applyDoorVisual(room);
      this.audio.doorBreach();
      this.fx.breach();
    }
  }

  // --- Loose props: planks, and whatever the locker coughs up ---------------
  _props(room, player) {
    for (let k = room.props.length - 1; k >= 0; k--) {
      const p = room.props[k];
      const dx = player.pos.x - p.x;
      const dz = player.pos.z - p.z;
      if (dx * dx + dz * dz > 1.6 * 1.6) continue;
      if (!this.inv.give(p.type, 1)) continue; // no room — leave it on the floor
      if (p.mesh) this.scene.remove(p.mesh);
      room.props.splice(k, 1);
      this.audio.pickup();
    }
  }

  // Typing is NOISE. With the door intact it barely carries — you're behind steel.
  // Once the door is gone you are sitting in an open room with your back turned,
  // hammering on a keyboard, and it carries a very long way indeed.
  _terminalNoise(dt, room, player) {
    if (!this.terminal || this.terminal.room !== room) {
      this._typeNoise = 0;
      return;
    }
    this._typeNoise -= dt;
    if (this._typeNoise > 0) return;
    this._typeNoise = TYPE_NOISE_INTERVAL;
    const radius = room.door.state === "breached" ? TYPE_NOISE_BREACHED : TYPE_NOISE_SAFE;
    this.entities.hearNoise(player.pos.x, player.pos.z, radius);
  }

  // --- What can I do right now? --------------------------------------------
  _interactions(room, player, holding, dt) {
    const px = player.pos.x;
    const pz = player.pos.z;
    const near = (p) => p && Math.hypot(p.x - px, p.z - pz) < REACH;
    const s = room.spec;

    // Repair is a HOLD, so it gets checked first: it's the only thing that can be
    // in progress across frames.
    const atDoor = Math.hypot(s.door.x - px, s.door.z - pz) < REACH;
    const canRepair =
      atDoor && room.door.state !== "breached" && room.door.durability < DOOR_MAX && this.inv.has("plank");

    if (canRepair && holding) {
      this._repair += dt;
      if (this._repair >= REPAIR_HOLD) {
        this._repair = 0;
        this.inv.take("plank");
        room.door.durability = Math.min(DOOR_MAX, room.door.durability + PLANK_REPAIR);
        this.audio.hammer();
        // Hammering is loud. Boarding up the door tells everything nearby exactly
        // which door to come to.
        this.entities.hearNoise(px, pz, 18);
        this._applyDoorVisual(room);
      }
      this.prompt = {
        text: `BOARDING UP… ${Math.round((this._repair / REPAIR_HOLD) * 100)}%`,
        kind: "repair",
      };
      return;
    }
    this._repair = 0;

    if (near(room.switchPos) && !room.switchPulled) {
      this.prompt = { text: `[E] PULL SWITCH ${s.serial}`, kind: "switch" };
      return;
    }
    if (near(room.termPos) && !room.task.done) {
      this.prompt = { text: "[E] USE TERMINAL", kind: "terminal" };
      return;
    }
    if (near(room.lockPos) && room.lockerOpen && room.props.some((p) => p.type !== "plank")) {
      this.prompt = { text: "[E] TAKE FROM LOCKER", kind: "locker" };
      return;
    }
    if (near(room.panicPos) && !room.panicUsed) {
      this.prompt = { text: "[E] EMERGENCY HALON VENT", kind: "panic" };
      return;
    }
    if (canRepair) {
      this.prompt = { text: "[HOLD E] BOARD UP DOOR (+30%)", kind: "repair" };
      return;
    }
    if (atDoor && room.door.state === "locked") {
      this.prompt = { text: `LOCKED · SERIAL ${s.serial}`, kind: "locked" };
    }
  }

  // A discrete [E] press.
  press(player, world) {
    const room = this.active;
    if (!room || !this.prompt) return;

    switch (this.prompt.kind) {
      case "switch":
        room.switchPulled = true;
        if (room.door.state === "locked") room.door.state = "closed"; // unlocked, still SHUT
        if (room.meshes.lever) room.meshes.lever.rotation.x = 0.9;
        this.audio.switchPull();
        // A switch being thrown is a hard, mechanical CLANG. It carries.
        this.entities.hearNoise(player.pos.x, player.pos.z, 20);
        break;

      case "terminal":
        this.openTerminal(room, player);
        break;

      case "panic":
        this._halon(room, player, world);
        break;

      case "locker":
        for (let k = room.props.length - 1; k >= 0; k--) {
          const p = room.props[k];
          if (p.type === "plank") continue;
          if (!this.inv.give(p.type, 1)) return;
          if (p.mesh) this.scene.remove(p.mesh);
          room.props.splice(k, 1);
          this.audio.pickup();
        }
        break;
    }
  }

  // --- The hail mary --------------------------------------------------------
  // One per room, ever. A wall of halon, an alarm loud enough to hurt, and every
  // single thing in the room drops where it stands. You get five seconds and a
  // head of steam — and you cannot see a metre in front of you either. That's the
  // trade: you don't escape gracefully, you escape blind.
  _halon(room, player, world) {
    room.panicUsed = true;
    if (room.meshes.panic) room.meshes.panic.material = this.wreckMat;
    this.entities.blindNear(player.pos.x, player.pos.z, PANIC_RADIUS, PANIC_STUN);
    this.entities.setSiege(null);
    this.audio.halon();
    this.fx.halon(PANIC_STUN);
  }

  // --- The terminal ---------------------------------------------------------
  openTerminal(room, player) {
    this.terminal = { room, typed: "" };
    player.enabled = false;   // you cannot walk
    player.lookLocked = true; // and you cannot look. the door is behind you.
    player.touchFwd = 0;
    player.touchStrafe = 0;
  }

  closeTerminal(player) {
    if (!this.terminal) return;
    this.terminal = null;
    player.enabled = true;
    player.lookLocked = false;
  }

  // What the screen currently reads. game.js renders this.
  terminalView() {
    if (!this.terminal) return null;
    const room = this.terminal.room;
    const n = Number(room.spec.serial);
    const codes = [];
    for (let k = 0; k < TASK_CODES; k++) codes.push(String(1000 + ((n * (k + 7) * 37) % 9000)));
    return {
      target: codes[room.task.index] || "",
      typed: this.terminal.typed,
      index: room.task.index,
      total: TASK_CODES,
      breached: room.door.state === "breached",
    };
  }

  // A digit typed at the terminal. Returns "ok" | "bad" | "done".
  typeDigit(digit, player, world) {
    if (!this.terminal) return null;
    const room = this.terminal.room;
    const view = this.terminalView();
    const t = this.terminal;

    t.typed += digit;
    // Wrong digit: the whole code resets. Sloppy typing costs you door.
    if (!view.target.startsWith(t.typed)) {
      t.typed = "";
      this.audio.termError();
      return "bad";
    }
    if (t.typed.length < view.target.length) {
      this.audio.termKey();
      return "ok";
    }

    // Code accepted.
    t.typed = "";
    room.task.index++;
    this.audio.termKey();
    if (room.task.index < TASK_CODES) return "ok";

    // --- TASK COMPLETE ------------------------------------------------------
    room.task.done = true;
    room.lockerOpen = true;
    this.audio.termDone();
    // Everything camped on that door gives up and walks away. This is the payoff:
    // you didn't fight them off, you outlasted them with your back turned.
    this.entities.disperse(player.pos.x, player.pos.z, 45, world);
    this.entities.setSiege(null);

    // The locker pops. Whatever's in it drops on the floor in front of it.
    const lp = room.lockPos;
    const prize = {
      type: room.reward,
      x: lp.x + (Math.random() - 0.5) * 0.6,
      z: lp.z + (Math.random() - 0.5) * 0.6,
      rot: 0,
    };
    prize.mesh = this._propMesh(prize);
    room.props.push(prize);
    if (room.group) room.group.add(prize.mesh);
    if (room.meshes.locker) room.meshes.locker.rotation.y += 0.5;

    this.closeTerminal(player);
    this.fx.taskDone(room.reward);
    return "done";
  }
}
