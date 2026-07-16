// cutscene.js
// -----------------------------------------------------------------------------
// THE DEATH CUTSCENE.
//
// You're taken, you hit "Try Again", and before the menu comes back the camera
// lingers on the exact spot where you fell. One of them walks up out of the dark,
// stands squarely over the place you were — blocking it from view, staring dead
// into the lens the whole time — and when it finally steps aside there is a piece
// of meat lying where you had been. You were never anything else to this place.
// Then it turns and comes for the camera too, and that is what sends you home.
//
// It is deliberately UNLIT and self-contained. It builds its own silhouette and
// carcass out of MeshBasicMaterial — which ignore scene lighting, so adding them
// forces no shader recompile — and drives the shared camera itself. The page
// reloads the instant it's over, so nothing here is ever torn down.
//
// `play()` returns a promise that resolves when the cutscene ends (or is tapped
// through). The main loop calls `update(dt)` each frame while `active` is true.

const BODY_COLOR = 0x26262c; // a shade lighter than the world-black, so it reads as a shape
const EYE_COLOR = 0xff2a2a;

export class DeathCutscene {
  constructor(scene, camera, veil) {
    this.scene = scene;
    this.camera = camera;
    this.veil = veil;
    this.active = false;
    this._resolve = null;
    this._t = 0;
    this._group = null;
    this._onSkip = null;
  }

  play(deathPos, hooks = {}) {
    this.hooks = hooks;
    this._t = 0;
    this._scared = false;
    this.active = true;

    const g = new THREE.Group();
    this.scene.add(g);
    this._group = g;

    const center = new THREE.Vector3(deathPos.x, 0, deathPos.z);
    this.center = center;

    // Camera vantage: near eye level, a couple of metres off the spot, looking at
    // it. f is the horizontal direction FROM the camera TO the spot.
    const a = Math.PI * 0.2;
    const dist = 2.6;
    const f = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    this.f = f;
    this.camPos = center.clone().add(f.clone().multiplyScalar(-dist));
    this.camPos.y = 1.5;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(center.x, 1.4, center.z);

    // "Stage right" — perpendicular to the view, for the entity's exit.
    this.right = new THREE.Vector3(f.z, 0, -f.x);

    // --- The entity: the same shape as the ones in the maze. ---
    const ent = new THREE.Group();
    const bodyMat = new THREE.MeshBasicMaterial({ color: BODY_COLOR });
    const eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLOR });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.5, 8), bodyMat);
    body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), bodyMat);
    head.position.y = 1.6;
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat);
    eyeL.position.set(-0.09, 1.62, 0.22);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.09;
    ent.add(body, head, eyeL, eyeR);
    g.add(ent);
    this.ent = ent;

    // It emerges from the dark on the FAR side of the spot and comes forward onto it.
    this.entStart = center.clone().add(f.clone().multiplyScalar(3.6));
    ent.position.copy(this.entStart);
    this._faceCamera(ent);

    // The carcass, built now but hidden until the entity steps off it.
    this.meat = this._buildMeat(center);
    this.meat.visible = false;
    g.add(this.meat);

    if (this.veil) {
      this.veil.classList.remove("hidden");
      this.veil.style.opacity = "1"; // start black, then fade into the scene
    }

    // A tap or a key skips straight to the menu.
    this._onSkip = () => this.end();
    window.addEventListener("pointerdown", this._onSkip, { once: true });
    window.addEventListener("keydown", this._onSkip, { once: true });

    return new Promise((res) => {
      this._resolve = res;
    });
  }

  _buildMeat(center) {
    const m = new THREE.Group();
    m.position.set(center.x, 0, center.z);

    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 22),
      new THREE.MeshBasicMaterial({ color: 0x260607 })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.015;
    m.add(pool);

    const lumpMat = new THREE.MeshBasicMaterial({ color: 0x6f1417 });
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x4a0d10 });
    const lumps = [
      [0, 0.12, 0, 0.26],
      [0.18, 0.1, 0.05, 0.18],
      [-0.14, 0.09, -0.08, 0.16],
    ];
    for (let i = 0; i < lumps.length; i++) {
      const [x, y, z, r] = lumps[i];
      const lump = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), i % 2 ? darkMat : lumpMat);
      lump.position.set(x, y, z);
      lump.scale.y = 0.7;
      m.add(lump);
    }

    const bone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6),
      new THREE.MeshBasicMaterial({ color: 0xcfc6a0 })
    );
    bone.rotation.z = Math.PI / 2.4;
    bone.position.set(0.05, 0.12, 0.1);
    m.add(bone);

    return m;
  }

  _faceCamera(obj) {
    obj.rotation.y = Math.atan2(this.camPos.x - obj.position.x, this.camPos.z - obj.position.z);
  }

  end() {
    if (!this.active) return;
    this.active = false;
    if (this._onSkip) {
      window.removeEventListener("pointerdown", this._onSkip);
      window.removeEventListener("keydown", this._onSkip);
      this._onSkip = null;
    }
    if (this._resolve) this._resolve();
    this._resolve = null;
  }

  update(dt) {
    if (!this.active) return;
    this._t += dt;
    const t = this._t;

    // Timeline, in seconds.
    const A0 = 0.4; // approach begins
    const A1 = 2.6; // ...ends, standing on the spot
    const B1 = 4.4; // stare ends
    const C1 = 6.2; // stepped off, carcass revealed
    const D1 = 7.8; // reached the lens
    const END = 8.2;

    const ent = this.ent;
    let lookY = 1.4;
    let lookAtEntity = false;

    if (t < A1) {
      // Out of the dark, straight onto the spot, staring the whole way.
      const k = clamp((t - A0) / (A1 - A0));
      ent.position.lerpVectors(this.entStart, this.center, ease(k));
      this._faceCamera(ent);
    } else if (t < B1) {
      // Stand squarely over the place you fell. A faint sway; unblinking.
      ent.position.copy(this.center);
      ent.position.y = Math.sin(t * 2) * 0.02;
      this._faceCamera(ent);
      lookY = 1.5;
    } else if (t < C1) {
      // Step off to the side — and there it is, where you were.
      this.meat.visible = true;
      const k = clamp((t - B1) / (C1 - B1));
      const exit = this.center.clone().add(this.right.clone().multiplyScalar(3.2));
      ent.position.lerpVectors(this.center, exit, ease(k));
      ent.position.y = 0;
      this._faceCamera(ent);
      lookY = 1.5 - k * 1.3; // tilt down onto the carcass as it clears
    } else if (t <= D1) {
      // Then it comes for the camera. Straight at the lens, swelling, and the
      // lights go out the instant it arrives.
      this.meat.visible = true;
      const k = clamp((t - C1) / (D1 - C1));
      const from = this.center.clone().add(this.right.clone().multiplyScalar(3.2));
      const to = this.camPos.clone();
      to.y = 0;
      ent.position.lerpVectors(from, to, ease(k));
      ent.position.y = 0;
      this._faceCamera(ent);
      const sc = 1 + k * k * 2.4;
      ent.scale.set(sc, sc, sc);
      lookAtEntity = true;
      // The camera shudders harder as it closes.
      this.camera.position.set(
        this.camPos.x + (Math.random() - 0.5) * k * 0.14,
        this.camPos.y + (Math.random() - 0.5) * k * 0.14,
        this.camPos.z
      );
      if (!this._scared && t > D1 - 0.22) {
        this._scared = true;
        if (this.hooks.scare) this.hooks.scare();
      }
    }

    // Fade in from black at the top; slam back to black as it reaches the lens.
    if (this.veil) {
      let o = 0;
      if (t < 0.6) o = 1 - t / 0.6;
      if (t > D1 - 0.22) o = clamp((t - (D1 - 0.22)) / 0.28);
      this.veil.style.opacity = o.toFixed(3);
    }

    if (lookAtEntity) {
      this.camera.lookAt(ent.position.x, 1.0, ent.position.z);
    } else {
      this.camera.lookAt(this.center.x, lookY, this.center.z);
    }

    if (t >= END) this.end();
  }
}

function clamp(x) {
  return Math.max(0, Math.min(1, x));
}
// Smoothstep: eased 0..1, no overshoot.
function ease(x) {
  return x * x * (3 - 2 * x);
}
