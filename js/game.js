// game.js
// -----------------------------------------------------------------------------
// Bootstraps the Three.js scene and drives the main loop, wiring together the
// endless World, the first-person Player, and the green Sonar. Also owns the
// front-end concerns: seed selection (Minecraft-style), the daily challenge,
// and the persisted look-sensitivity setting.
// -----------------------------------------------------------------------------

import { World, SPAWN, setWorldSeed, CELL } from "./world.js";
import { Player, BASE_SENSITIVITY } from "./player.js";
import { SonarSystem } from "./sonar.js";
import { GLOW_TIME } from "./reveal.js";
import { EntitySystem } from "./entities.js";
import { AudioSystem } from "./audio.js";
import { Pickups, MEAT_ENERGY } from "./pickups.js";
import { Radar } from "./radar.js";
import { SafeRooms } from "./saferoom.js";
import { Menu } from "./menu.js";
import { submitDistance, flushPendingScores, pendingSyncCount } from "./supabase.js";

const VERSION = "v2.69.0";

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
const energyVignette = document.getElementById("energyVignette");
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
const playtestTag = document.getElementById("playtestTag");
const deathTag = document.getElementById("deathTag");
const dangerBar = document.getElementById("dangerBar");
const dangerBars = document.getElementById("dangerBars");
const doorBar = document.getElementById("doorBar");
const doorFill = document.getElementById("doorFill");
const doorLabel = document.getElementById("doorLabel");
const usePrompt = document.getElementById("usePrompt");
const terminalOverlay = document.getElementById("terminalOverlay");
const termProgress = document.getElementById("termProgress");
const termTitle = document.getElementById("termTitle");
const termLine = document.getElementById("termLine");
const termCode = document.getElementById("termCode");
const termTyped = document.getElementById("termTyped");
const termWarn = document.getElementById("termWarn");
const termPad = document.getElementById("termPad");

// Settings is a tab: the header button opens/closes the panel body.
settingsToggle.addEventListener("click", () => {
  const nowHidden = settingsBody.classList.toggle("hidden");
  settingsToggle.setAttribute("aria-expanded", String(!nowHidden));
});

// The rulebook: a home-screen-only overlay. It lays on top of the start screen and
// closes straight back to it — it never appears mid-run.
const rulesOverlay = document.getElementById("rulesOverlay");
const openRules = () => rulesOverlay.classList.remove("hidden");
const closeRules = () => rulesOverlay.classList.add("hidden");
document.getElementById("rulesButton").addEventListener("click", openRules);
document.getElementById("rulesClose").addEventListener("click", closeRules);
document.getElementById("rulesCloseBottom").addEventListener("click", closeRules);

// --- Three.js core ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
// THE FOG IS THE RENDER DISTANCE. Nothing here is lit, so how far you can see is
// decided entirely by how fast this black fog swallows a surface the sonar has
// revealed. 0.045 blacked everything out past ~35m, which made even a long
// straight corridor end in a wall of nothing a few strides ahead.
//
// 0.028 pushes that out to roughly 60m — you can now see a whole corridor light
// up and watch the ring travel away from you down it. It has to be kept in step
// with CHUNK_RADIUS in world.js: see further than the world is built and you'd be
// staring at the edge of the void.
scene.fog = new THREE.FogExp2(0x000000, 0.028);

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

// The safe rooms need to reach into the hotbar (the locker hands you things) and
// to throw screen effects, so they get two small adapters rather than a reference
// to the whole game. `give` returns false when the pack is full, which is what
// makes a prize stay lying on the floor instead of evaporating.
const inv = {
  give(type, n = 1) {
    if (capacityFor(type) < n) return false;
    addItem(type, n);
    return true;
  },
  has(type) {
    return hasItem(type);
  },
  take(type) {
    for (const s of hotbar) {
      if (s.type === type && s.count > 0) {
        s.count--;
        if (s.count === 0) s.type = null;
        renderHotbar();
        return true;
      }
    }
    return false;
  },
};

// NO NARRATION. These used to throw banners across the screen — "CODE ACCEPTED",
// "THEY'RE COMING THROUGH THE VENT", "THE DOOR WON'T SHUT AGAIN" — and every one of
// them was the game leaning over and explaining itself to you. It's a horror game
// about being somewhere you don't understand, and a HUD that captions the horror is
// a HUD that has removed it. You don't get told the vent gave way; you hear it give
// way, and then you hear them.
//
// Every one of these events already has a SOUND: the keypad chimes, the grate
// shrieks off its bolts, the vent breaks with a crash. That's the feedback. The
// hooks stay as no-ops so the safe-room code doesn't have to care.
const fx = {
  codeAccepted() {},
  taskDone() {},
  breach() {},
  ventOpen() {},
  doorSpent() {},
};

const saferooms = new SafeRooms(scene, world, audio, entities, inv, fx);

// A transient line of text in the prompt slot — it outranks the contextual [E]
// prompt while it lives.
let announceText = "";
let announceTimer = 0;
function announce(text, seconds) {
  announceText = text;
  announceTimer = seconds;
}

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
  // Room tone runs only while you're actually in there.
  if (v) audio.startAmbience();
  else audio.stopAmbience();
  if (!v) {
    // Close the terminal FIRST: it hands movement back to the player, and we're
    // about to take it away again. The other order leaves you paused but walking.
    saferooms.closeTerminal(player);
    renderTerminal();
    player.touchFwd = 0;
    player.touchStrafe = 0;
    torchOn = false; // don't leave the beam burning on a menu
    interactHeld = false;
    doorBar.classList.add("hidden");
    usePrompt.classList.add("hidden");
    energyVignette.style.opacity = 0; // don't leave the dark closed in over a menu
    energyVignette.classList.remove("spent");
    combineTimer = 0;
    combinePrompt = null;
  }
  player.enabled = v;
  playtestTag.classList.toggle("hidden", !(v && run.playtest));
  deathTag.classList.toggle("hidden", !(v && run.playtest));
  energyBar.classList.toggle("hidden", !v);
  hotbarEl.classList.toggle("hidden", !v);
  torchBar.classList.toggle("hidden", !v);
  radarCanvas.classList.toggle("hidden", !v);
  dangerBar.classList.toggle("hidden", !v);
  mobileControls.classList.toggle("hidden", !(v && deviceMode === "mobile"));
}
let runMode = false; // toggled with Q

// A full bar is now ~21s of continuous sprinting (was ~8s, which drained far too
// fast to actually outrun anything).
const ENERGY_MAX = 150;
const RUN_DRAIN = 7;   // energy per second while running and moving
const WALK_REGEN = 4;  // energy per second regained while walking (not running)
const REST_REGEN = 5;  // energy per second while standing still — resting is faster
                       // than walking, so stopping to catch your breath is worth it

// EXHAUSTION. Run yourself to empty and you can't run again until you've caught
// your breath — you must walk your energy back up to RUN_RECOVER first.
//
// This is a hysteresis LATCH, and it fixes a real bug: without it, at 0 energy you'd
// drop to a walk for one frame, regain a sliver, run again, hit 0, and flicker like
// that forever — which nets you a speed FASTER than walking on empty, exactly what
// running out is supposed to prevent. The latch means empty really means empty.
const RUN_RECOVER = ENERGY_MAX * 0.2; // ~7.5s of walking to get your wind back
let exhausted = false;
// Energy per sonar reveal. Raised from 4: a full bar used to buy ~37 pings, which
// is enough that you never had to think about it. At 6 it's ~25, and on a long run
// the question "can I afford to look?" starts having a real answer.
// THE PING COSTS 15% OF THE BAR, AND THE DISH TAKES 15 SECONDS TO RECHARGE.
//
// The cooldown is GLOW_TIME exactly (reveal.js), and that is the whole idea: a
// revealed wall fades to black over fifteen seconds, so the sonar comes back at the
// precise moment the last of the light you bought finishes dying. You are never
// standing in the dark waiting for it, and you never have a spare ping in hand while
// the world is still lit. One look, one fade, one look.
//
// The energy cost is a fraction of the bar rather than a flat number, so it can't
// silently drift out of meaning if ENERGY_MAX is ever retuned. At 15% a full bar is
// SIX pings — you can no longer spam the sonar and simply eat more meat, and "can I
// afford to look?" is now a real question with a real answer.
//
// Together they stop the ping being an answer to being hunted. Something has you,
// the dish is dead for another twelve seconds, and all you have left is your feet
// and the map in your head. That is the game.
// THE DARK GAP. The cooldown is the glow time PLUS a deliberate 2.5 seconds, so
// 17.5s in total.
//
// Matching the fade exactly (15s) was too tidy: the last of the light died and the
// dish came straight back, and you could walk the whole game on a rolling carousel
// of borrowed light without ever once standing in the black. The extra 2.5s is the
// point of the whole system — a stretch of pure darkness, every single cycle, where
// all you have is the map in your head and whatever you can hear.
//
// The cooldown stays DERIVED from GLOW_TIME (imported, not copied), so retuning how
// long walls take to fade can never silently swallow the darkness.
const DARK_GAP = 2.5;
const SONAR_COOLDOWN = GLOW_TIME + DARK_GAP; // 17.5s
let sonarTimer = 0; // seconds until the sonar is live again

// A ping costs a QUARTER OF WHAT YOU HAVE LEFT, plus a flat 6 on top. So it's cheap
// when you're topped up and brutal when you're nearly empty — a percentage bites
// hardest exactly when you can least afford it. And you can't fire below SONAR_FLOOR
// at all: you need a real reserve to sound the ring, not just the dregs.
const SONAR_FLOOR = 6;           // can't ping below this
const SONAR_PCT = 0.25;          // ...and it takes a quarter of the rest
function sonarCost() {
  return energy * SONAR_PCT + SONAR_FLOOR;
}

// Crucifix: the panic button, and rare. Brandishing it does three things at once
// for WARD_TIME seconds: BLINDS every entity in the world (not just the nearest),
// fires a free reveal, and floods you with adrenaline (a speed burst).
const WARD_TIME = 7;        // seconds of blindness + speed
const WARD_SPEED_BOOST = 1.45;
let boostTimer = 0;

// Assembling a crucifix from its two halves. It's a DELIBERATE act: select the top
// half and press USE, and — provided you're also carrying a bottom — you spend
// COMBINE_COST energy and work at it for COMBINE_TIME seconds before the whole
// crucifix is yours. It's a channel (a countdown), not a stand-still: once started
// it runs to completion.
const COMBINE_TIME = 3;
const COMBINE_COST = 5;
let combineTimer = 0;     // seconds LEFT on an in-progress assembly (0 = idle)
let combinePrompt = null; // shown in the prompt slot while assembling

// (The halon vent lived here. It was a free undo for every mistake a safe room can
//  make you commit — and a room with a get-out-of-jail card in it is a room where
//  none of the other decisions cost you anything.)

// Torch: shows you a slice of what's ahead — but shine it at something and you
// ENRAGE it.
//
// Torches are CONSUMABLE, not rechargeable. Every torch you find is full. The one
// in your hand burns down; when it dies it is gone for good, and you break out the
// next one from your stack. So each torch in the hotbar is one full burn, and
// "how much light do I have left" is just "how many torches am I carrying".
// (torchCharge is the charge of the one currently in hand; the stack count still
// includes it, so the slot never empties out from under a lit torch.)
const TORCH_MAX = 100;
const TORCH_DRAIN = 4;      // charge per second while lit -> ~25s per torch
const TORCH_RANGE = 24;     // how far the beam reaches
const TORCH_ANGLE = 0.38;   // half-angle of the beam (radians, ~22deg)
const ENRAGE_TIME = 10;     // seconds an entity stays enraged after being lit
let torchOn = false;
let torchCharge = 0;

// A torch burned out: bin it. The stack still contained the lit one, so this is
// where it actually leaves your inventory.
function consumeDeadTorch() {
  for (const s of hotbar) {
    if (s.type === "torch" && s.count > 0) {
      s.count--;
      if (s.count === 0) s.type = null;
      renderHotbar();
      return;
    }
  }
}

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
const STACK_MAX = 32; // the default, and the ceiling for food

// STACK SIZES ARE A BALANCE LEVER, not a storage detail.
//
// A stack limit is really a limit on how much of a thing you can carry at all,
// because you only have nine slots and everything competes for them. Food stacks
// deep (32) because it's mundane and you burn through it. The crucifix and the
// torch stack four — so hoarding them costs you slots you'd rather have free, and
// a run where you're carrying eight crucifixes is a run where you're carrying
// almost nothing else. That's the trade, and it's what stops the panic item from
// quietly becoming the default answer to everything.
const STACK_LIMITS = {
  meat: 32,
  torch: 4,
  crucifix: 4,
  cruxtop: 4, // the two halves of a broken crucifix; combine them by stopping
  cruxbot: 4,
};

function stackLimit(type) {
  return STACK_LIMITS[type] ?? STACK_MAX;
}
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
    icon.classList.toggle("cruxtop", filled && item.type === "cruxtop");
    icon.classList.toggle("cruxbot", filled && item.type === "cruxbot");
    el.querySelector(".slot-count").textContent = filled && item.count > 1 ? item.count : "";
  }
}

function selectSlot(i) {
  selectedSlot = ((i % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  renderHotbar();
}

// The first slot holding nothing (or the last slot if the pack is somehow full).
// A run starts here so that the very first press of USE can't spend anything.
function firstEmptySlot() {
  const i = hotbar.findIndex((s) => s.type === null || s.count === 0);
  return i === -1 ? HOTBAR_SLOTS - 1 : i;
}

function resetHotbar() {
  hotbar = Array.from({ length: HOTBAR_SLOTS }, () => ({ type: null, count: 0 }));
  selectedSlot = 0;
  renderHotbar();
}

// Room left for a given item type (so a full pack leaves things on the ground).
function capacityFor(type) {
  const max = stackLimit(type);
  let cap = 0;
  for (const s of hotbar) {
    if (s.type === type) cap += max - s.count;
    else if (s.type === null || s.count === 0) cap += max;
  }
  return cap;
}

// Top up existing stacks first, then spill into empty slots. A fifth crucifix
// starts a SECOND stack in a new slot rather than deepening the first — which is
// exactly the cost: it eats a slot.
function addItem(type, n) {
  const max = stackLimit(type);
  let left = n;
  for (const s of hotbar) {
    if (left <= 0) break;
    if (s.type === type && s.count < max) {
      const take = Math.min(left, max - s.count);
      s.count += take;
      left -= take;
    }
  }
  for (const s of hotbar) {
    if (left <= 0) break;
    if (s.type === null || s.count === 0) {
      s.type = type;
      const take = Math.min(left, max);
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

// F (and the mobile USE button) uses whatever is in the SELECTED slot — eat meat,
// light a torch, brandish a crucifix.
//
// With an EMPTY slot selected it falls through to interact instead. On mobile
// that means USE always does the sensible thing: hold nothing, and it pulls the
// lever / uses the terminal in front of you, rather than being a dead button you
// have to think about. There's no ambiguity to resolve — an empty slot has
// nothing to use.
function useSelected() {
  if (!playing) return;
  const s = hotbar[selectedSlot];
  if (!s || s.count <= 0) {
    interactPress();
    return;
  }

  if (s.type === "meat") {
    if (energy >= ENERGY_MAX) return; // refuse, so food isn't wasted
    consumeSelected();
    energy = Math.min(ENERGY_MAX, energy + MEAT_ENERGY);
    audio.pickup();
  } else if (s.type === "torch") {
    if (torchOn) {
      torchOn = false; // douse it — the remaining charge keeps for later
    } else {
      // Nothing lit in hand? Break out a fresh torch. It always starts full;
      // it only leaves the stack once it has actually burned out.
      if (torchCharge <= 0) torchCharge = TORCH_MAX;
      torchOn = true;
    }
    audio.pickup();
  } else if (s.type === "crucifix") {
    consumeSelected();
    entities.blindAll(WARD_TIME); // EVERY entity, at any distance
    boostTimer = WARD_TIME;       // adrenaline
    // A free reveal that costs no energy and gives nothing away — they're blind.
    sonar.pulse(player.pos);
    radar.ping(player.pos, performance.now() / 1000, world, entities.entities);
    audio.ward();
    wardFlash.classList.remove("hidden");
    void wardFlash.offsetWidth; // restart the CSS animation
    wardFlash.classList.add("flash");
    setTimeout(() => {
      wardFlash.classList.remove("flash");
      wardFlash.classList.add("hidden");
    }, 600);
  } else if (s.type === "cruxtop") {
    // USE on the top half starts the assembly (needs a bottom, room, and energy).
    startCombine();
  }
  // A lone bottom half (cruxbot) has no USE action — you drive the assembly from
  // the top. It just sits in the pack until then.
}

function updateRunButton() {
  mcRun.textContent = runMode ? "STOP RUNNING" : "RUN";
  mcRun.classList.toggle("active", runMode);
}

// --- Interaction (E / the mobile ACT button) --------------------------------
// One key does everything a safe room offers, because the game tells you what it
// will do before you press it. Holding it is a separate thing: that's how you
// board things up (there is nothing left to board up, but the hold plumbing stays).
let interactHeld = false;

function interactPress() {
  if (!playing || dead) return;
  if (saferooms.terminal) {
    saferooms.closeTerminal(player); // E backs you out of the screen
    return;
  }
  saferooms.press(player, world);
}

// --- The terminal keypad (touch) --------------------------------------------
// On PC the number row does the same job, so the pointer never has to leave the
// lock. This grid exists for fingers.
function buildTermPad() {
  termPad.innerHTML = "";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "EXIT"];
  for (const k of keys) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "term-key";
    b.textContent = k;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (k === "EXIT") saferooms.closeTerminal(player);
      else if (k === "CLR") {
        if (saferooms.terminal) saferooms.clearTyped();
      } else {
        saferooms.typeDigit(k, player, world);
      }
      renderTerminal();
    });
    termPad.appendChild(b);
  }
}

function renderTerminal() {
  const view = saferooms.terminalView();
  terminalOverlay.classList.toggle("hidden", !view);
  if (!view) return;

  termTitle.textContent = view.title;
  termLine.textContent = view.line;
  termProgress.textContent = `${view.index} / ${view.total}`;

  // THE KEYPAD SHOWS NOTHING. No code, no hint, and the digits you've entered come
  // back as blanks — because a readout that echoes your typing is a readout you can
  // check your memory against, and then you're not remembering ten digits, you're
  // remembering one at a time. It tells you only how many it has swallowed.
  const keypad = view.kind === "keypad";
  termCode.textContent = keypad ? "· · · · · · · · · ·" : view.target;
  termCode.classList.toggle("blind", keypad);
  termTyped.textContent = keypad
    ? "•".repeat(view.typed.length).padEnd(view.need, "_")
    : view.typed.padEnd(view.need, "_");
  termWarn.classList.toggle("hidden", !view.breached);
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
const run = { seed: 0, date: todayUTC(), isDaily: false, maxDistance: 0, playtest: false, deaths: 0 };

// Seconds an entity must be off you before another catch counts as a new death.
const DEATH_RECOUNT = 3;
let deathCooldown = 0;

function renderDeathTag() {
  deathTag.textContent = `☠ WOULD-BE DEATHS: ${run.deaths}`;
}

function startRun(rawSeedText, label, isDaily) {
  run.seed = parseSeed(rawSeedText);
  run.isDaily = isDaily;
  run.date = todayUTC();
  run.maxDistance = 0;
  visitedCells.clear();
  // Immunity is decided ONCE, here, and frozen for the whole run — it can't be
  // switched off partway through to launder a run into a real score.
  run.playtest = Menu.isPlaytester && Menu.playtest;
  run.deaths = 0;
  deathCooldown = 0;
  renderDeathTag();
  playtestTag.classList.toggle("hidden", !run.playtest);
  dead = false;
  heartTimer = 0;
  energy = ENERGY_MAX;
  exhausted = false;
  combineTimer = 0;
  combinePrompt = null;
  runMode = false;
  resetHotbar();
  // You always set out with one crucifix and one meat — a single escape and a
  // single meal, so you're never dead on arrival with nothing to fall back on.
  addItem("crucifix", 1);
  addItem("meat", 1);
  // ...but you do NOT start with the crucifix in your hand. It landed in slot 1 and
  // slot 1 is selected by default, so the very first press of USE burned the one
  // item in the game you cannot replace. Start on an EMPTY slot: now the first
  // press does nothing (or interacts, on mobile), and spending the crucifix takes
  // a deliberate act of selecting it.
  selectSlot(firstEmptySlot());
  torchOn = false;
  torchCharge = 0;
  boostTimer = 0;
  announceTimer = 0;
  interactHeld = false;
  sonarTimer = 0; // you always arrive with the dish charged
  updateRunButton();
  radar.clear();
  audio.init(); // this is called from a click, so audio is allowed to start
  gameOverOverlay.classList.add("hidden");
  pauseOverlay.classList.add("hidden");
  setWorldSeed(run.seed);
  player.reset(SPAWN);
  world.reset();
  world.update(player.pos); // rebuild chunks around spawn from the new seed
  // The maze is already inhabited when you get there — they're out in it from the
  // start, wandering, well beyond sight. They just don't know you exist yet.
  entities.reset(player.pos, world);
  audio.resetVoices(); // drop spatial voices from the previous run
  pickups.reset(); // loot lives in the chunks now, not in a pool around you
  // Every door re-locks, every grate goes back on, every locker is shut again.
  saferooms.reset();
  saferooms.sync(player.pos);
  renderTerminal();
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
  rulesOverlay.classList.add("hidden"); // never leave the rulebook over the game
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
  gameOverDistance.textContent = run.maxDistance + " cells";
  gameOverOverlay.classList.remove("hidden");
}

// An entity reached the player: jumpscare, then end the run.
function die() {
  if (dead) return;
  audio.entityDeath(); // it went with you — entities.js has already removed it

  // Playtest immunity: they still hunt you, still catch you, still breathe down
  // your neck — you simply do not die. Everything else about the run is real, so
  // what you're testing is the real game.
  //
  // But you still need to KNOW. Every catch is counted and shown, so a playtest
  // tells you honestly how many times the run would have ended.
  //
  // The cooldown matters: die() is called on every frame an entity is inside the
  // kill radius, so without it standing next to one would rack up 60 deaths a
  // second. One catch = one death, and it can't count again until it has been off
  // you for DEATH_RECOUNT seconds.
  if (run.playtest) {
    if (deathCooldown <= 0) {
      run.deaths++;
      deathCooldown = DEATH_RECOUNT;
      renderDeathTag();
      announce("YOU WOULD HAVE DIED", 2);
      wardFlash.classList.remove("hidden");
      void wardFlash.offsetWidth; // restart the CSS animation
      wardFlash.classList.add("flash");
      setTimeout(() => {
        wardFlash.classList.remove("flash");
        wardFlash.classList.add("hidden");
      }, 400);
    }
    return;
  }

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
  if (run.playtest) return; // an immune run is not a score. no exceptions.
  if (run.isDaily && run.maxDistance > 0) {
    submitDistance({ seed: run.seed, date: run.date, distance: run.maxDistance })
      .then(() => Menu.refreshLeaderboard(run.date));
  }
}

// Returning to the menu re-stages the background scene. Without this the home
// screen would sit at the spot you died, with whatever killed you standing in
// the camera — which is funny once and awful every time after.
function restageMenu() {
  player.reset(SPAWN);
  world.update(player.pos);
  entities.reset(player.pos, world); // one of them, placed far off and out of sight
  saferooms.reset();
  menuDrift = 0;
  menuPing = 1.5;
}

tryAgainButton.addEventListener("click", () => {
  dead = false;
  gameOverOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
  restageMenu();
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
  restageMenu();
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

// USE is the ONLY action button on mobile, and it is context-first:
//
//   * If the game is showing you a prompt (pull the switch, use the terminal, hit
//     the panic button, board up the door), USE does that.
//   * Otherwise it uses whatever is in the selected hotbar slot.
//   * HOLDING it boards up a door, which is why it can't just be onPress().
//
// The prompt wins on purpose. A separate ACT button meant a permanent extra thing
// on screen for a mechanic you meet in maybe one room in ten — and when there's a
// switch in front of you, acting on it is what you want. The cost is that standing
// AT a safe-room fixture, USE won't eat: take one step back and it will.
//
// pointerup AND pointercancel both have to release the hold, or a touch that
// slides off the button would leave you hammering nails forever.
mcEat.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  interactHeld = true;
  if (saferooms.prompt) interactPress();
  else useSelected();
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
  mcEat.addEventListener(ev, () => {
    interactHeld = false;
  });
}
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
// F is the "use item" key and E is now "interact" (switches, terminals, boarding
// up a door), so migrate anyone who had sonar bound to either of them.
if (sonarBinding === "KeyF" || sonarBinding === "KeyE") {
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
  if (saferooms.terminal) return;   // you're nose-to-screen; you can't ping
  if (sonarTimer > 0) return;       // still recharging — see SONAR_COOLDOWN
  if (energy < SONAR_FLOOR) return; // not enough left to sound the ring at all
  sonarTimer = SONAR_COOLDOWN;
  energy = Math.max(0, energy - sonarCost()); // quarter of the rest, plus a flat 6
  audio.sonar(); // the outgoing ping — you hear yourself send it
  sonar.pulse(player.pos);
  radar.ping(player.pos, performance.now() / 1000, world, entities.entities);
  // The sonar itself is SILENT to the player — no ping, no blip. The entities
  // still "hear" it in-fiction and converge on you; you just don't get an audio
  // cue back. All you have is the visual reveal.
  entities.hearSonar(player.pos.x, player.pos.z);
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

  // While a terminal is up, the number row IS the keypad — it stops driving the
  // hotbar, and nothing else in the game responds.
  if (saferooms.terminal) {
    if (e.code === "KeyE" || e.code === "Escape") {
      saferooms.closeTerminal(player);
      renderTerminal();
      return;
    }
    if (e.code === "Backspace") {
      saferooms.clearTyped();
      renderTerminal();
      return;
    }
    if (e.code.startsWith("Digit") || e.code.startsWith("Numpad")) {
      const d = e.code.replace("Digit", "").replace("Numpad", "");
      if (/^\d$/.test(d)) {
        saferooms.typeDigit(d, player, world);
        renderTerminal();
      }
    }
    return;
  }

  if (e.code === "KeyE") {
    interactHeld = true;
    interactPress();
  }
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

window.addEventListener("keyup", (e) => {
  if (e.code === "KeyE") interactHeld = false;
});
// Never leave the interact key stuck down if the window loses focus mid-hold.
window.addEventListener("blur", () => {
  interactHeld = false;
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
    torchCharge -= TORCH_DRAIN * dt;
    if (torchCharge <= 0) {
      torchCharge = 0;
      torchOn = false;
      consumeDeadTorch(); // it died in your hand and is gone for good
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

// Is there anywhere for a finished crucifix to go? An existing space now, OR a
// half-slot that will empty when consumed (count === 1). Without this, assembling
// with a full pack would eat both halves and drop the crucifix into the void.
function roomForCrucifix() {
  return (
    capacityFor("crucifix") > 0 ||
    hotbar.some((s) => (s.type === "cruxtop" || s.type === "cruxbot") && s.count === 1)
  );
}

// Called from USE (see useSelected) when the top half is selected. Kicks off the
// assembly channel if everything's in order. Returns true if it started.
function startCombine() {
  if (combineTimer > 0) return true;             // already at it
  if (!hasItem("cruxtop") || !hasItem("cruxbot")) return false; // need both halves
  if (!roomForCrucifix()) return false;          // no room for the result
  if (energy < COMBINE_COST) return false;       // can't afford it
  energy -= COMBINE_COST;                         // committed up front
  combineTimer = COMBINE_TIME;
  audio.pickup();                                 // a small click to say "started"
  return true;
}

// Advance an in-progress assembly. A plain countdown — no stand-still needed.
function updateCombine(dt) {
  if (combineTimer <= 0) {
    combinePrompt = null;
    return;
  }
  combineTimer -= dt;
  if (combineTimer <= 0) {
    combineTimer = 0;
    combinePrompt = null;
    inv.take("cruxtop");
    inv.take("cruxbot");
    addItem("crucifix", 1);
    audio.ward(); // the same clean chime the crucifix rings out with
    announce("CRUCIFIX ASSEMBLED", 2);
    return;
  }
  const pct = Math.round((1 - combineTimer / COMBINE_TIME) * 100);
  combinePrompt = `ASSEMBLING CRUCIFIX ${pct}%`;
}

// --- The danger bar ---------------------------------------------------------
// Proximity to the NEAREST entity, and nothing else. No direction, no count, no
// names. It answers exactly one question — "is this getting worse?" — which is the
// only question you can actually act on while standing in the dark.
//
// It deliberately does NOT replace the radar. The radar tells you WHERE, and the
// radar costs you a ping and fifteen seconds of cooldown. This is free, and it is
// vague on purpose: it can tell you something is close without ever telling you
// which way to run.
const DANGER_RANGE = 30; // beyond this, nothing is lit
const DANGER_BARS = 8;

// Each bar is taller than the last, so the graph rises towards the face at the
// right-hand end. The shape alone tells you which way is bad.
function buildDangerBars() {
  dangerBars.innerHTML = "";
  for (let i = 0; i < DANGER_BARS; i++) {
    const b = document.createElement("div");
    b.className = "danger-bar";
    b.style.height = 9 + (i / (DANGER_BARS - 1)) * 21 + "px"; // 9px -> 30px
    dangerBars.appendChild(b);
  }
}

function updateDangerBar() {
  const d = entities.nearest;
  const frac = Number.isFinite(d) ? Math.max(0, Math.min(1, 1 - d / DANGER_RANGE)) : 0;
  const lit = Math.ceil(frac * DANGER_BARS); // 0 = nothing near you

  for (let i = 0; i < DANGER_BARS; i++) {
    const b = dangerBars.children[i];
    const on = i < lit;
    b.classList.toggle("lit", on);
    if (!on) {
      b.style.background = "";
      b.style.boxShadow = "";
      continue;
    }
    // Each bar carries its OWN colour by position — green at the left, red at the
    // right — so the colour says how bad it is without you having to count bars.
    const hue = 120 * (1 - i / (DANGER_BARS - 1));
    b.style.background = `hsl(${hue}, 88%, 52%)`;
    b.style.boxShadow = `0 0 6px hsla(${hue}, 90%, 55%, 0.75)`;
  }

  dangerBar.classList.toggle("critical", frac > 0.8);
}

// --- Safe-room HUD ----------------------------------------------------------
// The door bar and the contextual prompt. A transient announcement ("THE DOOR IS
// GONE") outranks the prompt while it's alive — at that moment it's the only
// thing you need to read.
function updateSafeRoomHud() {
  const hud = saferooms.hud;
  doorBar.classList.toggle("hidden", !hud);
  if (hud) {
    doorFill.style.width = hud.pct * 100 + "%";
    doorBar.classList.toggle("under-siege", hud.sieging);
    // The bar tracks whichever way in they're actually working on.
    doorLabel.textContent = hud.vent ? "VENT" : "DOOR";
  }

  // Priority: a transient announcement, then a safe-room prompt, then the crucifix
  // assembly progress. Only one line ever shows.
  const text =
    announceTimer > 0 ? announceText
    : saferooms.prompt ? saferooms.prompt.text
    : combinePrompt ? combinePrompt
    : "";
  usePrompt.textContent = text;
  usePrompt.classList.toggle("hidden", !text);

  // The button always reads USE — it's one button and it does the obvious thing.
  // It only picks up a cyan tint when it's about to act on the room rather than
  // your inventory, which is a hint, not a relabelling.
  mcEat.classList.toggle("acting", !!saferooms.prompt);

  renderTerminal();
}

// --- Cells uncovered --------------------------------------------------------
// The score is now HOW MUCH OF THE MAZE YOU SAW, not how far you got from spawn.
//
// Straight-line distance rewarded exactly one behaviour: pick a direction and
// sprint down it. Everything the game is actually about — searching rooms, working
// out a safe-room code, doubling back, going the long way round something that's
// hunting you — scored zero, and sometimes scored NEGATIVE, because looping back
// towards spawn made your number stop moving.
//
// Counting distinct cells you've set foot in fixes that: every new corridor is
// worth the same as any other, and a run that goes deep into one wing is worth the
// same as one that sprawls. It also means you cannot pad the score by pacing — a
// cell you've already been in never counts twice.
const visitedCells = new Set();

function updateCells() {
  if (!playing) return;
  const i = Math.floor(player.pos.x / CELL);
  const j = Math.floor(player.pos.z / CELL);
  visitedCells.add(i + "," + j);
  run.maxDistance = visitedCells.size; // the leaderboard column is still numeric
  distanceTag.textContent = run.maxDistance + " cells";
}

// --- The home screen's live background ---------------------------------------
// The menu is not a picture. The maze is rendering live behind it, and there is
// something in it.
//
// Every few seconds an ambient ping washes down the corridors — free, silent,
// and it alerts nothing, because the thing back there has no AI running. It just
// walks the halls. Its eyes are unlit, so even in total darkness you get two red
// points drifting past behind the login form, and when a ping does land you get a
// second of silhouette.
//
// The camera breathes very slightly, so the shot is never quite still.
const MENU_PING_INTERVAL = 6.5;
let menuPing = 1.5;
let menuDrift = 0;

function updateMenuScene(dt) {
  entities.menuStart(world, player.pos); // no-op once one is out there
  entities.menuUpdate(dt, world);

  menuPing -= dt;
  if (menuPing <= 0) {
    menuPing = MENU_PING_INTERVAL + Math.random() * 4;
    sonar.pulse(player.pos);
  }

  menuDrift += dt;
  player.yaw = Math.sin(menuDrift * 0.09) * 0.42;
  player.pitch = Math.sin(menuDrift * 0.06) * 0.05;
}

// --- Main loop --------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // clamp long frames (tab switch)
  last = now;

  // Idling on the home screen: run the ambient scene behind the menu.
  if (!playing && !dead && !startOverlay.classList.contains("hidden")) {
    updateMenuScene(dt);
  }

  // Crucifix adrenaline: a temporary speed multiplier.
  if (boostTimer > 0) {
    boostTimer -= dt;
    player.boost = WARD_SPEED_BOOST;
  } else {
    player.boost = 1;
  }

  if (announceTimer > 0) announceTimer -= dt;
  if (deathCooldown > 0) deathCooldown -= dt;
  if (sonarTimer > 0) sonarTimer -= dt;

  // Apply run intent before moving: you can only run with energy in hand, and once
  // you hit empty you're LOCKED to a walk until you've recovered to RUN_RECOVER.
  if (energy <= 0) exhausted = true;
  else if (energy >= RUN_RECOVER) exhausted = false;
  player.running = runMode && !exhausted && energy > 0;
  player.update(dt, world);
  audio.updateListener(camera); // 3D listener follows your head every frame
  world.update(player.pos);
  world.animate(now * 0.001); // flickering lights
  sonar.update(dt);
  pickups.sync(world); // stream chunk loot in/out with its chunk
  pickups.animate(now * 0.001);
  updateCells();

  // Entities only hunt while actively playing (and alive).
  if (playing && !dead) {
    // Running drains; walking gives a little back; STANDING STILL gives the most.
    // So there's a real ladder of recovery — the more you slow down, the faster you
    // catch your breath, and stopping dead is the quickest way back to full.
    if (player.running && player.moving) {
      energy = Math.max(0, energy - RUN_DRAIN * dt);
    } else if (player.moving) {
      energy = Math.min(ENERGY_MAX, energy + WALK_REGEN * dt);
    } else {
      energy = Math.min(ENERGY_MAX, energy + REST_REGEN * dt);
    }

    // Your own movement bed: breathing + footsteps, looped while you move, louder
    // and faster when you run.
    audio.setMoving(player.moving, player.running);

    // Assemble a crucifix from its halves: hold still with both, and it comes
    // together over COMBINE_TIME. Moving (or being at a terminal) resets it.
    updateCombine(dt);

    updateTorch(dt);
    if (entities.update(dt, player.pos, player.yaw, run.maxDistance, world)) die();

    // Safe rooms: streaming, the door, the siege, the props, the prompts. Runs
    // AFTER the entities so it sees this frame's blows against the door.
    saferooms.update(dt, player, interactHeld, world);
    updateSafeRoomHud();
    updateDangerBar();

    // Pick up anything within reach that we have room for (used later, on F).
    const taken = pickups.update(player.pos, (type) => capacityFor(type) > 0);
    for (const type of taken) addItem(type, 1);
    if (taken.length) audio.pickup();
    energyFill.style.width = (energy / ENERGY_MAX) * 100 + "%";

    // Exhaustion vignette: nothing until you drop under ~45%, then the dark closes
    // in, hardest as you approach empty. The pulse kicks in once you're truly spent.
    const lowThresh = ENERGY_MAX * 0.45;
    const drain = Math.max(0, (lowThresh - energy) / lowThresh); // 0 at 45% .. 1 at empty
    energyVignette.style.opacity = (drain * 0.9).toFixed(3);
    energyVignette.classList.toggle("spent", energy <= ENERGY_MAX * 0.12);
    // The torch gauge only appears once you actually own a torch.
    const showTorch = hasItem("torch");
    torchBar.classList.toggle("hidden", !showTorch);
    if (showTorch) torchFill.style.width = (torchCharge / TORCH_MAX) * 100 + "%";

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
  // The dish's outer ring doubles as the sonar's charge gauge — no HUD widget, no
  // number, the thing in your hands just visibly comes back to life.
  const sonarCharge = 1 - Math.max(0, sonarTimer) / SONAR_COOLDOWN;
  radar.draw(now * 0.001, player.pos, player.yaw, entities.entities, sonarCharge);

  // The SEND SONAR button is itself the dial: --charge drives a conic sweep that
  // fills clockwise from twelve o'clock as the dish comes back. Written straight to
  // the element every frame — no CSS transition, or it would lag behind the loop and
  // the wedge would never quite line up with when you can actually fire.
  mcPing.style.setProperty("--charge", sonarCharge.toFixed(3));
  mcPing.classList.toggle("charging", sonarTimer > 0);

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// --- Offline score catch-up -------------------------------------------------
// Scores set with no connection are queued in localStorage. Replay them once we
// have a network AND the account that earned them is signed back in — so we run
// this after Menu.init() has restored the session, and again whenever the
// connection comes back mid-session.
async function syncOfflineScores() {
  const queued = pendingSyncCount();
  if (!queued) return;
  console.info(`[E.C.H.0] ${queued} score(s) waiting to sync…`);
  const res = await flushPendingScores();
  if (res.synced) Menu.refreshLeaderboard(todayUTC()); // the board just changed
}

window.addEventListener("online", syncOfflineScores);

// --- Kicked out (the account was claimed by another device) ------------------
// The session is already gone by the time this fires, so there is nothing to
// submit — a score RPC would just be rejected. End the run, drop the pointer
// lock, and put them back on the home screen where the "signed out" message is.
Menu.onSessionRevoked = () => {
  if (!playing && !dead) return;
  dead = false;
  setPlaying(false);
  if (deviceMode === "pc" && document.pointerLockElement === canvas) document.exitPointerLock();
  gameOverOverlay.classList.add("hidden");
  pauseOverlay.classList.add("hidden");
  startOverlay.classList.remove("hidden");
  restageMenu();
};

// --- Boot -------------------------------------------------------------------
versionTag.textContent = VERSION;
versionLabel.textContent = VERSION;
buildHotbar();
buildTermPad();
buildDangerBars();
Menu.init().then(syncOfflineScores); // wait for the session before replaying
Menu.refreshLeaderboard(todayUTC());
requestAnimationFrame(loop);
