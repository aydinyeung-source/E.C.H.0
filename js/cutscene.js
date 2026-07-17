// cutscene.js
// -----------------------------------------------------------------------------
// THE DEATH CUTSCENE.
//
// You're taken, you hit "Try Again", and the security camera holds on the exact
// spot where you fell. A figure is standing there — you — and then it simply
// collapses, melting down into a piece of meat on the floor. That's all you ever
// were to this place. A beat on the carcass, and the feed cuts out.
//
// One continuous shot: no entity, no lunge at the lens, no jumpscare. It is
// deliberately UNLIT and self-contained — figure and carcass are MeshBasicMaterial
// (which ignore scene lighting, so adding them forces no shader recompile) and it
// drives the shared camera itself. The page reloads the instant it's over, so
// nothing here is ever torn down.
//
// `play()` returns a promise that resolves when the cutscene ends (or is tapped
// through). The main loop calls `update(dt)` each frame while `active` is true.

const FIGURE_COLOR = 0x968f96; // pale, so the figure reads clearly in the dark

// Timeline, in seconds.
const FADE_IN = 0.6;
const STAND_END = 1.6; // it stands a moment
const COLLAPSE_END = 3.5; // ...then melts into meat
const FADE_OUT = 4.5; // start of the cut to black
const END = 5.0;

export class DeathCutscene {
  constructor(scene, camera, dom = {}) {
    this.scene = scene;
    this.camera = camera;
    this.veil = dom.veil || null;
    this.cctv = dom.cctv || null;         // the security-feed overlay
    this.camLabel = dom.camLabel || null; // "CAM 04"
    this.timeLabel = dom.timeLabel || null;
    this.feed = dom.feed || null;         // the scene canvas, for the desaturate filter
    this.crosshair = dom.crosshair || null;
    this.active = false;
    this._resolve = null;
    this._t = 0;
    this._group = null;
    this._onSkip = null;
    this._prevFov = null;
  }

  play(deathPos) {
    this._t = 0;
    this.active = true;

    const g = new THREE.Group();
    this.scene.add(g);
    this._group = g;

    const center = new THREE.Vector3(deathPos.x, 0, deathPos.z);
    this.center = center;

    // Camera vantage: mounted HIGH in a corner, angled down at the spot, on a wide
    // security-camera lens.
    const a = Math.PI * 0.2;
    const dist = 3.0;
    const f = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    this.camPos = center.clone().add(f.clone().multiplyScalar(-dist));
    this.camPos.y = 2.35;
    this._prevFov = this.camera.fov;
    this.camera.fov = 90;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(center.x, 1.0, center.z);

    // Dress the feed: show the CCTV overlay, desaturate the scene, drop the reticle
    // (no white dot on a security monitor), name the camera.
    if (this.cctv) this.cctv.classList.remove("hidden");
    if (this.feed) this.feed.classList.add("cctv-feed");
    if (this.crosshair) this.crosshair.classList.add("hidden");
    if (this.camLabel) this.camLabel.textContent = "CAM 0" + (1 + Math.floor(Math.random() * 8));

    // The figure — you — standing on the spot, facing the camera.
    this.figure = this._buildFigure(center);
    this.figure.rotation.y = Math.atan2(this.camPos.x - center.x, this.camPos.z - center.z);
    g.add(this.figure);

    // The carcass it becomes, built now but grown in from nothing during the melt.
    this.meat = this._buildMeat(center);
    this.meat.scale.setScalar(0.0001);
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

  _buildFigure(center) {
    const g = new THREE.Group();
    g.position.set(center.x, 0, center.z);
    const mat = new THREE.MeshBasicMaterial({ color: FIGURE_COLOR });

    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.6, 8), mat);
    legL.position.set(-0.1, 0.3, 0);
    const legR = legL.clone();
    legR.position.x = 0.1;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.7, 10), mat);
    torso.position.y = 0.92;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), mat);
    head.position.y = 1.42;
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.6, 8), mat);
    armL.position.set(-0.26, 0.95, 0);
    armL.rotation.z = 0.18;
    const armR = armL.clone();
    armR.position.x = 0.26;
    armR.rotation.z = -0.18;

    g.add(legL, legR, torso, head, armL, armR);
    return g;
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

  // Two-digit zero-padded.
  _stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  }

  end() {
    if (!this.active) return;
    this.active = false;
    if (this._onSkip) {
      window.removeEventListener("pointerdown", this._onSkip);
      window.removeEventListener("keydown", this._onSkip);
      this._onSkip = null;
    }
    // Defensive restore (the page reloads right after, but never leave the shared
    // camera on a wide lens or the feed filtered if that reload is ever delayed).
    if (this._prevFov != null) {
      this.camera.fov = this._prevFov;
      this.camera.updateProjectionMatrix();
    }
    if (this.feed) this.feed.classList.remove("cctv-feed");
    if (this._resolve) this._resolve();
    this._resolve = null;
  }

  update(dt) {
    if (!this.active) return;
    this._t += dt;
    const t = this._t;

    if (this.timeLabel) this.timeLabel.textContent = this._stamp();

    let lookY = 1.0;

    if (t < STAND_END) {
      // Standing, a faint sway.
      this.figure.position.y = Math.sin(t * 2) * 0.01;
    } else if (t < COLLAPSE_END) {
      // The melt: the figure flattens and spreads down into the floor as the
      // carcass swells up in its place.
      const k = ease(clamp((t - STAND_END) / (COLLAPSE_END - STAND_END)));
      this.figure.scale.set(1 + k * 0.2, 1 - k * 0.94, 1 + k * 0.2);
      this.figure.rotation.z = Math.sin(k * Math.PI) * 0.12; // a slump as it goes
      this.meat.scale.setScalar(Math.max(0.0001, k));
      lookY = 1.0 - k * 0.85; // tilt down onto the carcass
    } else {
      // Just the meat, lying where you were.
      this.figure.visible = false;
      this.meat.scale.setScalar(1);
      lookY = 0.15;
    }

    // Fade in from black at the top; cut back to black at the end.
    if (this.veil) {
      let o = 0;
      if (t < FADE_IN) o = 1 - t / FADE_IN;
      if (t > FADE_OUT) o = clamp((t - FADE_OUT) / (END - FADE_OUT));
      this.veil.style.opacity = o.toFixed(3);
    }

    this.camera.lookAt(this.center.x, lookY, this.center.z);

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
