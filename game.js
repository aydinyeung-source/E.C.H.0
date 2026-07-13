// game.js
// -----------------------------------------------------------------------------
// Bootstraps the Three.js scene and drives the main loop, wiring together the
// endless World, the first-person Player, and the green Sonar. Also owns the
// front-end concerns: seed selection (Minecraft-style), the daily challenge,
// and the persisted look-sensitivity setting.
// -----------------------------------------------------------------------------

import { World, SPAWN, setWorldSeed } from "./world.js";
import { Player, BASE_SENSITIVITY } from "./player.js";
import { SonarSystem } from "./sonar.js";
import { EntitySystem } from "./entities.js";
import { AudioSystem } from "./audio.js";
import { Pickups } from "./pickups.js";
import { Radar } from "./radar.js";
import { Menu } from "./menu.js";
import { submitDistance } from "./supabase.js";

const VERSION = "v2.9.1";

const canvas = document.getElementById("scene");
const startOverlay = document.getElementById("startOverlay");
const startButton = document.getElementById("startButton");
const dailyButton = document.getElementById("dailyButton");
const seedInput = document.getElementById("seedInput");
const sensSlider = document.getElementById("sensSlider");
const sensValue = document.getElementById("sensValue");
const sonarKeySelect = document.getElementById("sonarKey");
const seedTag = document.getElementById("seedTag");
const distanceTag = document.getElementById("distanceTag");
const versionTag = document.getElementById("versionTag");
const versionLabel = document.getElementById("versionLabel");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const gameOverDistance = document.getElementById("gameOverDistance");
const tryAgainButton = document.getElementById("tryAgainButton");
const energyBar = document.getElementById("energyBar");
const energyFill = document.getElementById("energyFill");
const pauseOverlay = document.getElementById("pauseOverlay");
const resumeButton = document.getElementById("resumeButton");
const homeButton = document.getElementById("homeButton");
const jumpscareOverlay = document.getElementById("jumpscare");
const radarCanvas = document.getElementById("radar");
const deviceSelect = document.getElementById("deviceMode");
const mobileControls = document.getElementById("mobileControls");
const mcRun = document.getElementById("mcRun");
const mcPing = document.getElementById("mcPing");
const mcPause = document.getElementById("mcPause");

// --- Three.js core ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.045);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

// --- Subsystems -------------------------------------------------------------
const world = new World(scene);
const player = new Player(camera, canvas, SPAWN);
const sonar = new SonarSystem();
const entities = new EntitySystem(scene);
const audio = new AudioSystem();
const pickups = new Pickups(scene);
const radar = new Radar(radarCanvas);

let dead = false;    // true once an entity has caught the player
let stepTimer = 0;   // countdown to the next footstep sound
let heartTimer = 0;  // countdown to the next heartbeat (tempo scales with proximity)
let playing = false; // actively in a run (pointer-locked on PC, or started on mobile)

// --- Device mode (PC or Mobile) ---------------------------------------------
// On PC we use pointer lock; on mobile we drive everything from touch, so the
// "playing" state can't be derived from the pointer lock alone.
const DEVICE_KEY = "echo-device";
// NB: don't use maxTouchPoints/ontouchstart here — those are true on any laptop
// with a touchscreen, which would wrongly force mobile mode and never request
// pointer lock (so the trackpad/mouse camera would silently do nothing).
// "pointer: coarse" is true only when the PRIMARY input is a finger.
const prefersTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
let deviceMode = localStorage.getItem(DEVICE_KEY) || (prefersTouch ? "mobile" : "pc");
deviceSelect.value = deviceMode;
deviceSelect.addEventListener("change", () => {
  deviceMode = deviceSelect.value;
  localStorage.setItem(DEVICE_KEY, deviceMode);
});

// Requesting pointer lock can be REFUSED — browsers enforce a short cooldown
// after an unlock (e.g. you hit Esc and immediately click Resume), and it can
// fail if the document isn't focused. Newer browsers reject a promise; older
// ones fire pointerlockerror. Either way we stay paused so the player can just
// click again, instead of silently ending up unlocked with a dead camera.
function lockPointer() {
  let req;
  try {
    req = canvas.requestPointerLock();
  } catch {
    showPause();
    return;
  }
  if (req && typeof req.catch === "function") req.catch(() => showPause());
}

document.addEventListener("pointerlockerror", () => {
  if (deviceMode === "pc") showPause();
});

function setPlaying(v) {
  playing = v;
  player.enabled = v;
  if (!v) {
    player.touchFwd = 0;
    player.touchStrafe = 0;
  }
  energyBar.classList.toggle("hidden", !v);
  radarCanvas.classList.toggle("hidden", !v);
  mobileControls.classList.toggle("hidden", !(v && deviceMode === "mobile"));
}
let energy = 100;    // 0..ENERGY_MAX; drained by running/sonar, refilled by meat
let runMode = false; // toggled with Q

const ENERGY_MAX = 100;
const RUN_DRAIN = 12; // energy per second while running and moving
const SONAR_COST = 5; // energy per sonar reveal

// Prime a random world behind the overlay so the scene isn't empty on load.
setWorldSeed(parseSeed(""));
world.update(player.pos);

// --- Seed helpers (Minecraft-style) -----------------------------------------
// Numeric input is used as the literal seed; any other text is hashed to one.
// Blank input yields a fresh random seed each run.
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function parseSeed(text) {
  const s = (text || "").trim();
  if (!s) return Math.floor(Math.random() * 0xffffffff) >>> 0;
  if (/^\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (n <= 0xffffffff) return n >>> 0;
  }
  return hashString(s);
}

// UTC date so the "daily challenge" seed is the same for everyone worldwide.
function todayUTC() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// --- Run control ------------------------------------------------------------
// A "run" tracks the active seed, whether it's the competitive daily challenge,
// and the furthest distance reached from spawn (the leaderboard metric).
const run = { seed: 0, date: todayUTC(), isDaily: false, maxDistance: 0 };

function startRun(rawSeedText, label, isDaily) {
  run.seed = parseSeed(rawSeedText);
  run.isDaily = isDaily;
  run.date = todayUTC();
  run.maxDistance = 0;
  dead = false;
  stepTimer = 0;
  heartTimer = 0;
  energy = ENERGY_MAX;
  runMode = false;
  radar.clear();
  audio.init(); // this is called from a click, so audio is allowed to start
  gameOverOverlay.classList.add("hidden");
  pauseOverlay.classList.add("hidden");
  setWorldSeed(run.seed);
  player.reset(SPAWN);
  world.reset();
  world.update(player.pos); // rebuild chunks around spawn from the new seed
  entities.reset();
  pickups.reset(player.pos);
  mcRun.classList.remove("active");
  seedTag.textContent = (label ? label + " · " : "") + "SEED " + run.seed;

  // PC goes through pointer lock (which starts play on lock); mobile starts now.
  if (deviceMode === "pc") lockPointer();
  else beginPlay();
}

// Enter (or resume) active play. On PC this runs from the pointerlockchange
// handler; on mobile it's called directly.
function beginPlay() {
  startOverlay.classList.add("hidden");
  gameOverOverlay.classList.add("hidden");
  pauseOverlay.classList.add("hidden");
  setPlaying(true);
  sonar.pulse(player.pos); // opening ping (free, doesn't alert entities)
  radar.ping(player.pos, performance.now() / 1000, world, entities.entities);
}

function showPause() {
  setPlaying(false);
  pauseOverlay.classList.remove("hidden");
}

function showGameOver() {
  setPlaying(false);
  submitScoreIfDaily();
  gameOverDistance.textContent = Math.round(run.maxDistance) + "m";
  gameOverOverlay.classList.remove("hidden");
}

// An entity reached the player: jumpscare, then end the run.
function die() {
  if (dead) return;
  dead = true;
  jumpscareOverlay.classList.remove("hidden");
  audio.jumpscare();
  setTimeout(() => {
    jumpscareOverlay.classList.add("hidden");
    if (deviceMode === "pc" && document.pointerLockElement === canvas) {
      document.exitPointerLock(); // the unlock handler shows the game-over screen
    } else {
      showGameOver();
    }
  }, 1200);
}

startButton.addEventListener("click", () => startRun(seedInput.value, null, false));

dailyButton.addEventListener("click", () => {
  const date = todayUTC();
  seedInput.value = date;
  startRun(date, "DAILY " + date, true);
});

// --- Look-sensitivity setting (persisted) -----------------------------------
const SENS_KEY = "echo-sensitivity-mult";

function applySensitivity(mult) {
  player.sensitivity = BASE_SENSITIVITY * mult;
  sensValue.textContent = mult.toFixed(1) + "x";
}

const storedMult = parseFloat(localStorage.getItem(SENS_KEY));
const initialMult = Number.isFinite(storedMult) ? storedMult : 1.0;
sensSlider.value = initialMult;
applySensitivity(initialMult);

sensSlider.addEventListener("input", () => {
  const mult = parseFloat(sensSlider.value);
  applySensitivity(mult);
  localStorage.setItem(SENS_KEY, String(mult));
});

// --- Pointer lock + sonar input ---------------------------------------------
// PC only: Esc releases the pointer, which pauses (or shows game over if dead).
document.addEventListener("pointerlockchange", () => {
  if (deviceMode !== "pc") return;
  if (document.pointerLockElement === canvas) {
    beginPlay();
  } else if (dead) {
    showGameOver();
  } else if (playing) {
    showPause();
  }
});

function submitScoreIfDaily() {
  if (run.isDaily && run.maxDistance > 0) {
    submitDistance({ seed: run.seed, date: run.date, distance: run.maxDistance })
      .then(() => Menu.refreshLeaderboard(run.date));
  }
}

tryAgainButton.addEventListener("click", () => {
  dead = false;
  gameOverOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
});

// Resume the paused run or bail out to the home screen.
resumeButton.addEventListener("click", () => {
  if (deviceMode === "pc") lockPointer(); // lock -> beginPlay()
  else beginPlay();
});
homeButton.addEventListener("click", () => {
  submitScoreIfDaily();
  setPlaying(false);
  pauseOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
});

// --- Mobile on-screen buttons -----------------------------------------------
mcPing.addEventListener("click", () => fireSonar());
mcRun.addEventListener("click", () => {
  runMode = !runMode;
  mcRun.classList.toggle("active", runMode);
});
mcPause.addEventListener("click", () => {
  if (playing) showPause();
});

// --- Mobile touch: left half = movement stick, right half = camera -----------
const JOY_RADIUS = 70;        // px of drag for full-speed movement
const TOUCH_LOOK_SENS = 1.6;  // multiplier on look sensitivity for touch drags
let moveTouchId = null;
let moveStartX = 0;
let moveStartY = 0;
let lookTouchId = null;
let lookLastX = 0;
let lookLastY = 0;

canvas.addEventListener("touchstart", (e) => {
  if (!playing || deviceMode !== "mobile") return;
  for (const t of e.changedTouches) {
    if (t.clientX < window.innerWidth / 2) {
      if (moveTouchId === null) {
        moveTouchId = t.identifier;
        moveStartX = t.clientX;
        moveStartY = t.clientY;
      }
    } else if (lookTouchId === null) {
      lookTouchId = t.identifier;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (!playing || deviceMode !== "mobile") return;
  for (const t of e.changedTouches) {
    if (t.identifier === moveTouchId) {
      const dx = t.clientX - moveStartX;
      const dy = t.clientY - moveStartY;
      player.touchStrafe = Math.max(-1, Math.min(1, dx / JOY_RADIUS));
      player.touchFwd = Math.max(-1, Math.min(1, -dy / JOY_RADIUS)); // drag up = forward
    } else if (t.identifier === lookTouchId) {
      player.look((t.clientX - lookLastX) * TOUCH_LOOK_SENS, (t.clientY - lookLastY) * TOUCH_LOOK_SENS);
      lookLastX = t.clientX;
      lookLastY = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });

function endTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === moveTouchId) {
      moveTouchId = null;
      player.touchFwd = 0;
      player.touchStrafe = 0;
    }
    if (t.identifier === lookTouchId) lookTouchId = null;
  }
}
canvas.addEventListener("touchend", endTouch);
canvas.addEventListener("touchcancel", endTouch);

// --- Sonar keybind (default left click; changeable in Settings) -------------
// Mouse buttons are stored as "mouse0"/"mouse2"; keys as their KeyboardEvent
// .code ("Space", "KeyE", ...). Look (mouse move) is always button-agnostic.
const SONAR_KEY = "echo-sonar-key";
let sonarBinding = localStorage.getItem(SONAR_KEY) || "mouse0";
sonarKeySelect.value = sonarBinding;
sonarKeySelect.addEventListener("change", () => {
  sonarBinding = sonarKeySelect.value;
  localStorage.setItem(SONAR_KEY, sonarBinding);
});

function fireSonar() {
  if (!playing) return;
  sonar.pulse(player.pos);
  radar.ping(player.pos, performance.now() / 1000, world, entities.entities);
  entities.hearSonar(player.pos.x, player.pos.z); // the sound draws entities in
  energy = Math.max(0, energy - SONAR_COST);      // revealing costs energy
}

canvas.addEventListener("mousedown", (e) => {
  if (sonarBinding === "mouse" + e.button) fireSonar();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // never show the menu
// Swallow trackpad two-finger scroll / swipe gestures while playing, so they
// can't scroll the page or trigger browser back-navigation (which drops the lock).
canvas.addEventListener("wheel", (e) => {
  if (playing) e.preventDefault();
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (sonarBinding === e.code) fireSonar();
  if (e.code === "KeyQ") runMode = !runMode; // toggle running
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Distance tracking ------------------------------------------------------
// "Distance explored" = furthest straight-line distance reached from spawn.
function updateDistance() {
  if (!playing) return;
  const dx = player.pos.x - SPAWN.x;
  const dz = player.pos.z - SPAWN.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > run.maxDistance) run.maxDistance = d;
  distanceTag.textContent = Math.round(run.maxDistance) + "m";
}

// --- Main loop --------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // clamp long frames (tab switch)
  last = now;

  // Apply run intent before moving: you can only run with energy to spare.
  player.running = runMode && energy > 0;
  player.update(dt, world);
  world.update(player.pos);
  world.animate(now * 0.001); // flickering lights
  sonar.update(dt);
  pickups.animate(now * 0.001); // throbbing meat
  updateDistance();

  // Entities only hunt while actively playing (and alive).
  if (playing && !dead) {
    // Running drains energy while actually moving.
    if (player.running && player.moving) {
      energy = Math.max(0, energy - RUN_DRAIN * dt);
    }

    if (entities.update(dt, player.pos, run.maxDistance)) die();

    // Eat any decayed meat within reach to refill energy.
    const gained = pickups.update(player.pos);
    if (gained > 0) {
      energy = Math.min(ENERGY_MAX, energy + gained);
      audio.pickup();
    }
    energyFill.style.width = (energy / ENERGY_MAX) * 100 + "%";

    // Footsteps: play faster and louder the closer the nearest entity is.
    const near = entities.nearest;
    if (near < 15) {
      stepTimer -= dt;
      if (stepTimer <= 0) {
        const prox = 1 - near / 15; // 0 (far) .. 1 (right behind you)
        audio.footstep(0.06 + prox * 0.4);
        stepTimer = 0.75 - prox * 0.45; // 0.3s when close .. 0.75s when far
      }
    } else {
      stepTimer = 0.15; // primed to step almost immediately when one nears
    }

    // Proximity heartbeat: kicks in inside 5m and accelerates from a slow heavy
    // thud into a frantic flutter as the entity closes to 1m.
    if (near < 5) {
      const t = Math.max(0, Math.min(1, (5 - near) / 4)); // 0 at 5m .. 1 at 1m
      heartTimer -= dt;
      if (heartTimer <= 0) {
        audio.heartbeat(0.12 + t * 0.4, 0.85 + t * 0.9); // volume + playback rate
        heartTimer = 1.15 - t * 0.85; // tempo: 1.15s at 5m .. 0.30s at 1m
      }
    } else {
      heartTimer = 0; // primed to beat the instant something closes in
    }
  }

  // Radar redraws every frame so blips fade on the same 15s curve as the walls.
  radar.draw(now * 0.001, player.pos, player.yaw);

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// --- Boot -------------------------------------------------------------------
versionTag.textContent = VERSION;
versionLabel.textContent = VERSION;
Menu.init();
Menu.refreshLeaderboard(todayUTC());
requestAnimationFrame(loop);
