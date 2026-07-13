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
import { Pickups, MEAT_ENERGY } from "./pickups.js";
import { Radar } from "./radar.js";
import { Menu } from "./menu.js";
import { submitDistance } from "./supabase.js";

const VERSION = "v2.19.1";

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
const mcEat = document.getElementById("mcEat");
const mcPause = document.getElementById("mcPause");
const hotbarEl = document.getElementById("hotbar");
const wardFlash = document.getElementById("wardFlash");
const torchBar = document.getElementById("torchBar");
const torchFill = document.getElementById("torchFill");
const settingsToggle = document.getElementById("settingsToggle");
const settingsBody = document.getElementById("settingsBody");

// Settings is a tab: the header button opens/closes the panel body.
settingsToggle.addEventListener("click", () => {
  const nowHidden = settingsBody.classList.toggle("hidden");
  settingsToggle.setAttribute("aria-expanded", String(!nowHidden));
});

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
  // Room tone runs only while you're actually in there.
  if (v) audio.startAmbience();
  else audio.stopAmbience();
  if (!v) {
    player.touchFwd = 0;
    player.touchStrafe = 0;
  }
  if (!v) torchOn = false; // don't leave the beam burning on a menu
  energyBar.classList.toggle("hidden", !v);
  hotbarEl.classList.toggle("hidden", !v);
  torchBar.classList.toggle("hidden", !v);
  radarCanvas.classList.toggle("hidden", !v);
  mobileControls.classList.toggle("hidden", !(v && deviceMode === "mobile"));
}
let runMode = false; // toggled with Q

// A full bar is now ~21s of continuous sprinting (was ~8s, which drained far too
// fast to actually outrun anything).
const ENERGY_MAX = 150;
const RUN_DRAIN = 7;   // energy per second while running and moving
const WALK_REGEN = 4;  // energy per second regained while walking (not running)
const SONAR_COST = 4;  // energy per sonar reveal

// Crucifix: your only defence. Brandishing it breaks everything nearby off you.
const WARD_RADIUS = 14; // metres
const WARD_TIME = 7;    // seconds they flee for

// Torch: shows you a slice of what's ahead — but shine it at something and you
// ENRAGE it. Runs on batteries, which are their own pickup.
const TORCH_MAX = 100;
const TORCH_DRAIN = 5;      // battery per second while lit
const BATTERY_CHARGE = 45;  // battery restored per cell
const TORCH_RANGE = 24;     // how far the beam reaches
const TORCH_ANGLE = 0.38;   // half-angle of the beam (radians, ~22deg)
const ENRAGE_TIME = 10;     // seconds an entity stays enraged after being lit
let torchOn = false;
let torchBattery = 0;

const torchLight = new THREE.SpotLight(0xfff0d0, 3.4, TORCH_RANGE + 4, TORCH_ANGLE, 0.5, 1.1);
torchLight.visible = false;
scene.add(torchLight);
scene.add(torchLight.target);
const _fwd = new THREE.Vector3();

function hasItem(type) {
  return hotbar.some((s) => s.type === type && s.count > 0);
}
let energy = ENERGY_MAX; // drained by running/sonar, refilled by eating

// --- Hotbar inventory (Minecraft-style) -------------------------------------
// Nine slots, each stacking one item type up to STACK_MAX. Pick a slot with the
// number keys or the scroll wheel (or by tapping it on mobile); F eats whatever
// is in the selected slot.
const HOTBAR_SLOTS = 9;
const STACK_MAX = 64;
let hotbar = Array.from({ length: HOTBAR_SLOTS }, () => ({ type: null, count: 0 }));
let selectedSlot = 0;

function buildHotbar() {
  hotbarEl.innerHTML = "";
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const slot = document.createElement("div");
    slot.className = "slot";
    const num = document.createElement("span");
    num.className = "slot-num";
    num.textContent = i + 1;
    const icon = document.createElement("div");
    icon.className = "slot-icon";
    const count = document.createElement("span");
    count.className = "slot-count";
    slot.append(num, icon, count);
    // pointerdown, not click — see onPress(): a tap while another finger is down
    // (moving) never generates a click on mobile.
    slot.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectSlot(i);
    });
    hotbarEl.appendChild(slot);
  }
  renderHotbar();
}

function renderHotbar() {
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const el = hotbarEl.children[i];
    if (!el) continue;
    const item = hotbar[i];
    const filled = item.type !== null && item.count > 0;
    el.classList.toggle("selected", i === selectedSlot);
    const icon = el.querySelector(".slot-icon");
    icon.classList.toggle("meat", filled && item.type === "meat");
    icon.classList.toggle("crucifix", filled && item.type === "crucifix");
    icon.classList.toggle("torch", filled && item.type === "torch");
    icon.classList.toggle("battery", filled && item.type === "battery");
    el.querySelector(".slot-count").textContent = filled && item.count > 1 ? item.count : "";
  }
}

function selectSlot(i) {
  selectedSlot = ((i % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  renderHotbar();
}

function resetHotbar() {
  hotbar = Array.from({ length: HOTBAR_SLOTS }, () => ({ type: null, count: 0 }));
  selectedSlot = 0;
  renderHotbar();
}

// Room left for a given item type (so a full pack leaves things on the ground).
function capacityFor(type) {
  let cap = 0;
  for (const s of hotbar) {
    if (s.type === type) cap += STACK_MAX - s.count;
    else if (s.type === null || s.count === 0) cap += STACK_MAX;
  }
  return cap;
}

// Top up existing stacks first, then spill into empty slots.
function addItem(type, n) {
  let left = n;
  for (const s of hotbar) {
    if (left <= 0) break;
    if (s.type === type && s.count < STACK_MAX) {
      const take = Math.min(left, STACK_MAX - s.count);
      s.count += take;
      left -= take;
    }
  }
  for (const s of hotbar) {
    if (left <= 0) break;
    if (s.type === null || s.count === 0) {
      s.type = type;
      const take = Math.min(left, STACK_MAX);
      s.count = take;
      left -= take;
    }
  }
  renderHotbar();
}

function consumeSelected() {
  const s = hotbar[selectedSlot];
  s.count--;
  if (s.count === 0) s.type = null;
  renderHotbar();
}

// F uses whatever is in the SELECTED slot — eat meat, or brandish a crucifix.
function useSelected() {
  if (!playing) return;
  const s = hotbar[selectedSlot];
  if (!s || s.count <= 0) return;

  if (s.type === "meat") {
    if (energy >= ENERGY_MAX) return; // refuse, so food isn't wasted
    consumeSelected();
    energy = Math.min(ENERGY_MAX, energy + MEAT_ENERGY);
    audio.pickup();
  } else if (s.type === "torch") {
    // Not consumed — it's a tool. Toggles, and only lights if it has charge.
    if (!torchOn && torchBattery <= 0) return;
    torchOn = !torchOn;
    audio.pickup();
  } else if (s.type === "battery") {
    if (torchBattery >= TORCH_MAX) return; // don't waste a cell
    consumeSelected();
    torchBattery = Math.min(TORCH_MAX, torchBattery + BATTERY_CHARGE);
    audio.pickup();
  } else if (s.type === "crucifix") {
    consumeSelected();
    entities.repel(player.pos, WARD_RADIUS, WARD_TIME);
    audio.ward();
    wardFlash.classList.remove("hidden");
    void wardFlash.offsetWidth; // restart the CSS animation
    wardFlash.classList.add("flash");
    setTimeout(() => {
      wardFlash.classList.remove("flash");
      wardFlash.classList.add("hidden");
    }, 600);
  }
}

function updateRunButton() {
  mcRun.textContent = runMode ? "STOP RUNNING" : "RUN";
  mcRun.classList.toggle("active", runMode);
}

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
  heartTimer = 0;
  energy = ENERGY_MAX;
  runMode = false;
  resetHotbar();
  torchOn = false;
  torchBattery = 0;
  updateRunButton();
  radar.clear();
  audio.init(); // this is called from a click, so audio is allowed to start
  gameOverOverlay.classList.add("hidden");
  pauseOverlay.classList.add("hidden");
  setWorldSeed(run.seed);
  player.reset(SPAWN);
  world.reset();
  world.update(player.pos); // rebuild chunks around spawn from the new seed
  entities.reset();
  audio.resetVoices(); // drop spatial voices from the previous run
  pickups.reset(player.pos);
  seedTag.textContent = (label ? label + " · " : "") + "SEED " + run.seed;

  // PC goes through pointer lock (which starts play on lock); mobile starts now.
  if (deviceMode === "pc") lockPointer();
  else beginPlay();
}

// Enter (or resume) active play. On PC this runs from the pointerlockchange
// handler; on mobile it's called directly.
function beginPlay() {
  audio.init(); // idempotent; also resumes the context if it got suspended
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
// IMPORTANT: these use pointerdown, NOT click. Mobile browsers only synthesize a
// click for a SINGLE-finger tap — if another finger is already down (the movement
// joystick), a tap on a button is part of a multi-touch gesture and no click is
// ever fired. That made every button dead unless you stopped moving first.
// pointerdown fires per-pointer regardless of how many fingers are on the glass.
function onPress(el, fn) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // don't also fire the synthesized mouse/click
    e.stopPropagation();
    fn();
  });
}

onPress(mcPing, () => fireSonar());
onPress(mcEat, () => useSelected());
onPress(mcRun, () => {
  runMode = !runMode;
  updateRunButton();
});
onPress(mcPause, () => {
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
// F is now the "eat" key, so migrate anyone who had bound sonar to it.
if (sonarBinding === "KeyF") {
  sonarBinding = "mouse0";
  localStorage.setItem(SONAR_KEY, sonarBinding);
}
sonarKeySelect.value = sonarBinding;
sonarKeySelect.addEventListener("change", () => {
  sonarBinding = sonarKeySelect.value;
  localStorage.setItem(SONAR_KEY, sonarBinding);
});

function fireSonar() {
  if (!playing) return;
  sonar.pulse(player.pos);
  radar.ping(player.pos, performance.now() / 1000, world, entities.entities);
  // The sonar itself is SILENT to the player — no ping, no blip. The entities
  // still "hear" it in-fiction and converge on you; you just don't get an audio
  // cue back. All you have is the visual reveal.
  entities.hearSonar(player.pos.x, player.pos.z);
  energy = Math.max(0, energy - SONAR_COST); // revealing costs energy
}

canvas.addEventListener("mousedown", (e) => {
  if (sonarBinding === "mouse" + e.button) fireSonar();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // never show the menu
// Scrolling cycles the hotbar selection (and is swallowed while playing, so it
// can't scroll the page or trigger browser back-navigation and drop the lock).
canvas.addEventListener("wheel", (e) => {
  if (!playing) return;
  e.preventDefault();
  selectSlot(selectedSlot + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (sonarBinding === e.code) fireSonar();
  if (e.code === "KeyQ") { // toggle running
    runMode = !runMode;
    updateRunButton();
  }
  if (e.code === "KeyF") useSelected(); // eat meat / brandish a crucifix
  // 1-9 select a hotbar slot.
  if (e.code.startsWith("Digit")) {
    const n = parseInt(e.code.slice(5), 10);
    if (n >= 1 && n <= HOTBAR_SLOTS) selectSlot(n - 1);
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Torch ------------------------------------------------------------------
// The beam lights a cone of the world ahead (a real SpotLight, so it falls on
// the walls properly). Anything caught IN the beam — inside the cone, in range,
// and with a clear sightline — is enraged: it now knows exactly where you are,
// through walls, and comes at full speed. Light is not free here.
function updateTorch(dt) {
  if (torchOn) {
    torchBattery -= TORCH_DRAIN * dt;
    if (torchBattery <= 0) {
      torchBattery = 0;
      torchOn = false; // died on you
    }
  }
  torchLight.visible = torchOn;
  if (!torchOn) return;

  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  torchLight.position.copy(camera.position);
  torchLight.target.position.copy(camera.position).addScaledVector(_fwd, 10);
  torchLight.target.updateMatrixWorld();

  // Who's in the beam? Compare against the beam axis flattened onto the floor.
  const fx = _fwd.x;
  const fz = _fwd.z;
  const flen = Math.hypot(fx, fz) || 1;
  const cosLimit = Math.cos(TORCH_ANGLE);
  for (const e of entities.entities) {
    const dx = e.x - player.pos.x;
    const dz = e.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > TORCH_RANGE || d < 0.001) continue;
    const facing = (dx / d) * (fx / flen) + (dz / d) * (fz / flen);
    if (facing < cosLimit) continue; // outside the cone
    if (world.segmentBlocked(player.pos.x, player.pos.z, e.x, e.z)) continue; // wall in the way
    entities.enrage(e, ENRAGE_TIME);
  }
}

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
  audio.updateListener(camera); // 3D listener follows your head every frame
  world.update(player.pos);
  world.animate(now * 0.001); // flickering lights
  sonar.update(dt);
  pickups.animate(now * 0.001); // throbbing meat
  updateDistance();

  // Entities only hunt while actively playing (and alive).
  if (playing && !dead) {
    // Running drains energy; walking slowly gives it back, so backing off to a
    // walk is a real recovery option rather than just being slower.
    if (player.running && player.moving) {
      energy = Math.max(0, energy - RUN_DRAIN * dt);
    } else if (player.moving) {
      energy = Math.min(ENERGY_MAX, energy + WALK_REGEN * dt);
    }

    updateTorch(dt);
    if (entities.update(dt, player.pos, run.maxDistance, world)) die();

    // Pick up anything within reach that we have room for (used later, on F).
    const taken = pickups.update(player.pos, (type) => capacityFor(type) > 0);
    for (const type of taken) addItem(type, 1);
    if (taken.length) audio.pickup();
    energyFill.style.width = (energy / ENERGY_MAX) * 100 + "%";
    // The torch gauge only appears once you actually own a torch.
    const showTorch = hasItem("torch");
    torchBar.classList.toggle("hidden", !showTorch);
    if (showTorch) torchFill.style.width = (torchBattery / TORCH_MAX) * 100 + "%";

    // 3D spatial audio: position each entity's panner, muffle it through walls,
    // and schedule its (spatialised) footsteps.
    audio.updateEntities(entities.entities, player.pos, world, dt);

    // Proximity heartbeat (NOT spatialised — it's your own heart). Kicks in
    // inside 5m and accelerates from a slow heavy thud into a frantic flutter as
    // the entity closes to 1m.
    const near = entities.nearest;
    if (near < 5) {
      const t = Math.max(0, Math.min(1, (5 - near) / 4)); // 0 at 5m .. 1 at 1m
      heartTimer -= dt;
      if (heartTimer <= 0) {
        // Louder, and only a slight pitch rise — a big rate jump made it sound
        // chipmunky rather than frightened.
        audio.heartbeat(0.4 + t * 0.5, 0.95 + t * 0.3);
        // Tempo tops out around 128bpm. The old curve hit 0.30s (=200bpm), which
        // no human heart does — it read as comical instead of panicked.
        heartTimer = 1.05 - t * 0.58; // ~57bpm at 5m .. ~128bpm at 1m
      }
    } else {
      heartTimer = 0; // primed to beat the instant something closes in
    }
  }

  // Radar redraws every frame so blips fade on the same 15s curve as the walls.
  radar.draw(now * 0.001, player.pos, player.yaw, entities.entities);

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// --- Boot -------------------------------------------------------------------
versionTag.textContent = VERSION;
versionLabel.textContent = VERSION;
buildHotbar();
Menu.init();
Menu.refreshLeaderboard(todayUTC());
requestAnimationFrame(loop);
