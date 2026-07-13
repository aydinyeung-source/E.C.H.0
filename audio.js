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
    this.ambience = null;    // background static + drone + creaks
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
      this.master.gain.value = 2.4; // the game was far too quiet
      // A compressor lets us push the level hard without the harsh digital
      // clipping you'd otherwise get when several sounds overlap.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 8;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
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
    // refDistance 4 = full volume within 4m, then a clear, readable falloff.
    // (It must NOT be tiny: with refDistance=1 the exponential curve buries
    // anything past a few metres at -30dB, which is what made it all silent.)
    panner.refDistance = 4;
    panner.rolloffFactor = 1.1;
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
          // Deliberate, measured pace — a slow approaching step is far more
          // unsettling than a scurry.
          v.stepTimer = 0.95 - prox * 0.42;    // 0.95s far .. 0.53s close
        }
      } else {
        v.stepTimer = 0.2;
      }
    }
  }

  // A clean, dry footfall — routed through the entity's filter+panner.
  // Two layers: a crisp filtered-noise SCUFF (shoe on hard floor) over a tight
  // low BODY. Both decay fast, so it reads as a sharp, deliberate step rather
  // than a boomy thud — which is what makes it unsettling instead of cartoonish.
  _footstepAt(v) {
    const t = this.ctx.currentTime;

    // Scuff: a short noise burst with a cubic decay, band-passed to the click
    // region so it stays articulate.
    const dur = 0.09;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const decay = 1 - i / data.length;
      data[i] = (Math.random() * 2 - 1) * decay * decay * decay;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 1.1;
    const nGain = this.ctx.createGain();
    nGain.gain.value = 0.7;
    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(v.filter); // -> panner -> master
    noise.start(t);
    noise.stop(t + dur);

    // Body: a tight low thump, cut short so it doesn't smear.
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(1.3, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain);
    gain.connect(v.filter);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  // --- Ambience -------------------------------------------------------------
  // A continuous bed of unsettling room tone, started when a run begins:
  //   * dull filtered STATIC (a dead-air hiss, like a room that's too quiet),
  //     with a very slow LFO on its cutoff so it breathes rather than sits still
  //   * a sub-bass DRONE built from two slightly detuned sines, which beat
  //     against each other and never quite resolve
  //   * occasional distant CREAKS at random intervals, so the silence between
  //     them starts to feel like it's waiting for something
  startAmbience() {
    if (!this.ctx || this.ambience) return;
    const ctx = this.ctx;

    // Static: two seconds of noise, looped.
    const dur = 2;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 180;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    const hiss = ctx.createGain();
    hiss.gain.value = 0.055; // sits under everything; felt, not listened to

    // Slow sweep on the cutoff so the static drifts.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07; // ~14s cycle
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 550;
    lfo.connect(lfoDepth);
    lfoDepth.connect(lp.frequency);

    noise.connect(hp);
    hp.connect(lp);
    lp.connect(hiss);
    hiss.connect(this.master);

    // Drone: detuned sines, beating slowly.
    const d1 = ctx.createOscillator();
    d1.type = "sine";
    d1.frequency.value = 52;
    const d2 = ctx.createOscillator();
    d2.type = "sine";
    d2.frequency.value = 52.6; // the offset is what makes it uneasy
    const drone = ctx.createGain();
    drone.gain.value = 0.05;
    d1.connect(drone);
    d2.connect(drone);
    drone.connect(this.master);

    noise.start();
    lfo.start();
    d1.start();
    d2.start();

    this.ambience = { noise, lfo, d1, d2, nodes: [hiss, drone, hp, lp, lfoDepth] };
    this._scheduleCreak();
  }

  // A distant, muffled creak/settle at random intervals (8-22s).
  _scheduleCreak() {
    if (!this.ambience) return;
    const delay = 8000 + Math.random() * 14000;
    this.ambience.creakTimer = setTimeout(() => {
      if (!this.ambience || !this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 500; // distant = no high end
      osc.type = "sawtooth";
      const base = 70 + Math.random() * 90;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.6, t + 0.8);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.10, t + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(lp);
      lp.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 1.0);
      this._scheduleCreak();
    }, delay);
  }

  stopAmbience() {
    if (!this.ambience) return;
    const a = this.ambience;
    clearTimeout(a.creakTimer);
    for (const src of [a.noise, a.lfo, a.d1, a.d2]) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* already stopped */
      }
    }
    for (const n of a.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.ambience = null;
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
