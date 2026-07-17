// replay.js
// -----------------------------------------------------------------------------
// Run replays, for spectating a leaderboard run after the fact.
//
// The world is SEED-DETERMINISTIC, so to replay a run we don't need to record the
// whole world — just the camera. A Recorder samples the player's pose (position,
// yaw, pitch) at a fixed rate WHILE THEY ARE ACTIVELY PLAYING; pauses simply
// aren't sampled, so they drop out of the replay for free. On playback the same
// samples are streamed back into the camera through the same seed's maze.
//
// encode()/decode() pack the samples small enough to sit in a text column: start
// position as absolute centimetres, then Int16 deltas for position and quantised
// yaw/pitch, base64'd. A couple of minutes of play is a few kilobytes.

export const REPLAY_RATE = 8;                 // samples per second
const MAX_SAMPLES = REPLAY_RATE * 60 * 12;    // cap: 12 minutes
export const EYE_HEIGHT = 1.7;                 // matches player.js

// --- Recorder ---------------------------------------------------------------
export class ReplayRecorder {
  constructor() {
    this.reset();
  }
  reset() {
    this.samples = [];
    this._acc = 0;
    this.full = false;
  }
  // Call every frame that the player is ACTIVELY playing (not paused, not dead).
  sample(dt, pos, yaw, pitch) {
    if (this.full) return;
    this._acc += dt;
    const step = 1 / REPLAY_RATE;
    // Guard against a huge dt dumping hundreds of samples at once.
    let guard = 4;
    while (this._acc >= step && guard-- > 0) {
      this._acc -= step;
      this.samples.push({ x: pos.x, z: pos.z, yaw, pitch });
      if (this.samples.length >= MAX_SAMPLES) {
        this.full = true;
        break;
      }
    }
  }
  encoded() {
    return encodeReplay(this.samples);
  }
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

export function encodeReplay(samples) {
  const n = samples.length;
  if (n < 2) return "";
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
  return JSON.stringify({
    v: 1,
    r: REPLAY_RATE,
    n,
    x0,
    z0,
    dx: b64FromBuffer(dx.buffer),
    dz: b64FromBuffer(dz.buffer),
    y: b64FromBuffer(yaw.buffer),
    p: b64FromBuffer(pitch.buffer),
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
  if (!o || o.v !== 1 || !o.n) return null;
  const n = o.n;
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
    samples[k] = {
      x: cx / 100,
      z: cz / 100,
      yaw: yaw[k] / 10000,
      pitch: pitch[k] / 10000,
    };
  }
  return { rate: o.r || REPLAY_RATE, samples };
}

// --- Playback ---------------------------------------------------------------
// Streams a decoded replay back into the shared camera. game.js hands it the frame
// while a spectate is active (like the death cutscene).
export class ReplayPlayback {
  constructor(camera) {
    this.camera = camera;
    this.active = false;
  }
  load(decoded) {
    this.samples = decoded.samples;
    this.rate = decoded.rate;
    this.t = 0;
    this.done = false;
    this.active = true;
  }
  // 0..1 through the run.
  progress() {
    if (!this.samples || this.samples.length < 2) return 1;
    return clamp01((this.t * this.rate) / (this.samples.length - 1));
  }
  // Where the camera is right now, so the maze can stream around it.
  get pos() {
    return this._pos || { x: this.samples[0].x, y: EYE_HEIGHT, z: this.samples[0].z };
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
  }
}

const _euler = typeof THREE !== "undefined" ? new THREE.Euler() : null;
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
