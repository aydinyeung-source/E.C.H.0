// sonar.js
// -----------------------------------------------------------------------------
// The sonar is the ONLY thing that illuminates the yellow world. Each click
// emits an expanding green pulse: a point light placed at the player whose reach
// (`distance`) grows outward while its `intensity` fades. As the wavefront sweeps
// past a surface it flares green, then sinks back into darkness — a light-based
// echolocation effect.
//
// A small pool of lights lets several pulses overlap without ever adding an
// unbounded number of lights to the scene (which would tank performance, since
// every light is evaluated per lit fragment).
// -----------------------------------------------------------------------------

const POOL_SIZE = 5;       // max simultaneous pulses
const COLOR = 0x39ff14;    // neon green
const SPEED = 24;          // wavefront expansion speed (units/second)
const MAX_RANGE = 44;      // how far a pulse reaches before dying
const PEAK_INTENSITY = 7;  // brightness at the pulse's origin
const DECAY = 1.3;         // point-light physical falloff

export class SonarSystem {
  constructor(scene) {
    this.pulses = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      // distance starts tiny (>0 so it's a ranged, not infinite, light).
      const light = new THREE.PointLight(COLOR, 0, 0.001, DECAY);
      light.visible = false;
      scene.add(light);
      this.pulses.push({ light, age: 0, active: false });
    }
    this.cursor = 0;
    this.life = MAX_RANGE / SPEED; // seconds for the wavefront to reach MAX_RANGE
  }

  // Fire a new pulse from `position`, reusing the oldest slot in the pool.
  pulse(position) {
    const p = this.pulses[this.cursor];
    this.cursor = (this.cursor + 1) % this.pulses.length;
    p.light.position.copy(position);
    p.age = 0;
    p.active = true;
    p.light.visible = true;
  }

  update(dt) {
    for (const p of this.pulses) {
      if (!p.active) continue;
      p.age += dt;
      const t = p.age / this.life; // 0 -> 1 across the pulse's life
      if (t >= 1) {
        p.active = false;
        p.light.visible = false;
        p.light.intensity = 0;
        continue;
      }
      // Reach grows linearly; brightness eases out quadratically so surfaces
      // fade smoothly back to black once the wave has passed them.
      p.light.distance = t * MAX_RANGE;
      p.light.intensity = PEAK_INTENSITY * (1 - t) * (1 - t);
    }
  }
}
