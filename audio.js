// audio.js
// -----------------------------------------------------------------------------
// Minimal Web Audio helper. No external assets — sounds are synthesised. Right
// now that's a low, dull footstep thud used to warn the player that an entity is
// getting close (the game scales its volume/rate by proximity).
//
// Browsers block audio until a user gesture, so init() must be called from a
// click (we call it when a run starts) to create/resume the AudioContext.
// -----------------------------------------------------------------------------

export class AudioSystem {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  // A single soft footstep thud. `volume` ~0..0.5.
  footstep(volume) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // Low body: a quick downward pitch sweep (the "thud").
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  // A short, bright blip when you eat meat.
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
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  // Loud, harsh stinger for the jumpscare: a burst of band-passed noise plus a
  // screaming descending saw tone.
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
    nGain.connect(this.ctx.destination);
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
    oGain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
}
