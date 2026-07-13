// player.js
// -----------------------------------------------------------------------------
// First-person controls: pointer-lock mouse look + WASD movement, with wall
// collision resolved against the World. The camera is driven entirely from a
// position vector plus yaw/pitch angles.
// -----------------------------------------------------------------------------

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 5.1;        // units/second — brisk walk (1.5x the old pace)
const RUN_SPEED = 7.6;         // while running mode is on and energy remains
const PLAYER_RADIUS = 0.35;    // collision radius on the XZ plane
const PITCH_LIMIT = Math.PI / 2 - 0.05;

// Head bob: strides per second, and how far the camera moves. Y bobs twice per
// stride, X sways once per stride. Kept small to avoid motion sickness.
const WALK_STRIDE = 1.7;
const RUN_STRIDE = 2.6;
const WALK_BOB_Y = 0.045;
const WALK_BOB_X = 0.028;
const RUN_BOB_Y = 0.075;
const RUN_BOB_X = 0.045;

const _right = new THREE.Vector3();

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
    this.running = false; // set by the game (q + energy); uses RUN_SPEED when true
    this.moving = false;  // did the player actually move this frame (for energy drain)
    this.enabled = false; // the game drives this: true only while actually playing
    this.touchFwd = 0;    // analog move input from the mobile joystick (-1..1)
    this.touchStrafe = 0;
    this.bobPhase = 0;    // stride phase for the head bob
    this.bobAmount = 0;   // 0..1, eased so the bob starts/stops smoothly
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
    this.running = false;
    this.moving = false;
    this.touchFwd = 0;
    this.touchStrafe = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this._apply();
  }

  get isLocked() {
    return document.pointerLockElement === this.dom;
  }

  // Turn the camera. Used by pointer-lock mouse movement (PC) and by touch drags
  // on the right half of the screen (mobile).
  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  _bindInput() {
    document.addEventListener("mousemove", (e) => {
      if (!this.isLocked) return;
      this.look(e.movementX, e.movementY);
    });
    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    // Drop all held keys if focus is lost, so the player doesn't "stick" moving.
    window.addEventListener("blur", () => this.keys.clear());
  }

  update(dt, world) {
    this.moving = false;
    if (this.enabled) this._move(dt, world);
    this._updateBob(dt);
    this._apply();
  }

  // Advance the stride phase and ease the bob in/out so it's zero when standing
  // still, a gentle roll when walking, and tighter/faster when sprinting.
  _updateBob(dt) {
    const target = this.moving ? 1 : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, dt * 8); // smooth ramp
    if (this.moving) {
      const stride = this.running ? RUN_STRIDE : WALK_STRIDE; // strides per second
      this.bobPhase += dt * stride * Math.PI * 2;
    }
  }

  _move(dt, world) {
    // Keys (PC) and the touch joystick (mobile) feed the same two axes.
    let fwd = this.touchFwd;
    let strafe = this.touchStrafe;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fwd += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fwd -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) strafe += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) strafe -= 1;

    // Magnitude gives the joystick analog speed; keys naturally reach 1.
    const mag = Math.min(1, Math.hypot(fwd, strafe));
    if (mag > 0.05) {
      this.moving = true;
      const speed = this.running ? RUN_SPEED : MOVE_SPEED;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Forward is -Z at yaw 0; right is +X. Normalise the direction, then scale
      // by magnitude so diagonals aren't faster and the stick stays analog.
      const dx = fwd * -sin + strafe * cos;
      const dz = fwd * -cos + strafe * -sin;
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        const step = (speed * dt * mag) / len;
        this.pos.x += dx * step;
        this.pos.z += dz * step;
      }
    }

    this.pos.y = EYE_HEIGHT;
    world.collide(this.pos, PLAYER_RADIUS);
  }

  _apply() {
    // Head bob: Y at twice the stride rate (each footfall), X once per stride
    // (the side-to-side weight shift). Amplitude scales with walk/run and eases
    // to zero when standing still.
    const ampY = (this.running ? RUN_BOB_Y : WALK_BOB_Y) * this.bobAmount;
    const ampX = (this.running ? RUN_BOB_X : WALK_BOB_X) * this.bobAmount;
    const offY = Math.sin(this.bobPhase * 2) * ampY;
    const offX = Math.sin(this.bobPhase) * ampX;

    // Sway along the camera's right vector so it stays relative to where you face.
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.copy(this.pos).addScaledVector(_right, offX);
    this.camera.position.y += offY;

    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
