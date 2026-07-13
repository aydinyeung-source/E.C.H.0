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
}
