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

import { CELL, WALL_H, chunkRoom, isWall, isWindowWall } from "./world.js";
import { installReveal } from "./reveal.js";

const LOAD_RADIUS = 2;          // chunks around the player whose rooms get built

// THE DOOR DOES NOT BREAK. It is a steel blast door in a concrete box and nothing
// out there is getting through it — they can hammer on it until they lose heart
// and it will not give. It has no durability and no breach state.
//
// The cost is not that the door fails. The cost is that IT ONLY WORKS ONCE. Push
// it open from the inside and walk out, and it never shuts again — the room is
// spent. So a safe room is not a fortress you can retreat to over and over; it's a
// single use, and the decision that matters is WHEN you spend it, and whether you
// can still leave when you're done.
//
// (What CAN be broken is the vent — but only because you were the one who took the
// grate off. See below.)
const DOOR_H = 2.7;
const DOOR_T = 0.34;
const PLANK_REPAIR = 30;
const REPAIR_HOLD = 1.5;        // seconds of holding [E] to nail one in
const PUSH_DIST = 1.6;          // how close you must be to shoulder the door
const REACH = 2.5;              // interaction reach for everything else
const OPEN_TIME = 2.2;          // how long the door stands open before swinging to
const THUD_COOLDOWN = 0.7;
// Durability drain per second, PER besieger. Only the vent has durability now.
const DECAY_PER_ENTITY = 1.7;

const PLANK_COUNT = 3;
const TASK_CODES = 3;           // codes to type before the task is done
const TYPE_NOISE_SAFE = 13;     // how far your typing carries with the door intact
const TYPE_NOISE_BREACHED = 30; // ...and with the door gone. A dinner bell.
const TYPE_NOISE_INTERVAL = 2.0;

const PANIC_RADIUS = 20;
const PANIC_STUN = 5;

// --- THE VENT ---------------------------------------------------------------
// A crawlspace in the BACK wall, as far from the door as the room gets. Behind a
// bolted grate.
//
// Pry the grate off and you have a second way out — one only YOU can use, because
// nothing else in here fits down a duct. It is the answer to the room's worst
// failure state: the door is holding, the terminal is half done, and you realise
// you are sealed in a concrete box with three of them outside the only exit.
//
// AND IT IS ONE-TIME, in the sense that matters: the grate does not go back on.
// The moment it comes off, the room has a soft spot, and they know it. A siege
// RELOCATES to the vent — it's the weak point and they can smell it — and the vent
// takes half the punishment a door does before it gives. So the escape hatch is
// also the thing that will get you killed if you open it early and then decide to
// stay. Board it back up with a plank if you can. If you can't, you had better be
// leaving.
const VENT_MAX = 55;        // vs the door's 100. It was never built to hold.
const VENT_H = 0.85;        // a crawl, not a walk
const VENT_W = 1.1;
const VENT_SILL = 0.15;     // it sits low, near the floor

const REWARDS = ["meat", "torch", "crucifix"];

// Cyan: the colour of everything man-made and functional in here. It exists to be
// unmistakable against the green sonar and the yellow walls — if you see cyan,
// something in that direction can be used.
const ECHO_CYAN = 0x27e0ff;

// --- Prop textures -----------------------------------------------------------
// All drawn on <canvas> at runtime, like every other surface in the game — there
// are still no image files anywhere in this project.

// The door: a riveted steel blast panel with hazard striping along the bottom and
// a lot of history scratched into it.
function makeDoorTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");

  // Brushed steel: a vertical gradient with fine grain scratched across it.
  const base = g.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, "#8f99a4");
  base.addColorStop(0.5, "#737d88");
  base.addColorStop(1, "#5c656f");
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const y = Math.random() * 256;
    g.strokeStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    g.beginPath();
    g.moveTo(Math.random() * 256, y);
    g.lineTo(Math.random() * 256, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }

  // Recessed panel, drawn as a highlight edge over a shadow edge.
  g.strokeStyle = "rgba(0,0,0,0.45)";
  g.lineWidth = 5;
  g.strokeRect(24, 24, 208, 176);
  g.strokeStyle = "rgba(220,235,245,0.16)";
  g.lineWidth = 2;
  g.strokeRect(28, 28, 200, 168);

  // Cross-braces.
  g.fillStyle = "rgba(0,0,0,0.2)";
  g.fillRect(24, 100, 208, 10);
  g.fillStyle = "rgba(220,235,245,0.12)";
  g.fillRect(24, 100, 208, 3);

  // Rivets around the frame.
  const rivet = (x, y) => {
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath();
    g.arc(x, y + 1, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#a6b0ba";
    g.beginPath();
    g.arc(x, y, 3.4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.beginPath();
    g.arc(x - 1, y - 1, 1.2, 0, Math.PI * 2);
    g.fill();
  };
  for (let x = 12; x <= 244; x += 29) {
    rivet(x, 12);
    rivet(x, 212);
  }
  for (let y = 12; y <= 212; y += 25) {
    rivet(12, y);
    rivet(244, y);
  }

  // Hazard stripes across the foot of the door.
  g.save();
  g.beginPath();
  g.rect(0, 226, 256, 30);
  g.clip();
  g.fillStyle = "#d8b400";
  g.fillRect(0, 226, 256, 30);
  g.fillStyle = "#1b1b1b";
  for (let x = -30; x < 300; x += 30) {
    g.beginPath();
    g.moveTo(x, 256);
    g.lineTo(x + 15, 226);
    g.lineTo(x + 30, 226);
    g.lineTo(x + 15, 256);
    g.closePath();
    g.fill();
  }
  g.restore();

  // Rust and scoring — things have been at this door before you.
  for (let i = 0; i < 26; i++) {
    const rx = Math.random() * 256;
    const ry = Math.random() * 220;
    const rr = 3 + Math.random() * 16;
    const grd = g.createRadialGradient(rx, ry, 0, rx, ry, rr);
    grd.addColorStop(0, "rgba(96,52,20,0.4)");
    grd.addColorStop(1, "rgba(96,52,20,0)");
    g.fillStyle = grd;
    g.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
  }
  for (let i = 0; i < 20; i++) {
    g.strokeStyle = `rgba(230,240,250,${0.05 + Math.random() * 0.12})`;
    g.lineWidth = 1 + Math.random();
    const x = Math.random() * 256;
    const y = 40 + Math.random() * 150;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 26);
    g.stroke();
  }

  return new THREE.CanvasTexture(c);
}

// A plank: rough-sawn timber, grain, knots and split ends.
function makePlankTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");

  g.fillStyle = "#9a7440";
  g.fillRect(0, 0, 256, 64);

  // Grain: long wavering lines down the length of the board.
  for (let i = 0; i < 70; i++) {
    const y = Math.random() * 64;
    g.strokeStyle = `rgba(${70 + Math.random() * 40},${45 + Math.random() * 30},20,${0.1 + Math.random() * 0.3})`;
    g.lineWidth = 0.5 + Math.random() * 1.6;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 16) {
      g.lineTo(x, y + Math.sin(x * 0.06 + i) * 1.8);
    }
    g.stroke();
  }
  // Knots.
  for (let i = 0; i < 3; i++) {
    const kx = 30 + Math.random() * 196;
    const ky = 12 + Math.random() * 40;
    for (let r = 9; r > 0; r -= 1.6) {
      g.strokeStyle = `rgba(60,38,16,${0.15 + (9 - r) * 0.06})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(kx, ky, r, r * 0.62, 0.4, 0, Math.PI * 2);
      g.stroke();
    }
  }
  // Darkened, splintered ends.
  const capL = g.createLinearGradient(0, 0, 14, 0);
  capL.addColorStop(0, "rgba(40,26,10,0.55)");
  capL.addColorStop(1, "rgba(40,26,10,0)");
  g.fillStyle = capL;
  g.fillRect(0, 0, 14, 64);
  const capR = g.createLinearGradient(256, 0, 242, 0);
  capR.addColorStop(0, "rgba(40,26,10,0.55)");
  capR.addColorStop(1, "rgba(40,26,10,0)");
  g.fillStyle = capR;
  g.fillRect(242, 0, 14, 64);

  return new THREE.CanvasTexture(c);
}

// The KeySwitch housing: a fire-alarm box. Red, weathered, and it says PULL DOWN,
// because in the dark you will want to be very sure before you commit to it.
function makeSwitchTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");

  const base = g.createLinearGradient(0, 0, 0, 128);
  base.addColorStop(0, "#d4463a");
  base.addColorStop(1, "#96261d");
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);

  g.strokeStyle = "rgba(0,0,0,0.4)";
  g.lineWidth = 4;
  g.strokeRect(6, 6, 116, 116);
  g.strokeStyle = "rgba(255,220,210,0.25)";
  g.lineWidth = 1.5;
  g.strokeRect(9, 9, 110, 110);

  g.fillStyle = "rgba(255,235,230,0.92)";
  g.font = "bold 15px 'Courier New', monospace";
  g.textAlign = "center";
  g.fillText("PULL", 64, 30);
  g.font = "bold 10px 'Courier New', monospace";
  g.fillText("DOWN", 64, 43);

  // The slot the lever travels in.
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(52, 54, 24, 56);
  g.fillStyle = "rgba(255,255,255,0.12)";
  g.fillRect(52, 54, 24, 3);

  // Grime and chipped paint.
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  return new THREE.CanvasTexture(c);
}

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
    // Everything a safe room owns is faintly SELF-LIT (emissive), because the room
    // has power and the rest of the world does not. Two consequences, both wanted:
    // the inside of a room is visible the moment you're in it without spending a
    // ping on your own refuge; and out in the corridor, a door or a fire-alarm
    // switch is a dim shape in the dark rather than something you can only find by
    // echo. `emissiveMap` keeps the texture detail in the glow instead of flooding
    // the object with flat colour.
    const cyanFlash = new THREE.Color(ECHO_CYAN).multiplyScalar(2.6);
    const doorTex = makeDoorTexture();
    this.doorMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 42, specular: 0x556070, map: doorTex,
      emissive: 0x3c4450, emissiveMap: doorTex,
    });
    installReveal(this.doorMat, cyanFlash);
    this.wreckMat = new THREE.MeshPhongMaterial({ color: 0x3a3f46, shininess: 0, emissive: 0x14171a });
    installReveal(this.wreckMat);
    const switchTex = makeSwitchTexture();
    this.switchMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 18, map: switchTex,
      emissive: 0x6a2a24, emissiveMap: switchTex, // a red box you can just make out
    });
    installReveal(this.switchMat, cyanFlash);
    this.metalMat = new THREE.MeshPhongMaterial({
      color: 0x767f8a, shininess: 30, specular: 0x445062, emissive: 0x2b3138,
    });
    installReveal(this.metalMat);
    this.darkMetalMat = new THREE.MeshPhongMaterial({ color: 0x3d444c, shininess: 24 });
    installReveal(this.darkMetalMat);
    // The throat of the duct: near-black, and NOT self-lit — it's the one thing in
    // a lit room you still can't see into.
    this.ductMat = new THREE.MeshPhongMaterial({ color: 0x08090a, shininess: 0 });
    installReveal(this.ductMat);
    const plankTex = makePlankTexture();
    this.woodMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 2, map: plankTex,
      emissive: 0x4a3418, emissiveMap: plankTex,
    });
    installReveal(this.woodMat);

    // Self-lit bits. These IGNORE the darkness — a screen, a glowing button and a
    // stencilled number are meant to be findable, and a room you can't find is
    // just a wall.
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x1cff8f });
    this.panicMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    this.plankGlowMat = new THREE.MeshBasicMaterial({ color: 0xe8b464 });
    this.leverMat = new THREE.MeshBasicMaterial({ color: 0xffe36b });
    // Self-lit trim. The locker used to be an unlit box in a pitch-black room —
    // which meant it was, for all practical purposes, INVISIBLE until a ping hit
    // it. A cabinet you cannot find is not a reward. Now it wears a cyan status
    // strip you can see from the doorway.
    this.trimMat = new THREE.MeshBasicMaterial({ color: 0x27e0ff });
    this.trimLitMat = new THREE.MeshBasicMaterial({ color: 0x8affd0 }); // once it's open
    // The room's emergency lamp: the only light source in there, and it is red.
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
    // Whatever the locker coughs up, in the same colours the item has everywhere
    // else — you should recognise it on the floor without reading a label.
    this.rewardMats = {
      meat: new THREE.MeshBasicMaterial({ color: 0xa5301a }),
      torch: new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
      crucifix: new THREE.MeshBasicMaterial({ color: 0xf2ead0 }),
    };

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.plateGeo = new THREE.PlaneGeometry(0.7, 0.35);
    this.rodGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
    this.knobGeo = new THREE.SphereGeometry(1, 12, 10);
  }

  // Little helpers so the prop builders below read as descriptions of objects
  // rather than walls of scale/position arithmetic.
  _box(mat, sx, sy, sz, x, y, z, yaw = 0) {
    const m = new THREE.Mesh(this.boxGeo, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    return m;
  }

  _rod(mat, radius, length, x, y, z) {
    const m = new THREE.Mesh(this.rodGeo, mat);
    m.scale.set(radius, length, radius);
    m.position.set(x, y, z);
    return m;
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
      // locked -> closed (switch pulled) -> open (shoved) -> SPENT (you left)
      door: { state: "locked", openTimer: 0 },
      // sealed -> open (you pried the grate off) -> breached (they came through it)
      vent: { state: "sealed", durability: VENT_MAX },
      wasInside: false,
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
    // A GROUP, not a single box: the slab, a steel frame around the opening, two
    // hinges and a push-bar. The whole group moves as one when it swings, and the
    // frame stays put because the frame is part of the wall, not the door.
    const d = s.door;
    const width = CELL * 0.94;
    const door = new THREE.Group();

    const slab = this._box(this.doorMat, d.horiz ? width : DOOR_T, DOOR_H, d.horiz ? DOOR_T : width, 0, DOOR_H / 2, 0);
    door.add(slab);
    room.meshes.slab = slab;

    // Push-bar across the middle, on both faces — this is the thing you shoulder.
    for (const sign of [1, -1]) {
      const off = DOOR_T / 2 + 0.05;
      door.add(
        this._box(
          this.darkMetalMat,
          d.horiz ? width * 0.62 : 0.1,
          0.09,
          d.horiz ? 0.1 : width * 0.62,
          d.horiz ? 0 : sign * off,
          1.15,
          d.horiz ? sign * off : 0
        )
      );
    }
    // Hinges down one edge.
    const hingeAlong = d.horiz ? [1, 0] : [0, 1];
    for (const h of [0.5, 1.35, 2.2]) {
      door.add(
        this._rod(
          this.darkMetalMat,
          0.07,
          0.22,
          hingeAlong[0] * (width / 2 - 0.05),
          h,
          hingeAlong[1] * (width / 2 - 0.05)
        )
      );
    }
    // Hang it on a PIVOT at the hinge edge, so it swings like a door instead of
    // sliding sideways into the wall like a pocket door. The pivot sits on the
    // hinge line; the door group is offset back inside it so the slab lands square
    // in the opening at rest.
    const pivot = new THREE.Group();
    pivot.position.set(d.x + hingeAlong[0] * (width / 2), 0, d.z + hingeAlong[1] * (width / 2));
    door.position.set(-hingeAlong[0] * (width / 2), 0, -hingeAlong[1] * (width / 2));
    pivot.add(door);
    g.add(pivot);
    room.meshes.door = door;
    room.meshes.pivot = pivot;

    // The frame: a steel surround bolted into the concrete. It does NOT move with
    // the door, so when the door swings open you're left looking through a proper
    // lined opening rather than a hole in a wall.
    const frameT = 0.16;
    for (const side of [-1, 1]) {
      g.add(
        this._box(
          this.darkMetalMat,
          d.horiz ? frameT : DOOR_T + 0.08,
          DOOR_H + 0.12,
          d.horiz ? DOOR_T + 0.08 : frameT,
          d.x + (d.horiz ? side * (width / 2 + frameT / 2) : 0),
          (DOOR_H + 0.12) / 2,
          d.z + (d.horiz ? 0 : side * (width / 2 + frameT / 2))
        )
      );
    }
    g.add(
      this._box(
        this.darkMetalMat,
        d.horiz ? width + frameT * 2 : DOOR_T + 0.08,
        frameT,
        d.horiz ? DOOR_T + 0.08 : width + frameT * 2,
        d.x,
        DOOR_H + 0.12,
        d.z
      )
    );

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
    // Parented to the DOOR, in local space, so the number swings away with it —
    // it's painted on the thing, not floating in the doorway.
    const plates = [];
    for (const sign of [1, -1]) {
      const plate = new THREE.Mesh(this.plateGeo, serialMat);
      plate.position.set(
        d.horiz ? 0 : sign * (DOOR_T / 2 + 0.02),
        1.95,
        d.horiz ? sign * (DOOR_T / 2 + 0.02) : 0
      );
      plate.rotation.y = d.horiz ? (sign > 0 ? 0 : Math.PI) : sign > 0 ? Math.PI / 2 : -Math.PI / 2;
      door.add(plate);
      plates.push(plate);
    }
    room.meshes.plates = plates;

    // --- The KeySwitch, out in the hallways --------------------------------
    // A proper fire-alarm assembly: a backing plate bolted to the wall, the red
    // housing, a hinged lever arm with a ball grip, and the serial glowing above
    // it. The lever ARM is what moves when you pull it — it swings down on its own
    // pivot and stays down, so a switch you've already pulled reads as pulled from
    // across the corridor.
    const sw = this._switchPlacement(s);
    room.switchPos = sw;
    const swGroup = new THREE.Group();
    swGroup.position.set(sw.x, 0, sw.z);
    swGroup.rotation.y = sw.yaw;

    swGroup.add(this._box(this.darkMetalMat, 0.56, 0.78, 0.05, 0, 1.5, 0.01));  // backing plate
    swGroup.add(this._box(this.switchMat, 0.44, 0.64, 0.14, 0, 1.5, 0.08));     // housing
    swGroup.add(this._box(this.darkMetalMat, 0.5, 0.05, 0.16, 0, 1.16, 0.08));  // lip beneath
    // Two bolts, top corners.
    for (const bx of [-0.22, 0.22]) {
      swGroup.add(this._rod(this.darkMetalMat, 0.03, 0.04, bx, 1.83, 0.03));
    }

    // The lever, on its own pivot at the top of the slot.
    const leverPivot = new THREE.Group();
    leverPivot.position.set(0, 1.62, 0.15);
    const arm = this._rod(this.leverMat, 0.035, 0.34, 0, -0.17, 0);
    const grip = new THREE.Mesh(this.knobGeo, this.leverMat);
    grip.scale.set(0.075, 0.075, 0.075);
    grip.position.set(0, -0.36, 0);
    leverPivot.add(arm, grip);
    swGroup.add(leverPivot);
    room.meshes.lever = leverPivot;

    const swPlate = new THREE.Mesh(this.plateGeo, serialMat);
    swPlate.scale.set(0.62, 0.62, 1);
    swPlate.position.set(0, 2.06, 0.03);
    swGroup.add(swPlate);
    g.add(swGroup);

    // --- Terminal + locker on the back wall --------------------------------
    const back = this._backWall(s);

    // The terminal: a desk unit with a raked CRT sitting on it, a glowing screen,
    // and a keyboard shelf. The screen is self-lit — it's the first thing you see
    // when you get in, and it's what you came for.
    const termGroup = new THREE.Group();
    termGroup.position.set(back.termX, 0, back.termZ);
    termGroup.rotation.y = back.yaw;
    termGroup.add(this._box(this.metalMat, 1.3, 0.72, 0.62, 0, 0.36, 0));      // desk
    termGroup.add(this._box(this.darkMetalMat, 1.36, 0.06, 0.68, 0, 0.75, 0)); // worktop
    termGroup.add(this._box(this.darkMetalMat, 1.0, 0.03, 0.3, 0, 0.79, 0.2)); // keyboard shelf
    termGroup.add(this._box(this.metalMat, 0.94, 0.74, 0.5, 0, 1.16, -0.06));  // CRT body
    const bezel = this._box(this.darkMetalMat, 0.86, 0.62, 0.06, 0, 1.18, 0.2);
    termGroup.add(bezel);
    const screen = this._box(this.screenMat, 0.74, 0.5, 0.02, 0, 1.18, 0.24);
    termGroup.add(screen);
    room.meshes.screen = screen;
    // Cable running down the back into the floor.
    termGroup.add(this._rod(this.darkMetalMat, 0.035, 0.9, 0.5, 0.45, -0.3));
    g.add(termGroup);
    room.termPos = { x: back.termX, z: back.termZ };

    // The locker: a steel cabinet with a handle, a hinge column, and — crucially —
    // a self-lit status strip. Without that it was an unlit box in an unlit room,
    // i.e. invisible, which is why it seemed like there was no locker at all.
    const lockGroup = new THREE.Group();
    lockGroup.position.set(back.lockX, 0, back.lockZ);
    lockGroup.rotation.y = back.yaw;
    lockGroup.add(this._box(this.metalMat, 0.96, 1.9, 0.46, 0, 0.95, 0));
    const lockDoor = this._box(this.darkMetalMat, 0.86, 1.76, 0.05, 0, 0.95, 0.25);
    lockGroup.add(lockDoor);
    room.meshes.lockerDoor = lockDoor;
    lockGroup.add(this._rod(this.darkMetalMat, 0.03, 1.8, -0.42, 0.95, 0.22));  // hinge column
    lockGroup.add(this._box(this.metalMat, 0.06, 0.26, 0.08, 0.3, 1.0, 0.3));   // handle
    const strip = this._box(this.trimMat, 0.5, 0.05, 0.02, 0, 1.62, 0.29);      // status strip
    lockGroup.add(strip);
    room.meshes.lockerStrip = strip;
    lockGroup.add(this._box(this.metalMat, 1.0, 0.06, 0.5, 0, 1.93, 0));        // top cap
    g.add(lockGroup);
    room.meshes.locker = lockGroup;
    room.lockPos = { x: back.lockX, z: back.lockZ };

    // --- The room's emergency lamp ------------------------------------------
    // The hotel's fluorescents don't reach in here (world.js kills the ceiling
    // panels over a room). This is the only light in the place and it is red — so
    // the inside of a safe room glows a dull, wrong red instead of that sick
    // institutional yellow. It's how you know you're somewhere else.
    const lamp = this._box(this.lampMat, 0.5, 0.16, 0.2, s.cxWorld, WALL_H - 0.14, s.czWorld);
    g.add(lamp);
    g.add(this._box(this.darkMetalMat, 0.62, 0.1, 0.3, s.cxWorld, WALL_H - 0.04, s.czWorld)); // housing
    room.meshes.lamp = lamp;

    // --- The vent, in the back wall -----------------------------------------
    // A louvred steel grate bolted low into the concrete, as far from the door as
    // the room gets. Pry it off and it's a crawlspace out.
    const v = s.vent;
    const ventGroup = new THREE.Group();
    ventGroup.position.set(v.x, 0, v.z);
    ventGroup.rotation.y = v.horiz ? 0 : Math.PI / 2;

    // Frame: a lip around the opening so it reads as a hole in the wall, not a
    // poster of one.
    const fw = VENT_W + 0.16;
    const fh = VENT_H + 0.16;
    const midY = VENT_SILL + VENT_H / 2;
    ventGroup.add(this._box(this.darkMetalMat, fw, 0.08, 0.4, 0, VENT_SILL - 0.04, 0));   // bottom lip
    ventGroup.add(this._box(this.darkMetalMat, fw, 0.08, 0.4, 0, VENT_SILL + VENT_H + 0.04, 0)); // top lip
    for (const sx of [-1, 1]) {
      ventGroup.add(this._box(this.darkMetalMat, 0.08, fh, 0.4, sx * (fw / 2 - 0.04), midY, 0));
    }
    // The dark of the duct behind it.
    ventGroup.add(this._box(this.ductMat, VENT_W, VENT_H, 0.06, 0, midY, -0.12));

    // The grate itself: a plate of angled louvres and four corner bolts. This is
    // what comes off.
    const grate = new THREE.Group();
    grate.position.set(0, midY, 0.06);
    grate.add(this._box(this.metalMat, VENT_W, VENT_H, 0.03, 0, 0, 0));
    for (let k = 0; k < 6; k++) {
      const slat = this._box(this.darkMetalMat, VENT_W - 0.1, 0.055, 0.05, 0, -VENT_H / 2 + 0.1 + k * 0.13, 0.03);
      slat.rotation.x = 0.45; // angled, so you can't see in
      grate.add(slat);
    }
    for (const bx of [-1, 1]) {
      for (const by of [-1, 1]) {
        grate.add(this._rod(this.trimMat, 0.02, 0.03, bx * (VENT_W / 2 - 0.07), by * (VENT_H / 2 - 0.07), 0.04));
      }
    }
    ventGroup.add(grate);
    room.meshes.grate = grate;
    g.add(ventGroup);
    room.ventPos = { x: v.x, z: v.z };

    // --- The panic button, in the MIDDLE of the room -------------------------
    // On a floor pedestal, dead centre, under its own little lamp. It's the last
    // thing in the room and it should be the first thing you see when you get in —
    // and when you're cornered, you want it reachable from anywhere, not bolted to
    // one specific wall you might be pinned away from.
    const panicGroup = new THREE.Group();
    panicGroup.position.set(s.cxWorld, 0, s.czWorld);
    panicGroup.add(this._box(this.darkMetalMat, 0.5, 0.06, 0.5, 0, 0.03, 0));   // base plate
    panicGroup.add(this._rod(this.metalMat, 0.09, 1.0, 0, 0.53, 0));            // post
    panicGroup.add(this._box(this.metalMat, 0.42, 0.14, 0.42, 0, 1.08, 0));     // head housing
    panicGroup.add(this._box(this.darkMetalMat, 0.46, 0.03, 0.46, 0, 1.16, 0)); // collar
    const head = new THREE.Mesh(this.knobGeo, this.panicMat);
    head.scale.set(0.15, 0.08, 0.15);
    head.position.set(0, 1.2, 0);
    panicGroup.add(head);
    // Four guard posts, so you can't fall onto it.
    for (const gx of [-1, 1]) {
      for (const gz of [-1, 1]) {
        panicGroup.add(this._rod(this.darkMetalMat, 0.022, 0.3, gx * 0.19, 1.28, gz * 0.19));
      }
    }
    panicGroup.add(this._box(this.trimMat, 0.36, 0.02, 0.02, 0, 0.99, 0.21)); // label strip
    g.add(panicGroup);
    room.meshes.panic = head;
    room.panicPos = { x: s.cxWorld, z: s.czWorld };

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

    // Restore anything already done to this room. It streams out when you walk
    // away and rebuilds when you come back, so a lever you pulled ten minutes ago
    // has to still be DOWN, and a locker you opened has to still be OPEN — a room
    // that silently reset itself on a chunk reload would be a nasty bug to chase.
    if (room.switchPulled && room.meshes.lever) room.meshes.lever.rotation.x = 1.15;
    if (room.lockerOpen) {
      if (room.meshes.lockerDoor) {
        room.meshes.lockerDoor.rotation.y = -1.1;
        room.meshes.lockerDoor.position.x -= 0.38;
        room.meshes.lockerDoor.position.z += 0.16;
      }
      if (room.meshes.lockerStrip) room.meshes.lockerStrip.material = this.trimLitMat;
    }
    if (room.panicUsed && room.meshes.panic) room.meshes.panic.material = this.wreckMat;

    this._applyDoorVisual(room);
    this._applyVentVisual(room);
    this._rebuildBounds();
  }

  // A prop lying on the floor. Planks are real timber — grained, nailed, and with
  // a faint glow strip along the top so you can spot one in an unlit room without
  // it looking like a floating neon stick.
  _propMesh(p) {
    const group = new THREE.Group();
    group.position.set(p.x, 0, p.z);
    group.rotation.y = p.rot || 0;

    if (p.type === "plank") {
      const board = new THREE.Mesh(this.boxGeo, this.woodMat);
      board.scale.set(1.55, 0.08, 0.3);
      board.position.y = 0.1;
      board.rotation.z = 0.03; // never perfectly flat — it's junk on a floor
      group.add(board);
      // Bent nails still in the ends, and a rusty one lying beside it.
      for (const nx of [-0.6, 0.6]) {
        const nail = this._rod(this.darkMetalMat, 0.022, 0.09, nx, 0.16, 0);
        nail.rotation.z = 0.25;
        group.add(nail);
      }
      // The glow strip: it reads as "you can pick this up", not as a light source.
      group.add(this._box(this.plankGlowMat, 1.5, 0.012, 0.05, 0, 0.145, 0));
      return group;
    }

    const item = new THREE.Mesh(this.boxGeo, this.rewardMats[p.type] || this.screenMat);
    item.scale.set(0.32, 0.32, 0.32);
    item.position.y = 0.42;
    group.add(item);
    return group;
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
  // Bolt the switch to a REAL, WHOLE wall of a hallway cell out beyond the room.
  //
  // Never a windowed wall: a window is a hole with a sill, so a switch mounted on
  // one would be hanging in mid-air over the gap, reachable and readable from the
  // wrong side, and plainly broken. `isWindowWall` exists purely to rule that out.
  //
  // If the cell it picked somehow has no solid wall at all (an open junction), we
  // stand it in the middle of the floor rather than dropping it into the void.
  _switchPlacement(s) {
    const solid = (t, i, j) => isWall(t, i, j) && !isWindowWall(t, i, j);
    const inRoom = (i, j) => i >= s.ri && i <= s.ri + 1 && j >= s.rj && j <= s.rj + 1;

    // The ideal cell may have nothing to bolt to — an open junction, or a cell
    // whose only walls happen to be windows. Rather than leave a lever standing in
    // mid-air (which happened for about one room in twenty), walk outwards through
    // neighbouring cells in a FIXED order until we find a solid wall. Fixed order
    // keeps it deterministic, so the daily challenge still puts every switch in
    // exactly the same place for everyone.
    const ring = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [2, 0], [-2, 0], [0, 2], [0, -2],
    ];

    for (const [ox, oy] of ring) {
      const ci = s.switchCell[0] + ox;
      const cj = s.switchCell[1] + oy;
      if (inRoom(ci, cj)) continue; // it belongs OUT in the hallways
      const cx = (ci + 0.5) * CELL;
      const cz = (cj + 0.5) * CELL;
      const faces = [
        { on: solid(1, ci, cj), x: ci * CELL + 0.22, z: cz, yaw: Math.PI / 2 },            // west
        { on: solid(1, ci + 1, cj), x: (ci + 1) * CELL - 0.22, z: cz, yaw: -Math.PI / 2 }, // east
        { on: solid(0, ci, cj), x: cx, z: cj * CELL + 0.22, yaw: 0 },                      // south
        { on: solid(0, ci, cj + 1), x: cx, z: (cj + 1) * CELL - 0.22, yaw: Math.PI },      // north
      ];
      const found = faces.find((f) => f.on);
      if (found) return found;
    }

    // Nowhere in the whole neighbourhood has a wall. Stand it on the floor rather
    // than dropping it into the void.
    const ci = s.switchCell[0];
    const cj = s.switchCell[1];
    return { x: (ci + 0.5) * CELL, z: (cj + 0.5) * CELL, yaw: 0 };
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
    const boxFor = (e, half) =>
      e.horiz
        ? { minX: e.i * CELL, maxX: (e.i + 1) * CELL, minZ: e.z - half, maxZ: e.z + half }
        : { minX: e.x - half, maxX: e.x + half, minZ: e.j * CELL, maxZ: (e.j + 1) * CELL };

    for (const room of this.rooms.values()) {
      if (!room.group) continue;

      // --- The door ---
      // Locked/closed: solid to everyone. Open: an `entityOnly` ward — you pass
      // through the doorway, they cannot, even with it standing wide. SPENT: no box
      // at all. That is the whole cost of having used the room.
      if (room.door.state !== "spent") {
        const box = boxFor(room.spec.door, DOOR_T / 2);
        if (room.door.state === "open") out.push({ ...box, entityOnly: true });
        else out.push(box);
      }

      // --- The vent ---
      // Sealed: a solid wall, no different from the concrete either side of it.
      // Open:   a `window` bound — which is precisely the broken-window rule
      //         already in the engine: solid to everyone, except a player who is
      //         mid-vault. Tagging it `crawl` inverts the arc so you duck into it
      //         rather than hop over it. They cannot follow you down a duct.
      // Breached: nothing. They chewed through it and they're coming in.
      if (room.vent.state !== "breached") {
        const box = boxFor(room.spec.vent, DOOR_T / 2);
        if (room.vent.state === "open") out.push({ ...box, window: true, crawl: true });
        else out.push(box);
      }
    }
    this.world.extraBounds = out;
  }

  // The pathfinder's veto: while a door or a grate still stands, that edge is a
  // wall as far as the entities are concerned, so they route to the OUTSIDE of it
  // and stop there. Break either one and the veto lifts and they walk straight in.
  _pathGate(type, i, j) {
    const id = type + ":" + i + ":" + j;
    for (const room of this.rooms.values()) {
      if (room.spec.door.id === id) return room.door.state !== "spent";
      if (room.spec.vent.id === id) return room.vent.state !== "breached";
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

    // THE ROOM IS SPENT THE MOMENT YOU WALK OUT OF IT.
    // Step through that door from the inside and it never closes again — the seal
    // is broken, the ward is gone, and from now on anything can wander in. It is
    // one use, and this line is where you spend it.
    //
    // Crawling out through the VENT does not do this: the door is still shut behind
    // you. But you'll have had the grate off to manage it, which is its own problem.
    if (room.wasInside && !inside && room.door.state === "open") {
      room.door.state = "spent";
      this._rebuildBounds();
      this.fx.doorSpent();
    }
    room.wasInside = inside;

    // A room is only a refuge while it's still sealed: the door unspent, and the
    // vent not chewed open.
    const compromised = room.door.state === "spent" || room.vent.state === "breached";
    this.playerIsSafe = inside && !compromised;

    // WHERE they lay siege. They go for the VENT if you've had the grate off — it's
    // the soft spot and they know it. Otherwise they pile up on the door and beat
    // on it, which achieves precisely nothing (the door does not break) but keeps
    // them parked between you and the only way out.
    const weakPoint = room.vent.state === "open" ? s.vent.outside : s.outside;
    this.entities.setSiege(this.playerIsSafe ? weakPoint : null);
    room.underSiegeAt = this.playerIsSafe ? (room.vent.state === "open" ? "vent" : "door") : null;

    this._door(dt, room, player, world);
    this._siege(dt, room);
    this._props(room, player);
    this._terminalNoise(dt, room, player);
    this._interactions(room, player, holdingInteract, dt);

    // The only thing with a health bar is the vent — and only once you've opened it.
    if (room.vent.state === "open") {
      this.hud = {
        pct: room.vent.durability / VENT_MAX,
        sieging: room.underSiegeAt === "vent",
        vent: true,
      };
    }
  }

  // --- The door: push-to-open, bounce off if locked, and swing shut behind you --
  _door(dt, room, player, world) {
    const d = room.spec.door;
    const st = room.door;
    const px = player.pos.x;
    const pz = player.pos.z;
    const dist = Math.hypot(d.x - px, d.z - pz);

    if (st.state === "spent") {
      this._applyDoorVisual(room, dt); // hangs open. forever.
      return;
    }

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

    this._applyDoorVisual(room, dt);
  }

  _applyDoorVisual(room, dt = 0) {
    const pivot = room.meshes.pivot;
    const slab = room.meshes.slab;
    if (!pivot || !slab) return;
    const st = room.door;
    const d = room.spec.door;

    // The door never takes damage, so the slab never changes shape — it only
    // swings. Spent, it simply stands open and stays there.
    const width = CELL * 0.94;
    slab.scale.set(d.horiz ? width : DOOR_T, DOOR_H, d.horiz ? DOOR_T : width);
    slab.position.set(0, DOOR_H / 2, 0);

    const target = st.state === "open" || st.state === "spent" ? -Math.PI * 0.52 : 0;
    st.swing = st.swing === undefined ? target : st.swing;
    st.swing += (target - st.swing) * Math.min(1, (dt || 0.016) * 7); // ease; it's heavy
    pivot.rotation.y = st.swing;
  }

  // --- The siege: they hammer, and something gives -------------------------
  _siege(dt, room) {
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

    // THE DOOR CANNOT BE HURT. They can stand out there and beat on it until they
    // lose heart, and all it does is make a noise. The ONLY thing in this room that
    // can be broken is the vent — and only because you took the grate off it.
    if (room.underSiegeAt !== "vent") return;

    const st = room.vent;
    if (st.state !== "open") return;

    st.durability -= DECAY_PER_ENTITY * banging * dt;
    if (st.durability > 0) return;

    // They're through the duct.
    st.durability = 0;
    st.state = "breached";
    this.playerIsSafe = false;
    this.entities.setSiege(null); // nothing left to besiege — they're coming in
    this._rebuildBounds();
    this._applyVentVisual(room);
    this.audio.doorBreach();
    this.fx.breach(true);
  }

  _applyVentVisual(room) {
    const grate = room.meshes.grate;
    if (!grate) return;
    const st = room.vent.state;
    // Pried off: the grate hangs by one corner. Chewed through: it's gone.
    grate.visible = st !== "breached";
    if (st === "open") {
      grate.rotation.z = 0.9;
      grate.position.x = -VENT_W * 0.45;
    } else if (st === "sealed") {
      grate.rotation.z = 0;
      grate.position.x = 0;
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
    const open = room.door.state === "spent" || room.vent.state === "breached";
    const radius = open ? TYPE_NOISE_BREACHED : TYPE_NOISE_SAFE;
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
    //
    // There is only ONE thing left to repair: the vent. The door cannot be damaged,
    // so it cannot be mended, and the planks now exist for exactly one purpose —
    // undoing the mistake of having opened the grate while they were still outside.
    const atDoor = Math.hypot(s.door.x - px, s.door.z - pz) < REACH;
    const atVent = Math.hypot(s.vent.x - px, s.vent.z - pz) < REACH;

    const canRepair =
      atVent && room.vent.state === "open" && room.vent.durability < VENT_MAX && this.inv.has("plank");

    if (canRepair && holding) {
      this._repair += dt;
      if (this._repair >= REPAIR_HOLD) {
        this._repair = 0;
        this.inv.take("plank");
        room.vent.durability = Math.min(VENT_MAX, room.vent.durability + PLANK_REPAIR);
        this.audio.hammer();
        // Hammering is loud. Boarding up tells everything nearby exactly where you
        // are and exactly which hole you're worried about.
        this.entities.hearNoise(px, pz, 18);
      }
      this.prompt = {
        text: `BOARDING UP VENT… ${Math.round((this._repair / REPAIR_HOLD) * 100)}%`,
        kind: "repair",
      };
      return;
    }
    this._repair = 0;

    // The grate. One pull, and it does not go back on.
    if (atVent && room.vent.state === "sealed") {
      this.prompt = { text: "[E] PRY OPEN VENT · ESCAPE ROUTE", kind: "vent" };
      return;
    }
    if (atVent && room.vent.state === "open" && !this.inv.has("plank")) {
      this.prompt = { text: "VENT OPEN · WALK IN TO CRAWL", kind: "ventOpen" };
      return;
    }

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
      this.prompt = { text: "[HOLD E] BOARD UP VENT (+30%)", kind: "repair" };
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
        // The arm drops on its pivot and STAYS down — a pulled switch reads as
        // pulled from the far end of the corridor, so you never have to walk back
        // to check whether you already did this one.
        if (room.meshes.lever) room.meshes.lever.rotation.x = 1.15;
        this.audio.switchPull();
        // A switch being thrown is a hard, mechanical CLANG. It carries.
        this.entities.hearNoise(player.pos.x, player.pos.z, 20);
        break;

      case "vent":
        // The grate comes off, and that's irreversible. From here the room has a
        // soft spot, and the next siege will go straight for it.
        room.vent.state = "open";
        this._applyVentVisual(room);
        this._rebuildBounds();
        this.audio.ventPry();
        this.entities.hearNoise(player.pos.x, player.pos.z, 16); // metal on concrete
        this.fx.ventOpen();
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
      // "You are exposed" — the room is no longer sealed, so your typing carries.
      breached: room.door.state === "spent" || room.vent.state === "breached",
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
    // The cabinet door swings wide and its strip goes from cyan standby to a live
    // green — visible across the room, so you know it worked without turning round.
    if (room.meshes.lockerDoor) {
      room.meshes.lockerDoor.rotation.y = -1.1;
      room.meshes.lockerDoor.position.x -= 0.38;
      room.meshes.lockerDoor.position.z += 0.16;
    }
    if (room.meshes.lockerStrip) room.meshes.lockerStrip.material = this.trimLitMat;

    this.closeTerminal(player);
    this.fx.taskDone(room.reward);
    return "done";
  }
}
