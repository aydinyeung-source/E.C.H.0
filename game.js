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
import { Menu } from "./menu.js";
import { submitDistance } from "./supabase.js";

const VERSION = "v2.6.6";

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

let dead = false; // true once an entity has caught the player
let stepTimer = 0; // countdown to the next footstep sound

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
  audio.init(); // this is called from a click, so audio is allowed to start
  gameOverOverlay.classList.add("hidden");
  setWorldSeed(run.seed);
  player.reset(SPAWN);
  world.reset();
  world.update(player.pos); // rebuild chunks around spawn from the new seed
  entities.reset();
  seedTag.textContent = (label ? label + " · " : "") + "SEED " + run.seed;
  canvas.requestPointerLock();
}

// An entity reached the player: end the run. Releasing the pointer lock drives
// the game-over overlay (see the pointerlockchange handler below).
function die() {
  if (dead) return;
  dead = true;
  document.exitPointerLock();
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
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) {
    startOverlay.classList.add("hidden");
    gameOverOverlay.classList.add("hidden");
    sonar.pulse(player.pos); // an opening ping to get your bearings
    return;
  }
  // Unlocked (paused or died): submit the daily distance and refresh the board.
  if (run.isDaily && run.maxDistance > 0) {
    submitDistance({ seed: run.seed, date: run.date, distance: run.maxDistance })
      .then(() => Menu.refreshLeaderboard(run.date));
  }
  if (dead) {
    gameOverDistance.textContent = Math.round(run.maxDistance) + "m";
    gameOverOverlay.classList.remove("hidden");
  } else {
    startOverlay.classList.remove("hidden");
  }
});

tryAgainButton.addEventListener("click", () => {
  dead = false;
  gameOverOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
});

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
  if (document.pointerLockElement === canvas) sonar.pulse(player.pos);
}

canvas.addEventListener("mousedown", (e) => {
  if (sonarBinding === "mouse" + e.button) fireSonar();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // never show the menu
window.addEventListener("keydown", (e) => {
  if (!e.repeat && sonarBinding === e.code) fireSonar();
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Distance tracking ------------------------------------------------------
// "Distance explored" = furthest straight-line distance reached from spawn.
function updateDistance() {
  if (document.pointerLockElement !== canvas) return;
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

  player.update(dt, world);
  world.update(player.pos);
  world.animate(now * 0.001); // flickering lights
  sonar.update(dt);
  updateDistance();

  // Entities only hunt while actively playing (locked and alive).
  if (document.pointerLockElement === canvas && !dead) {
    if (entities.update(dt, player.pos, run.maxDistance)) die();

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
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// --- Boot -------------------------------------------------------------------
versionTag.textContent = VERSION;
versionLabel.textContent = VERSION;
Menu.init();
Menu.refreshLeaderboard(todayUTC());
requestAnimationFrame(loop);
