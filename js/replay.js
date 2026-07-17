// replay.js
// -----------------------------------------------------------------------------
// Run replays, for spectating a leaderboard run after the fact.
//
// The world is SEED-DETERMINISTIC, so the maze rebuilds itself from the seed. The
// things that are NOT deterministic — the camera, the inhabitants, and when you
// pinged — are recorded here so the replay shows the run as it actually happened:
//
//   * CAMERA  — the player's pose, sampled at a fixed rate WHILE ACTIVELY PLAYING
//               (pauses aren't sampled, so they drop out for free).
//   * ENTITIES — a snapshot of every nearby inhabitant's position + facing at each
//               sample, stored RELATIVE to the camera (so it fits in Int16 cm).
//   * PINGS   — the sample index of each sonar ping, so the reveal lights the maze
//               at the same moments it did for the player.
//
// encode()/decode() pack it small: start position as absolute cm then Int16
// deltas, quantised yaw/pitch, per-sample entity counts + relative poses, and ping
// indices — all base64'd.

import { installReveal } from "./reveal.js";

export const REPLAY_RATE = 8;                 // samples per second
const MAX_SAMPLES = REPLAY_RATE * 60 * 12;    // cap: 12 minutes
export const EYE_HEIGHT = 1.7;                 // matches player.js
const MAX_GHOSTS = 24;                          // most inhabitants recorded per frame
const REC_ENTITY_DIST = 45;                     // only record inhabitants within this

// --- Recorder ---------------------------------------------------------------
export class ReplayRecorder {
  constructor() {
    this.reset();
  }
  reset() {
    this.samples = [];
    this.entityFrames = [];
    this.pings = [];
    this._acc = 0;
    this.full = false;
  }
  // Call every frame that the player is ACTIVELY playing (not paused, not dead).
  // `entities` is the live inhabitant list (each { x, z, group.rotation.y }).
  sample(dt, pos, yaw, pitch, entities) {
    if (this.full) return;
    this._acc += dt;
    const step = 1 / REPLAY_RATE;
    let guard = 4; // a huge dt must not dump hundreds of samples at once
    while (this._acc >= step && guard-- > 0) {
      this._acc -= step;
      this.samples.push({ x: pos.x, z: pos.z, yaw, pitch });
      this.entityFrames.push(snapshotEntities(entities, pos));
      if (this.samples.length >= MAX_SAMPLES) {
        this.full = true;
        break;
      }
    }
  }
  // A sonar ping fired — remember when, so the replay lights up at the same moment.
  markPing() {
    if (!this.full) this.pings.push(this.samples.length);
  }
  encoded() {
    return encodeReplay(this.samples, this.entityFrames, this.pings);
  }
}

function snapshotEntities(entities, pos) {
  const out = [];
  if (!entities) return out;
  for (const e of entities) {
    const rx = e.x - pos.x;
    const rz = e.z - pos.z;
    if (rx * rx + rz * rz > REC_ENTITY_DIST * REC_ENTITY_DIST) continue;
    out.push({ rx, rz, yaw: e.group ? e.group.rotation.y : 0 });
    if (out.length >= MAX_GHOSTS) break;
  }
  return out;
}

// --- Codec ------------------------------------------------------------------
function wrapPi(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function clampI16(v) {
  return Math.max(-32768, Math.min(32767, v | 0));
}
function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function bufferFromB64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeReplay(samples, entityFrames = [], pings = []) {
  const n = samples.length;
  if (n < 2) return "";

  // Camera.
  const x0 = Math.round(samples[0].x * 100);
  const z0 = Math.round(samples[0].z * 100);
  const dx = new Int16Array(n - 1);
  const dz = new Int16Array(n - 1);
  const yaw = new Int16Array(n);
  const pitch = new Int16Array(n);
  let px = x0;
  let pz = z0;
  for (let k = 0; k < n; k++) {
    const cx = Math.round(samples[k].x * 100);
    const cz = Math.round(samples[k].z * 100);
    if (k > 0) {
      dx[k - 1] = clampI16(cx - px);
      dz[k - 1] = clampI16(cz - pz);
    }
    px = cx;
    pz = cz;
    yaw[k] = clampI16(Math.round(wrapPi(samples[k].yaw) * 10000));
    pitch[k] = clampI16(Math.round(samples[k].pitch * 10000));
  }

  // Entities: a count per sample, then a flat run of [relX, relZ, yaw] Int16s.
  const counts = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const c = Math.min(MAX_GHOSTS, (entityFrames[i] || []).length);
    counts[i] = c;
    total += c;
  }
  const ed = new Int16Array(total * 3);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const fr = entityFrames[i] || [];
    const c = counts[i];
    for (let k = 0; k < c; k++) {
      const e = fr[k];
      ed[w++] = clampI16(Math.round(e.rx * 100));
      ed[w++] = clampI16(Math.round(e.rz * 100));
      ed[w++] = clampI16(Math.round(wrapPi(e.yaw) * 10000));
    }
  }

  // Pings: sample indices, clamped in range.
  const pg = new Uint16Array(pings.length);
  for (let i = 0; i < pings.length; i++) {
    pg[i] = Math.min(n - 1, Math.max(0, pings[i] | 0));
  }

  return JSON.stringify({
    v: 2,
    r: REPLAY_RATE,
    n,
    x0,
    z0,
    dx: b64FromBuffer(dx.buffer),
    dz: b64FromBuffer(dz.buffer),
    y: b64FromBuffer(yaw.buffer),
    p: b64FromBuffer(pitch.buffer),
    ec: b64FromBuffer(counts.buffer),
    ed: b64FromBuffer(ed.buffer),
    pg: b64FromBuffer(pg.buffer),
  });
}

export function decodeReplay(str) {
  if (!str) return null;
  let o;
  try {
    o = JSON.parse(str);
  } catch {
    return null;
  }
  if (!o || !o.n || o.n < 2) return null;
  const n = o.n;

  // Camera.
  const dx = new Int16Array(bufferFromB64(o.dx).buffer);
  const dz = new Int16Array(bufferFromB64(o.dz).buffer);
  const yaw = new Int16Array(bufferFromB64(o.y).buffer);
  const pitch = new Int16Array(bufferFromB64(o.p).buffer);
  const samples = new Array(n);
  let cx = o.x0;
  let cz = o.z0;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      cx += dx[k - 1];
      cz += dz[k - 1];
    }
    samples[k] = { x: cx / 100, z: cz / 100, yaw: yaw[k] / 10000, pitch: pitch[k] / 10000 };
  }

  // Entities (v2). Positions were stored relative to the camera sample.
  const entityFrames = new Array(n);
  if (o.ec && o.ed) {
    const counts = bufferFromB64(o.ec);
    const ed = new Int16Array(bufferFromB64(o.ed).buffer);
    let r = 0;
    for (let i = 0; i < n; i++) {
      const c = counts[i] || 0;
      const arr = new Array(c);
      for (let k = 0; k < c; k++) {
        const rx = ed[r++] / 100;
        const rz = ed[r++] / 100;
        const gyaw = ed[r++] / 10000;
        arr[k] = { x: samples[i].x + rx, z: samples[i].z + rz, yaw: gyaw };
      }
      entityFrames[i] = arr;
    }
  } else {
    for (let i = 0; i < n; i++) entityFrames[i] = [];
  }

  // Pings.
  let pings = [];
  if (o.pg) pings = Array.from(new Uint16Array(bufferFromB64(o.pg).buffer));

  return { rate: o.r || REPLAY_RATE, samples, entityFrames, pings };
}

// --- Playback ---------------------------------------------------------------
// Streams a decoded replay back into the shared camera, and drives a pool of ghost
// inhabitants (same look as the real ones) along their recorded snapshots. Pings
// are surfaced via poll() so game.js can fire the actual reveal.
export class ReplayPlayback {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.active = false;

    // A fixed pool of ghost inhabitants, matching the maze look: dark body, red
    // eyes (MeshBasicMaterial, always visible even before a ping).
    // Body catches the sonar reveal like the real inhabitants (Phong + reveal);
    // the eyes are always-on red. Matches how they looked in the run.
    this.bodyMat = new THREE.MeshPhongMaterial({ color: 0x0a0a0a, shininess: 0 });
    installReveal(this.bodyMat);
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    const bodyGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8);
    const headGeo = new THREE.SphereGeometry(0.26, 10, 8);
    const eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
    this.ghosts = [];
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, this.bodyMat);
      body.position.y = 0.75;
      const head = new THREE.Mesh(headGeo, this.bodyMat);
      head.position.y = 1.6;
      const eyeL = new THREE.Mesh(eyeGeo, this.eyeMat);
      eyeL.position.set(-0.09, 1.62, 0.2);
      const eyeR = eyeL.clone();
      eyeR.position.x = 0.09;
      g.add(body, head, eyeL, eyeR);
      g.visible = false;
      scene.add(g);
      this.ghosts.push(g);
    }
  }

  load(decoded) {
    this.samples = decoded.samples;
    this.entityFrames = decoded.entityFrames || [];
    this.pings = decoded.pings || [];
    this.rate = decoded.rate;
    this.t = 0;
    this.done = false;
    this.active = true;
    this._pingCursor = 0;
  }

  progress() {
    if (!this.samples || this.samples.length < 2) return 1;
    return clamp01((this.t * this.rate) / (this.samples.length - 1));
  }

  get pos() {
    return this._pos || { x: this.samples[0].x, y: EYE_HEIGHT, z: this.samples[0].z };
  }

  // Ping events whose time has arrived since the last frame — game.js fires the
  // reveal at each (from the current camera position, where the player pinged).
  poll() {
    const due = [];
    if (!this.pings) return due;
    const idxNow = Math.floor(this.t * this.rate);
    while (this._pingCursor < this.pings.length && this.pings[this._pingCursor] <= idxNow) {
      due.push({ x: this.pos.x, z: this.pos.z });
      this._pingCursor++;
    }
    return due;
  }

  update(dt) {
    if (!this.active || !this.samples || this.samples.length < 2) {
      this.done = true;
      return;
    }
    this.t += dt;
    const f = this.t * this.rate;
    const last = this.samples.length - 1;
    let i = Math.floor(f);
    let u = f - i;
    if (i >= last) {
      i = last;
      u = 0;
      this.done = true;
    }

    // Camera.
    const a = this.samples[i];
    const b = u > 0 ? this.samples[i + 1] : a;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const yaw = a.yaw + wrapPi(b.yaw - a.yaw) * u;
    const pitch = a.pitch + (b.pitch - a.pitch) * u;
    this._pos = { x, y: EYE_HEIGHT, z };
    this.camera.position.set(x, EYE_HEIGHT, z);
    _euler.set(pitch, yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(_euler);

    // Ghost inhabitants. Interpolate a slot only when its two frames are close
    // (the same inhabitant moved); a big jump means the slot changed hands, so
    // snap instead of gliding one ghost across the maze.
    const fa = this.entityFrames[i] || [];
    const fb = u > 0 ? this.entityFrames[i + 1] || fa : fa;
    for (let k = 0; k < this.ghosts.length; k++) {
      const gh = this.ghosts[k];
      if (k >= fa.length) {
        gh.visible = false;
        continue;
      }
      const ea = fa[k];
      let gx = ea.x;
      let gz = ea.z;
      let gyaw = ea.yaw;
      if (u > 0 && k < fb.length) {
        const eb = fb[k];
        if (Math.hypot(eb.x - ea.x, eb.z - ea.z) < 2) {
          gx = ea.x + (eb.x - ea.x) * u;
          gz = ea.z + (eb.z - ea.z) * u;
          gyaw = ea.yaw + wrapPi(eb.yaw - ea.yaw) * u;
        }
      }
      gh.position.set(gx, 0, gz);
      gh.rotation.y = gyaw;
      gh.visible = true;
    }
  }

  // Hide the ghosts when the replay ends or the viewer exits.
  dispose() {
    this.active = false;
    for (const g of this.ghosts) g.visible = false;
  }
}

const _euler = typeof THREE !== "undefined" ? new THREE.Euler() : null;
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
