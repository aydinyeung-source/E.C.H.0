// audio.js
// -----------------------------------------------------------------------------
// Web Audio. No external assets — everything is synthesised.
//
// 3D SPATIAL AUDIO (entities):
//   * The AudioListener is driven from the camera's position + forward/up every
//     frame, so the world turns around your head as you look.
//   * Each entity owns a voice chain: source -> BiquadFilter(lowpass) -> Panner
//     (HRTF + exponential rolloff) -> master. HRTF gives pinpoint placement on
//     headphones; the exponential rolloff makes distance read naturally.
//   * OCCLUSION: if the game's raycast says a wall sits between you and the
//     entity, the lowpass slides down to 400Hz (muffled, "through a wall");
//     otherwise it opens back to 22kHz. Both via setTargetAtTime, so it glides
//     instead of clicking.
//   * Entity footsteps run THROUGH that chain, so they're positioned and muffled.
//   * When a sonar ring sweeps over an entity, we fire a brief, sharp cue placed
//     exactly at its coordinates — the ping "lights it up" audibly. That cue
//     deliberately BYPASSES the occlusion filter: it's a locator, so it stays
//     crisp even through a wall.
//
// Your own heartbeat and the pickup/jumpscare stings are NOT spatialised —
// they're inside your head, so they stay centred.
//
// Browsers block audio until a user gesture, so init() must run from a click.
// -----------------------------------------------------------------------------

const MUFFLED_HZ = 400;    // lowpass cutoff when a wall is in the way
const OPEN_HZ = 22000;     // lowpass cutoff with a clear line of sight
// Asymmetric glide: snap OPEN almost instantly (a thing stepping into your
// sightline should hit you immediately, crisp and horrible), but muffle a little
// more gently so ducking behind a wall doesn't click.
const OPEN_GLIDE = 0.012;
const MUFFLE_GLIDE = 0.07;
const FOOTSTEP_RANGE = 16; // entities closer than this are audible
const EAR_HEIGHT = 0.9;    // entity sound emits from roughly chest height

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.voices = new Map(); // entity object -> { panner, filter, stepTimer }

    // Safety net: browsers can leave (or re-put) the context in a suspended
    // state, which silences everything. Any user gesture resumes it.
    const resume = () => {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _out() {
    return this.master || this.ctx.destination;
  }

  // Drop every entity voice (used when a run restarts).
  resetVoices() {
    for (const v of this.voices.values()) this._disposeVoice(v);
    this.voices.clear();
  }

  _disposeVoice(v) {
    try {
      v.filter.disconnect();
      v.panner.disconnect();
    } catch {
      /* already torn down */
    }
  }

  // --- Listener -------------------------------------------------------------
  // Called every frame with the first-person camera.
  updateListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    const p = camera.position;
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);

    if (l.positionX) {
      // Modern AudioParam interface.
      l.positionX.setTargetAtTime(p.x, t, 0.01);
      l.positionY.setTargetAtTime(p.y, t, 0.01);
      l.positionZ.setTargetAtTime(p.z, t, 0.01);
      l.forwardX.setTargetAtTime(_fwd.x, t, 0.01);
      l.forwardY.setTargetAtTime(_fwd.y, t, 0.01);
      l.forwardZ.setTargetAtTime(_fwd.z, t, 0.01);
      l.upX.setTargetAtTime(_up.x, t, 0.01);
      l.upY.setTargetAtTime(_up.y, t, 0.01);
      l.upZ.setTargetAtTime(_up.z, t, 0.01);
    } else {
      // Deprecated interface (older Safari/Firefox).
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  _makePanner() {
    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "exponential";
    // Exponential gain is (max(d, refDistance) / refDistance) ^ -rolloffFactor.
    // refDistance MUST NOT be tiny: with refDistance=1 and rolloff=1.6, a sound
    // 10m away lands at 10^-1.6 ~= 0.025 (-32dB) — i.e. completely inaudible,
    // which silenced every entity sound. refDistance 5 = full volume out to 5m,
    // then a gentle, natural falloff (half volume at 10m, ~1/3 at 16m).
    panner.refDistance = 5;
    panner.rolloffFactor = 1.0;
    panner.maxDistance = 60;
    return panner;
  }

  _setPannerPos(panner, x, y, z, t) {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, t, 0.02);
      panner.positionY.setTargetAtTime(y, t, 0.02);
      panner.positionZ.setTargetAtTime(z, t, 0.02);
    } else {
      panner.setPosition(x, y, z);
    }
  }

  _voice(entity) {
    let v = this.voices.get(entity);
    if (!v) {
      const panner = this._makePanner();
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = OPEN_HZ;
      filter.connect(panner);
      panner.connect(this._out());
      v = { panner, filter, stepTimer: Math.random() * 0.4 };
      this.voices.set(entity, v);
    }
    return v;
  }

  // --- Per-frame entity audio ----------------------------------------------
  // Positions each entity's panner, applies wall occlusion to its lowpass, and
  // schedules its footsteps (faster as it closes in).
  updateEntities(list, playerPos, world, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // Retire voices for entities that no longer exist.
    const alive = new Set(list);
    for (const [entity, v] of this.voices) {
      if (!alive.has(entity)) {
        this._disposeVoice(v);
        this.voices.delete(entity);
      }
    }

    for (const e of list) {
      const v = this._voice(e);
      this._setPannerPos(v.panner, e.x, EAR_HEIGHT, e.z, t);

      // AUDIO LINE OF SIGHT: raycast from the player's head to the entity. If a
      // wall is in the way, clamp the lowpass down to 400Hz — the high end is
      // gone and its footsteps read as a heavy thud through solid wall. With a
      // clear sightline it snaps back to 22kHz and turns crisp and immediate.
      const blocked = world.segmentBlocked(playerPos.x, playerPos.z, e.x, e.z);
      v.filter.frequency.setTargetAtTime(
        blocked ? MUFFLED_HZ : OPEN_HZ,
        t,
        blocked ? MUFFLE_GLIDE : OPEN_GLIDE
      );

      // Footsteps through the spatial chain. The panner handles distance
      // attenuation; proximity only drives the TEMPO.
      const d = Math.hypot(e.x - playerPos.x, e.z - playerPos.z);
      if (d < FOOTSTEP_RANGE) {
        v.stepTimer -= dt;
        if (v.stepTimer <= 0) {
          this._footstepAt(v);
          const prox = 1 - d / FOOTSTEP_RANGE; // 0 far .. 1 close
          v.stepTimer = 0.8 - prox * 0.45;     // 0.8s far .. 0.35s close
        }
      } else {
        v.stepTimer = 0.2;
      }
    }
  }

  // A dull footstep thud, routed through an entity's filter+panner.
  _footstepAt(v) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain);
    gain.connect(v.filter); // -> panner -> master
    osc.start(t);
    osc.stop(t + 0.22);
  }

  // --- Sonar hit cue --------------------------------------------------------
  // Fired when the expanding ring reaches an entity: a brief, sharp blip placed
  // exactly at its 3D position, so you can hear precisely where it is in the
  // dark. Scheduled with setTimeout so it plays at the entity's LIVE position.
  // Bypasses the occlusion filter on purpose — it's a locator, not ambience.
  pingEntity(entity, delaySeconds) {
    if (!this.ctx) return;
    setTimeout(() => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const panner = this._makePanner();
      this._setPannerPos(panner, entity.x, EAR_HEIGHT, entity.z, t);
      panner.connect(this._out());

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1250, t);
      osc.frequency.exponentialRampToValueAtTime(760, t + 0.16);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.6, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(panner);
      osc.start(t);
      osc.stop(t + 0.25);
      osc.onended = () => {
        try {
          panner.disconnect();
        } catch {
          /* already gone */
        }
      };
    }, Math.max(0, delaySeconds) * 1000);
  }

  // --- Non-spatial (inside your head) --------------------------------------

  // One "lub-dub". `volume` scales loudness; `rate` (>1) tightens and raises the
  // pitch of each thud. The game drives the TEMPO by calling this on a shrinking
  // interval.
  heartbeat(volume, rate = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._thump(t, volume, rate);
    this._thump(t + 0.17 / rate, volume * 0.72, rate);
  }

  _thump(at, volume, rate) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const dur = 0.16 / rate;
    osc.type = "sine";
    osc.frequency.setValueAtTime(62 * rate, at);
    osc.frequency.exponentialRampToValueAtTime(34 * rate, at + dur);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.05);
    osc.connect(gain);
    gain.connect(this._out());
    osc.start(at);
    osc.stop(at + dur + 0.08);
  }

  // A short, bright blip when you pick up or eat meat.
  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain);
    gain.connect(this._out());
    osc.start(t);
    osc.stop(t + 0.32);
  }

  // Loud, harsh stinger for the jumpscare.
  jumpscare() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dur = 1.0;

    const buffer = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.7, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 0.6;
    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(this._out());
    noise.start(t);
    noise.stop(t + dur);

    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + dur);
    const oGain = this.ctx.createGain();
    oGain.gain.setValueAtTime(0.45, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(oGain);
    oGain.connect(this._out());
    osc.start(t);
    osc.stop(t + dur);
  }
}
