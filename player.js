// player.js
// -----------------------------------------------------------------------------
// First-person controls: pointer-lock mouse look + WASD movement, with wall
// collision resolved against the World. The camera is driven entirely from a
// position vector plus yaw/pitch angles.
// -----------------------------------------------------------------------------

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 3.4;        // units/second — a slow, uneasy walk
const PLAYER_RADIUS = 0.35;    // collision radius on the XZ plane
const PITCH_LIMIT = Math.PI / 2 - 0.05;

// Default look sensitivity (radians of rotation per pixel of mouse movement).
// Higher than the original tuning; the settings slider scales this at runtime.
export const BASE_SENSITIVITY = 0.004;

export class Player {
  constructor(camera, domElement, spawn) {
    this.camera = camera;
    this.dom = domElement;
    this.pos = spawn.clone();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.sensitivity = BASE_SENSITIVITY; // live-adjustable via the settings slider
    this.euler = new THREE.Euler(0, 0, 0, "YXZ"); // yaw then pitch, no roll
    this._bindInput();
    this._apply();
  }

  // Return to the spawn point facing forward — used when (re)starting a run.
  reset(spawn) {
    this.pos.copy(spawn);
    this.yaw = 0;
    this.pitch = 0;
    this.keys.clear();
    this._apply();
  }

  get isLocked() {
    return document.pointerLockElement === this.dom;
  }

  _bindInput() {
    document.addEventListener("mousemove", (e) => {
      if (!this.isLocked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    });
    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    // Drop all held keys if focus is lost, so the player doesn't "stick" moving.
    window.addEventListener("blur", () => this.keys.clear());
  }

  update(dt, world) {
    if (this.isLocked) this._move(dt, world);
    this._apply();
  }

  _move(dt, world) {
    let fwd = 0;
    let strafe = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fwd += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fwd -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) strafe += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) strafe -= 1;

    if (fwd !== 0 || strafe !== 0) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Forward is -Z at yaw 0; right is +X. Combine and normalise so diagonal
      // movement isn't faster than cardinal movement.
      let dx = fwd * -sin + strafe * cos;
      let dz = fwd * -cos + strafe * -sin;
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        const step = (MOVE_SPEED * dt) / len;
        this.pos.x += dx * step;
        this.pos.z += dz * step;
      }
    }

    this.pos.y = EYE_HEIGHT;
    world.collide(this.pos, PLAYER_RADIUS);
  }

  _apply() {
    this.camera.position.copy(this.pos);
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
