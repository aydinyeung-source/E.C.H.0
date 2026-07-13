// sonar.js
// -----------------------------------------------------------------------------
// A click emits a burst of THREE expanding green wavefronts. Each is a growing
// shell; where it passes, surfaces light up and then slowly fade (see reveal.js
// for the glow-in-the-dark model). This module just advances each wave's age and
// writes it into the shared reveal uniforms — it owns no rendering itself.
// -----------------------------------------------------------------------------

import { revealUniforms, ECHO_MAX, GLOW_TIME, WAVE_SPEED } from "./reveal.js";

const WAVES_PER_CLICK = 3; // a click sends 3 ripples...
const WAVE_GAP = 0.12;     // ...staggered this many seconds apart
const REACH = 46;          // how far a front is tracked before we retire the wave
// Keep a wave alive until its front has passed everything nearby AND that glow
// has finished fading, so the afterglow isn't cut off early.
const LIFETIME = GLOW_TIME + REACH / WAVE_SPEED + 0.5;

export class SonarSystem {
  constructor() {
    this.slots = [];
    for (let i = 0; i < ECHO_MAX; i++) {
      this.slots.push({ origin: new THREE.Vector3(), age: 0, active: false });
    }
    this.cursor = 0;
  }

  // Fire three staggered wavefronts from `position`. A negative starting age
  // delays a ripple until its age crosses zero (see reveal.js: tsp uses age).
  pulse(position) {
    for (let k = 0; k < WAVES_PER_CLICK; k++) {
      const slot = this.slots[this.cursor];
      this.cursor = (this.cursor + 1) % this.slots.length;
      slot.origin.copy(position);
      slot.age = -k * WAVE_GAP;
      slot.active = true;
    }
  }

  update(dt) {
    const waves = revealUniforms.uWaves.value;
    const on = revealUniforms.uWaveOn.value;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) {
        on[i] = 0;
        continue;
      }
      s.age += dt;
      if (s.age > LIFETIME) {
        s.active = false;
        on[i] = 0;
        continue;
      }
      waves[i].set(s.origin.x, s.origin.y, s.origin.z, s.age);
      on[i] = 1;
    }
  }
}
