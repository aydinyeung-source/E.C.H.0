// player.js
// -----------------------------------------------------------------------------
// First-person controls: pointer-lock mouse look + WASD movement, with wall
// collision resolved against the World. The camera is driven entirely from a
// position vector plus yaw/pitch angles.
// -----------------------------------------------------------------------------

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 5.1;        // units/second — brisk walk (1.5x the old pace)
// Exported so the entities can guarantee their chase speed stays below it —
// a hunt you literally cannot outrun isn't a chase, it's a cutscene.
export const RUN_SPEED = 7.6;  // while running mode is on and energy remains
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

// VAULTING A WINDOW.
// A smashed window is a hole in a wall with a waist-high sill, not a doorway —
// its sill is solid to you exactly like any other wall. The only way through is
// to get your body over it, and pushing into one starts that automatically.
//
// There is no jump button, and there should not be: a vault is not a choice you
// make, it is what happens when a person running for their life meets a hole in a
// wall. It also means the animation can be COMMITTED — once it starts you cannot
// steer, stop, or back out, which is what gives it weight and makes it a real
// decision about where you'll end up.
const VAULT_SPEED = 4.3;   // slower than a sprint: this costs you a moment
const VAULT_LIFT = 0.55;   // how high the camera arcs over the sill
const VAULT_CLEAR = 0.6;   // how far past the wall you land
const VAULT_REACH = 0.5;   // how close you must be for the sill to grab you

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
    this.lookLocked = false; // true while using a terminal — you can't look around
    this.boost = 1;       // speed multiplier (a crucifix grants one briefly)
    this.touchFwd = 0;    // analog move input from the mobile joystick (-1..1)
    this.touchStrafe = 0;
    this.bobPhase = 0;    // stride phase for the head bob
    this.bobAmount = 0;   // 0..1, eased so the bob starts/stops smoothly
    this.vault = null;    // {dirX,dirZ,left,total} while going over a window sill
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
    this.lookLocked = false;
    this.boost = 1;
    this.touchFwd = 0;
    this.touchStrafe = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.vault = null; // never resume a run mid-hop through a wall
    this._apply();
  }

  get isLocked() {
    return document.pointerLockElement === this.dom;
  }

  // Turn the camera. Used by pointer-lock mouse movement (PC) and by touch drags
  // on the right half of the screen (mobile).
  look(dx, dy) {
    if (this.lookLocked) return; // camera is bolted to a terminal screen
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  _bindInput() {
    // pointermove (not mousemove) captures trackpad hardware packets more
    // smoothly. Deltas are taken raw from movementX/Y with no deadzone or
    // minimum threshold, so slow, subtle trackpad drags still register.
    document.addEventListener("pointermove", (e) => {
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

  // Driven from outside (the safe-room vent): commit to a crawl in a given
  // direction, right now. Same machinery as a window vault, ducked instead of
  // hopped, and equally impossible to abort once it starts.
  startCrawl(dirX, dirZ, dist) {
    this.vault = {
      dirX, dirZ,
      left: dist,
      total: dist,
      lift: -VAULT_LIFT * 1.6,
      speed: VAULT_SPEED * 0.55,
    };
  }

  // Already committed to a vault: carry it through. No input is read at all here.
  _advanceVault(dt, world) {
    const v = this.vault;
    const step = Math.min((v.speed || VAULT_SPEED) * dt, v.left);
    this.pos.x += v.dirX * step;
    this.pos.z += v.dirZ * step;
    v.left -= step;

    this.pos.y = EYE_HEIGHT;
    // vaulting: true is the ONLY thing that lets the sill be passed.
    world.collide(this.pos, PLAYER_RADIUS, { player: true, vaulting: true });
    if (v.left <= 0.001) this.vault = null;
  }

  // Am I about to walk into a window? If so, go over it instead.
  // The test is against the MOVEMENT direction, not where the camera is pointing —
  // otherwise merely glancing at a window while strafing past it would launch you
  // through it.
  _tryVault(world, ux, uz) {
    const w = world.windowNear(this.pos.x, this.pos.z, PLAYER_RADIUS + VAULT_REACH);
    if (!w) return false;

    const horiz = w.maxX - w.minX >= w.maxZ - w.minZ;
    const cx = (w.minX + w.maxX) / 2;
    const cz = (w.minZ + w.maxZ) / 2;

    // The crossing direction is straight through the wall, from whichever side
    // you're standing on.
    const dirX = horiz ? 0 : this.pos.x < cx ? 1 : -1;
    const dirZ = horiz ? (this.pos.z < cz ? 1 : -1) : 0;
    if (ux * dirX + uz * dirZ < 0.4) return false; // not actually heading into it

    const gap = horiz ? Math.abs(cz - this.pos.z) : Math.abs(cx - this.pos.x);
    const dist = gap + PLAYER_RADIUS + VAULT_CLEAR;
    // A window is vaulted OVER — the camera arcs up and back down. A vent is
    // crawled INTO, so the same machinery runs with the arc inverted: you drop to
    // the floor, scrape through, and come up the other side. Same commitment, same
    // "you cannot stop halfway", opposite shape.
    this.vault = {
      dirX, dirZ, left: dist, total: dist,
      lift: w.crawl ? -VAULT_LIFT * 1.6 : VAULT_LIFT,
      speed: w.crawl ? VAULT_SPEED * 0.55 : VAULT_SPEED, // a crawl is slow and horrible
    };
    return true;
  }

  _move(dt, world) {
    if (this.vault) {
      this._advanceVault(dt, world);
      return;
    }

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
      const speed = (this.running ? RUN_SPEED : MOVE_SPEED) * this.boost;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Forward is -Z at yaw 0; right is +X. Normalise the direction, then scale
      // by magnitude so diagonals aren't faster and the stick stays analog.
      const dx = fwd * -sin + strafe * cos;
      const dz = fwd * -cos + strafe * -sin;
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        // Walking into a window takes over: the vault starts here and this frame's
        // ordinary movement is abandoned.
        if (this._tryVault(world, dx / len, dz / len)) {
          this._advanceVault(dt, world);
          return;
        }
        const step = (speed * dt * mag) / len;
        this.pos.x += dx * step;
        this.pos.z += dz * step;
      }
    }

    this.pos.y = EYE_HEIGHT;
    world.collide(this.pos, PLAYER_RADIUS, { player: true, vaulting: false });
  }

  _apply() {
    // Head bob: Y at twice the stride rate (each footfall), X once per stride
    // (the side-to-side weight shift). Amplitude scales with walk/run and eases
    // to zero when standing still.
    const ampY = (this.running ? RUN_BOB_Y : WALK_BOB_Y) * this.bobAmount;
    const ampX = (this.running ? RUN_BOB_X : WALK_BOB_X) * this.bobAmount;
    let offY = Math.sin(this.bobPhase * 2) * ampY;
    const offX = Math.sin(this.bobPhase) * ampX;

    // Mid-vault the bob is replaced by a single clean arc: up over the sill and
    // back down the far side.
    if (this.vault) {
      const p = 1 - this.vault.left / this.vault.total; // 0 -> 1 across the hole
      const lift = this.vault.lift === undefined ? VAULT_LIFT : this.vault.lift;
      offY = Math.sin(p * Math.PI) * lift; // negative lift = ducking through a vent
    }

    // Sway along the camera's right vector so it stays relative to where you face.
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.copy(this.pos).addScaledVector(_right, offX);
    this.camera.position.y += offY;

    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
