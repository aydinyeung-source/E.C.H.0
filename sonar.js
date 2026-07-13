// sonar.js
// -----------------------------------------------------------------------------
// A click emits a burst of THREE expanding green rings. Each ring's radius grows
// over time (radius = age * speed); where the ring front reaches a surface it
// lights up and then slowly fades (glow-in-the-dark — see reveal.js). This module
// just advances each ring's age and writes origin + age into the shared reveal
// uniforms every frame. No lights, no rendering here.
// -----------------------------------------------------------------------------

import { revealUniforms, ECHO_MAX, GLOW_TIME, WAVE_SPEED } from "./reveal.js";

const WAVES_PER_CLICK = 1; // one ring per click
const WAVE_GAP = 0.12;     // (stagger, only relevant if >1 ring)
const REACH = 46;          // track a ring until its front passes this far
const LIFETIME = GLOW_TIME + REACH / WAVE_SPEED + 0.5; // keep alive until glow fades

export class SonarSystem {
  constructor() {
    this.slots = [];
    for (let i = 0; i < ECHO_MAX; i++) {
      this.slots.push({ origin: new THREE.Vector3(), age: 0, active: false });
    }
    this.cursor = 0;
  }

  // Fire three staggered rings from `position`. Negative starting age delays a
  // ring until its age crosses zero (the reveal ignores tsp < 0).
  pulse(position) {
    for (let k = 0; k < WAVES_PER_CLICK; k++) {
      const slot = this.slots[this.cursor];
      this.cursor = (this.cursor + 1) % this.slots.length;
      slot.origin.copy(position);
      slot.age = -k * WAVE_GAP;
      slot.active = true;
    }
  }

  // Requirement #1: the radius grows with delta time — age += dt here, and the
  // shader derives radius = age * speed. Requirement #2: origin + age are written
  // into the shared uniforms every single frame below.
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
