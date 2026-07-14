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
//   6. FINISH IT. The terminal chimes, the things outside scatter, and the
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

import { CELL, WALL_H, WALL_T, chunkRoom } from "./world.js";
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
const PUSH_DIST = 1.6;          // how close you must be to shoulder the door
const REACH = 2.5;              // interaction reach for everything else
const OPEN_TIME = 2.2;          // how long the door stands open before swinging to
const THUD_COOLDOWN = 0.7;
// Durability drain per second, PER besieger. Only the vent has durability now.
const DECAY_PER_ENTITY = 1.7;

const TASK_CODES = 3;           // codes to type before the task is done
const TYPE_NOISE_SAFE = 13;     // how far your typing carries with the door intact
const TYPE_NOISE_BREACHED = 30; // ...and with the door gone. A dinner bell.
const TYPE_NOISE_INTERVAL = 2.0;

// Two chunks. A chunk is 36m, so the door is heard 72m away — three times further
// than a sonar ping carries, and further than you can see.
const DOOR_NOISE_RADIUS = 72;

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
// stay. And it does NOT go back on — there is no boarding it up, no undo, no second
// chance. If you take that grate off, you had better be leaving through it.
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

// (The fire-alarm KeySwitch texture lived here. The lever is gone: pulling a
//  handle asked nothing of the player except walking to it. The keypad asks you to
//  carry ten digits through a dark maze, which is a very different thing.)

// A canvas texture of the 4-digit serial, self-lit so it can actually be READ in
// the pitch dark. This is the one concession: without it the whole mechanic would
// be "wander around hoping", because you cannot read stencilled paint by echo.
// Ten digits is a lot to hold in your head, so the plate does the one thing it
// honestly can to help: it GROUPS them, 3-3-4, the way a phone number is grouped.
// That's the difference between remembering ten things and remembering three.
function makeSerialTexture(serial) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 160;
  const g = c.getContext("2d");

  g.fillStyle = "#04161c";
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = "#27e0ff";
  g.lineWidth = 5;
  g.strokeRect(8, 8, 496, 144);

  g.fillStyle = "rgba(143, 244, 255, 0.55)";
  g.font = "bold 20px 'Courier New', monospace";
  g.textAlign = "center";
  g.fillText("DOOR CODE", 256, 38);

  const grouped = `${serial.slice(0, 3)} ${serial.slice(3, 6)} ${serial.slice(6)}`;
  g.fillStyle = "#8ff4ff";
  g.font = "bold 58px 'Courier New', monospace";
  g.textBaseline = "middle";
  g.shadowColor = "#27e0ff";
  g.shadowBlur = 20;
  g.fillText(grouped, 256, 100);

  return new THREE.CanvasTexture(c);
}

// The keypad's own face: a grubby steel plate with a 3x4 grid of keys pressed into
// it and a little green readout above them.
function makeKeypadTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");

  const base = g.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, "#6d7681");
  base.addColorStop(1, "#4a525b");
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);

  // Readout.
  g.fillStyle = "#06170f";
  g.fillRect(28, 22, 200, 48);
  g.strokeStyle = "rgba(0,0,0,0.5)";
  g.lineWidth = 3;
  g.strokeRect(28, 22, 200, 48);
  g.fillStyle = "#1cff8f";
  g.font = "bold 26px 'Courier New', monospace";
  g.textAlign = "center";
  g.shadowColor = "#1cff8f";
  g.shadowBlur = 12;
  g.fillText("- - - - - - - - - -", 128, 55);
  g.shadowBlur = 0;

  // Keys.
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  let k = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 44 + col * 60;
      const y = 88 + row * 40;
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.fillRect(x - 2, y - 2, 48, 32);
      g.fillStyle = "#9aa3ad";
      g.fillRect(x, y, 46, 30);
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(x, y, 46, 4);
      g.fillStyle = "#1c2126";
      g.font = "bold 20px 'Courier New', monospace";
      g.fillText(keys[k++], x + 23, y + 22);
    }
  }

  for (let i = 0; i < 600; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  return new THREE.CanvasTexture(c);
}

export class SafeRooms {
  constructor(scene, world, audio, entities, inv, fx) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.entities = entities;
    this.inv = inv; // { give(type,n), has(type), take(type) }
    this.fx = fx;   // { codeAccepted, taskDone, breach, ventOpen, doorSpent }

    this.rooms = new Map();     // chunk key -> room state (SURVIVES streaming)
    this.playerIsSafe = false;
    this.active = null;         // the room you're standing in or at
    this.prompt = null;         // { text, kind } for the HUD
    // ONE panel, two uses: the door KEYPAD out in the hall, and the TERMINAL in
    // the room. Both lock your camera to a screen and eat digits; they differ only
    // in what they want and what happens when they get it.
    this.terminal = null;       // { room, kind: "keypad"|"terminal", typed }
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
    const keypadTex = makeKeypadTexture();
    this.keypadMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 18, map: keypadTex,
      emissive: 0x4a5158, emissiveMap: keypadTex, // faintly lit; findable in the dark
    });
    installReveal(this.keypadMat, cyanFlash);
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

    // Self-lit bits. These IGNORE the darkness — a screen, a glowing button and a
    // stencilled number are meant to be findable, and a room you can't find is
    // just a wall.
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x1cff8f });
    this.panicMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
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
    const n = Number(spec.code);
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
      ventPassable: false, // the crawl only opens up while you're inside the room
      switchPulled: false,
      // Digits entered at the keypad SO FAR, kept on the room rather than on the
      // panel session. That's the whole "chunk by chunk" mechanic: step away from
      // the keypad — because something is coming, because you need to go back and
      // re-read the door, because you just can't hold ten digits at once — and the
      // pad still has what you gave it. Come back and carry on where you left off.
      // It only cares that the code gets finished, not that it gets finished in one
      // go.
      keypadTyped: "",
      task: { index: 0, done: false },
      lockerOpen: false,
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
        map: makeSerialTexture(s.code),
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

    // --- The KEYPAD, bolted to the DOOR itself -------------------------------
    //
    // Third home for this thing, and this one is right.
    //
    // It started in the hallways, and nobody could find it. Then it moved to the
    // wall beside the door — and the maths there was actually CORRECT (it really was
    // on the corridor face, I checked all 196 rooms in a seed) but it was still the
    // wrong place, because "the wall beside the door" is a different cell of
    // corridor, and the maze is perfectly entitled to run a wall between that
    // stretch and the doorway. You could stand at the door looking at a keypad you'd
    // have to walk half a chunk around to touch.
    //
    // On the door, none of that can happen: it is on the outer face, an arm's length
    // from the code it opens, and if you can reach the door you can reach it.
    //
    // The memory game is untouched. Using it throws a full-screen panel up, so the
    // instant you start typing, the door — and the ten digits painted on it — is
    // gone from view. Read it, hold it, enter it blind.
    const dirX = d.dir[0];
    const dirZ = d.dir[1];
    const alongAxis = d.horiz ? [1, 0] : [0, 1]; // the axis the door runs along
    const kpOut = DOOR_T / 2 + 0.07;
    const kpAlong = 1.8; // off to one side, clear of the code plate

    room.keypadPos = {
      x: d.x + alongAxis[0] * kpAlong + dirX * kpOut,
      z: d.z + alongAxis[1] * kpAlong + dirZ * kpOut,
    };

    // Parented to the DOOR group (whose local axes are world-aligned at rest), so it
    // swings away with the door once it's open — which is correct: a keypad on an
    // open door has nothing left to do.
    const kpGroup = new THREE.Group();
    kpGroup.position.set(
      alongAxis[0] * kpAlong + dirX * kpOut,
      0,
      alongAxis[1] * kpAlong + dirZ * kpOut
    );
    kpGroup.rotation.y = Math.atan2(dirX, dirZ); // face the corridor
    door.add(kpGroup);

    kpGroup.add(this._box(this.darkMetalMat, 0.5, 0.64, 0.04, 0, 1.45, 0));  // backing plate
    kpGroup.add(this._box(this.keypadMat, 0.4, 0.54, 0.08, 0, 1.45, 0.05));  // the pad itself
    kpGroup.add(this._box(this.darkMetalMat, 0.44, 0.04, 0.1, 0, 1.15, 0.05)); // lip beneath
    for (const bx of [-0.21, 0.21]) {
      for (const by of [1.74, 1.17]) {
        kpGroup.add(this._rod(this.darkMetalMat, 0.02, 0.03, bx, by, 0.02)); // bolts
      }
    }
    // A status lamp: red until the code is in, green after. It's self-lit and it's
    // the brightest thing on the door apart from the code — so from down the corridor
    // you can see BOTH that there's a door and whether you've already opened it.
    const keypadLamp = this._box(this.panicMat, 0.08, 0.08, 0.03, 0.14, 1.76, 0.07);
    kpGroup.add(keypadLamp);
    room.meshes.keypadLamp = keypadLamp;

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
    //
    // THE WALL AROUND IT IS BUILT HERE, and it has to be, which is what went wrong:
    // the vent's edge is flagged as an "opening" so the maze builds NO wall there
    // at all — same as the doorway. But a door fills its whole opening and a vent
    // does not. It's a 1.1m hole in a 6m wall. So the other 4.9m of that wall was
    // simply MISSING: you could see straight out of the back of every safe room,
    // and walk out through it.
    //
    // So the safe room supplies the wall itself: two posts either side of the hole,
    // a lintel above it and a sill below. Outer skin uses the world's own wall
    // material (so from the corridor it is ordinary yellow wall), with a concrete
    // lining on the room side, exactly like the rest of the shell.
    const v = s.vent;
    const ventGroup = new THREE.Group();
    ventGroup.position.set(v.x, 0, v.z);
    ventGroup.rotation.y = v.horiz ? 0 : Math.PI / 2;

    const midY = VENT_SILL + VENT_H / 2;
    const postW = (CELL - VENT_W) / 2; // 2.45m of wall either side of the hole
    const wallMat = this.world.wallMats[3];
    const lineMat = this.world.roomWallMat;
    // Which local +Z is the corridor? After the group's rotation, +Z is world +Z
    // for a horizontal wall and world +X for a vertical one.
    const outSign = v.horiz ? v.dir[1] : v.dir[0];
    const skin = 0.04;
    const face = WALL_T / 2 + 0.02;

    for (const sx of [-1, 1]) {
      const px = sx * (VENT_W / 2 + postW / 2);
      ventGroup.add(this._box(wallMat, postW, WALL_H, WALL_T, px, WALL_H / 2, 0));
      ventGroup.add(this._box(lineMat, postW, WALL_H, skin, px, WALL_H / 2, -outSign * face));
    }
    // Lintel above the hole, and the sill you crawl over.
    const lintelH = WALL_H - (VENT_SILL + VENT_H);
    ventGroup.add(this._box(wallMat, VENT_W, lintelH, WALL_T, 0, WALL_H - lintelH / 2, 0));
    ventGroup.add(this._box(lineMat, VENT_W, lintelH, skin, 0, WALL_H - lintelH / 2, -outSign * face));
    ventGroup.add(this._box(wallMat, VENT_W, VENT_SILL, WALL_T, 0, VENT_SILL / 2, 0));

    // Frame: a steel lip around the opening so it reads as a duct, not a gap.
    const fw = VENT_W + 0.16;
    const fh = VENT_H + 0.16;
    ventGroup.add(this._box(this.darkMetalMat, fw, 0.08, 0.42, 0, VENT_SILL - 0.04, 0));
    ventGroup.add(this._box(this.darkMetalMat, fw, 0.08, 0.42, 0, VENT_SILL + VENT_H + 0.04, 0));
    for (const sx of [-1, 1]) {
      ventGroup.add(this._box(this.darkMetalMat, 0.08, fh, 0.42, sx * (fw / 2 - 0.04), midY, 0));
    }
    // The dark of the duct itself, set back inside the hole.
    ventGroup.add(this._box(this.ductMat, VENT_W, VENT_H, 0.06, 0, midY, 0));

    // The grate itself: a plate of angled louvres and four corner bolts. This is
    // what comes off.
    // The grate sits on the ROOM side of the wall, because that's the side you
    // unbolt it from. From the corridor you can't even tell the vent is there.
    const grate = new THREE.Group();
    grate.position.set(0, midY, -outSign * (WALL_T / 2 + 0.04));
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

    // (There is no panic button. There used to be a halon vent on a pedestal in
    // the middle of the room; it was a free "undo" for every mistake the room can
    // make you commit, and it made the vent and the door decisions weightless. The
    // room now has exactly two ways out and no get-out-of-jail card.)

    // (Three planks used to lie on this floor, for nailing the vent back up. They're
    //  gone: see _interactions. `props` now only ever holds what the locker gives you.)
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
    if (room.switchPulled && room.meshes.keypadLamp) {
      room.meshes.keypadLamp.material = this.trimLitMat;
    }
    if (room.lockerOpen) {
      if (room.meshes.lockerDoor) {
        room.meshes.lockerDoor.rotation.y = -1.1;
        room.meshes.lockerDoor.position.x -= 0.38;
        room.meshes.lockerDoor.position.z += 0.16;
      }
      if (room.meshes.lockerStrip) room.meshes.lockerStrip.material = this.trimLitMat;
    }
    this._applyDoorVisual(room);
    this._applyVentVisual(room);
    this._rebuildBounds();
  }

  // A prop lying on the floor — these days, only ever the locker's prize.
  _propMesh(p) {
    const group = new THREE.Group();
    group.position.set(p.x, 0, p.z);
    group.rotation.y = p.rot || 0;

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

  // (The old hallway search for a wall to bolt the KeySwitch onto lived here. The
  //  keypad is on the door now, so there is nothing to hunt for.)

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
      // The maze builds NO wall on this edge (it's an "opening"), so the safe room
      // owns ALL of its collision — including the two solid posts either side of the
      // hole. Those are permanent: they are wall, and they were missing entirely,
      // which is why you could walk out of the back of a room.
      const v = room.spec.vent;
      const half = WALL_T / 2;
      const postW = (CELL - VENT_W) / 2;
      for (const sx of [-1, 1]) {
        const off = sx * (VENT_W / 2 + postW / 2);
        out.push(
          v.horiz
            ? { minX: v.x + off - postW / 2, maxX: v.x + off + postW / 2, minZ: v.z - half, maxZ: v.z + half }
            : { minX: v.x - half, maxX: v.x + half, minZ: v.z + off - postW / 2, maxZ: v.z + off + postW / 2 }
        );
      }

      // And the hole in the middle of them:
      //   sealed    - solid. It's a grate bolted into concrete.
      //   open      - a `window` bound tagged `crawl` (the broken-window rule that's
      //               already in the engine: solid to all, except a player mid-vault;
      //               `crawl` inverts the arc so you duck in rather than hop over).
      //               ONLY while the player is INSIDE — see _ventPassable below. It is
      //               a way OUT, not a way in.
      //   breached  - nothing at all. They chewed through it and they're coming in.
      if (room.vent.state !== "breached") {
        const hole = v.horiz
          ? { minX: v.x - VENT_W / 2, maxX: v.x + VENT_W / 2, minZ: v.z - half, maxZ: v.z + half }
          : { minX: v.x - half, maxX: v.x + half, minZ: v.z - VENT_W / 2, maxZ: v.z + VENT_W / 2 };
        if (room.vent.state === "open" && room.ventPassable) {
          out.push({ ...hole, window: true, crawl: true });
        } else {
          out.push(hole);
        }
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

    // A VENT IS AN EXIT, NOT AN ENTRANCE. The crawl bound only exists while you are
    // standing INSIDE the room, so you can never wriggle in through the back of a
    // safe room and skip the door, the code and the whole point of the place. From
    // the corridor an open vent is just a hole with a wall in it.
    // (Once it's BREACHED that stops applying — at that point it isn't a vent, it's
    // damage, and anything can come through it.)
    const passable = inside && room.vent.state === "open";
    if (passable !== room.ventPassable) {
      room.ventPassable = passable;
      this._rebuildBounds();
    }

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
    this._interactions(room, player, holdingInteract, dt, inside);

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
        this._doorNoise(room); // the SLAM. see below.
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
          this._doorNoise(room);
          this._rebuildBounds();
        } else if (this._thud <= 0) {
          this._thud = THUD_COOLDOWN;
          this.audio.doorThud(); // locked. you bounce off it.
        }
      }
    }

    this._applyDoorVisual(room, dt);
  }

  // THE DOOR IS THE LOUDEST THING IN THE GAME.
  //
  // Half a tonne of steel dragging on its hinges and slamming into a concrete
  // frame, in a building where the only other sounds are your own footsteps. It
  // carries for TWO CHUNKS — 72 metres, further than any sonar ping — and every
  // single thing inside that radius drops what it's doing and comes to see.
  //
  // Note WHERE they come to: the noise is at the DOOR, not at you. They converge on
  // the doorway, not your position. And the door holds. So what you have bought
  // yourself is a crowd — pressed up against the one thing you have to walk back
  // through, hammering on it, achieving nothing, and going nowhere. Opening the
  // door is safe. Having opened it is the problem.
  _doorNoise(room) {
    const d = room.spec.door;
    this.entities.hearNoise(d.x, d.z, DOOR_NOISE_RADIUS);
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

  // --- Loose props: whatever the locker coughs up ---------------------------
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
  _interactions(room, player, holding, dt, inside) {
    const px = player.pos.x;
    const pz = player.pos.z;
    const near = (p) => p && Math.hypot(p.x - px, p.z - pz) < REACH;
    const s = room.spec;

    // NO REPAIRS. The planks are gone, and with them the ability to board anything
    // back up.
    //
    // They only ever existed to undo the one irreversible decision the room asks you
    // to make — and an irreversible decision you can undo for the price of a bit of
    // wood on the floor is not a decision. Prying the grate off is now exactly what
    // it says on the tin: permanent. If you open the vent, the room has a soft spot
    // for as long as it exists, and you had better be leaving through it.
    const atDoor = Math.hypot(s.door.x - px, s.door.z - pz) < REACH;
    const atVent = Math.hypot(s.vent.x - px, s.vent.z - pz) < REACH;

    // The vent. ONE prompt, and it says the only thing that matters. Prying the
    // grate and going through it are the same act now — you do not unbolt an
    // escape hatch and then stand around admiring it.
    // Only from the inside: from the corridor the vent isn't an interaction at all.
    if (atVent && inside && room.vent.state !== "breached") {
      this.prompt = { text: "EXIT THROUGH VENT", kind: "vent" };
      return;
    }

    if (near(room.keypadPos) && !room.switchPulled) {
      this.prompt = { text: "KEYPAD", kind: "keypad" };
      return;
    }
    if (near(room.termPos) && !room.task.done) {
      this.prompt = { text: "TERMINAL", kind: "terminal" };
      return;
    }
    if (near(room.lockPos) && room.lockerOpen && room.props.length) {
      this.prompt = { text: "LOCKER", kind: "locker" };
    }

    // NOTHING here tells you the door code. There used to be a prompt that read
    // "LOCKED · SERIAL 1379432359" whenever you stood near a locked door, which is
    // the game reading the door out loud to you — at which point the ten digits are
    // not in your memory, they're in the HUD, and you may as well not have gone to
    // the door at all. The code is painted on the door. Go and read it.
  }

  // A discrete [E] press.
  press(player, world) {
    const room = this.active;
    if (!room || !this.prompt) return;

    switch (this.prompt.kind) {
      case "keypad":
        this.openPanel(room, "keypad", player);
        break;

      case "vent": {
        // Prying the grate and going through it are ONE act. You do not unbolt an
        // escape hatch and then stand around. The grate comes off — irreversibly,
        // the room now has a soft spot and the next siege goes straight for it —
        // and you are already on your belly in the duct.
        const v = room.spec.vent;
        if (room.vent.state === "sealed") {
          room.vent.state = "open";
          this._applyVentVisual(room);
          this.audio.ventPry();
          this.entities.hearNoise(player.pos.x, player.pos.z, 16); // metal on concrete
        }
        room.ventPassable = true;
        this._rebuildBounds();

        // Push them through, outward. Distance covers the wall plus enough clearance
        // to land properly on the far side.
        const gap = v.horiz ? Math.abs(v.z - player.pos.z) : Math.abs(v.x - player.pos.x);
        player.startCrawl(v.dir[0], v.dir[1], gap + 1.4);
        break;
      }

      case "terminal":
        this.openPanel(room, "terminal", player);
        break;

      case "locker":
        for (let k = room.props.length - 1; k >= 0; k--) {
          const p = room.props[k];
          if (!this.inv.give(p.type, 1)) return;
          if (p.mesh) this.scene.remove(p.mesh);
          room.props.splice(k, 1);
          this.audio.pickup();
        }
        break;
    }
  }

  // --- The panel (keypad out in the hall, terminal in the room) --------------
  openPanel(room, kind, player) {
    // The keypad picks up exactly where you left it. The terminal starts its
    // current code fresh — that one is a four-digit code the screen is SHOWING you,
    // so there is nothing to preserve.
    const typed = kind === "keypad" ? room.keypadTyped : "";
    this.terminal = { room, kind, typed };
    player.enabled = false;   // you cannot walk
    player.lookLocked = true; // and you cannot look — not at the corridor behind
    player.touchFwd = 0;      // you, not at the door, and NOT back at the code
    player.touchStrafe = 0;
  }

  closeTerminal(player) {
    if (!this.terminal) return;
    this.terminal = null;
    player.enabled = true;
    player.lookLocked = false;
  }

  // CLR / backspace. Must wipe the ROOM's buffer too, or the pad would forget what
  // you cleared and remember it again the next time you walked up to it.
  clearTyped() {
    if (!this.terminal) return;
    this.terminal.typed = "";
    if (this.terminal.kind === "keypad") this.terminal.room.keypadTyped = "";
  }

  _taskCodes(room) {
    const n = Number(room.spec.code.slice(0, 6)); // 10 digits is too big to multiply cleanly
    const codes = [];
    for (let k = 0; k < TASK_CODES; k++) codes.push(String(1000 + ((n * (k + 7) * 37) % 9000)));
    return codes;
  }

  // What the screen currently reads. game.js renders this.
  //
  // The KEYPAD deliberately returns no target. It cannot show you the code, and it
  // cannot show you how many digits you've got right, because the moment it does
  // either of those things it is remembering the code FOR you and the whole
  // mechanic evaporates. All it gives back is how many digits it has swallowed.
  terminalView() {
    if (!this.terminal) return null;
    const room = this.terminal.room;
    const keypad = this.terminal.kind === "keypad";

    if (keypad) {
      return {
        kind: "keypad",
        title: "DOOR CTRL",
        line: "ENTER 10-DIGIT DOOR CODE",
        target: "",                       // never shown. that's the point.
        typed: this.terminal.typed,
        need: room.spec.code.length,
        index: this.terminal.typed.length,
        total: room.spec.code.length,
        breached: false,
      };
    }

    const codes = this._taskCodes(room);
    return {
      kind: "terminal",
      title: "SYS/RECLAMATION",
      line: "AUTHORISE SEQUENCE — ENTER CODE",
      target: codes[room.task.index] || "",
      typed: this.terminal.typed,
      need: 4,
      index: room.task.index,
      total: TASK_CODES,
      // "You are exposed" — the room is no longer sealed, so your typing carries.
      breached: room.door.state === "spent" || room.vent.state === "breached",
    };
  }

  // A digit typed at a panel. Returns "ok" | "bad" | "done".
  typeDigit(digit, player, world) {
    if (!this.terminal) return null;
    const room = this.terminal.room;
    const t = this.terminal;

    // --- The door keypad ----------------------------------------------------
    if (t.kind === "keypad") {
      t.typed += digit;
      const code = room.spec.code;
      // Write straight through to the room. If you walk away right now — mid-code,
      // three digits in — those three digits are still sitting in the pad when you
      // come back.
      room.keypadTyped = t.typed;

      // It does NOT tell you when you go wrong. It takes all ten digits and then
      // it either opens or it doesn't. Beeping at the digit you fluffed would turn
      // ten digits of memory into ten independent one-digit guesses.
      if (t.typed.length < code.length) {
        this.audio.termKey();
        return "ok";
      }

      const right = t.typed === code;
      t.typed = "";
      room.keypadTyped = "";
      if (!right) {
        this.audio.termError();
        return "bad"; // start again. from memory. from the top.
      }

      room.switchPulled = true; // the door is live
      if (room.door.state === "locked") room.door.state = "closed"; // unlocked, still SHUT
      if (room.meshes.keypadLamp) room.meshes.keypadLamp.material = this.trimLitMat;
      this.audio.termDone();
      this.closeTerminal(player);
      this.fx.codeAccepted();
      return "done";
    }

    // --- The room's terminal task -------------------------------------------
    const view = this.terminalView();
    t.typed += digit;
    // Wrong digit: the whole code resets. Sloppy typing costs you time.
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
