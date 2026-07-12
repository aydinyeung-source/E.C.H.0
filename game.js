// game.js
// -----------------------------------------------------------------------------
// Bootstraps the Three.js scene and drives the main loop, wiring together the
// three subsystems: the endless World, the first-person Player, and the green
// Sonar. Keeps no game logic of its own beyond setup and the frame loop.
// -----------------------------------------------------------------------------

import { World, SPAWN } from "./world.js";
import { Player } from "./player.js";
import { SonarSystem } from "./sonar.js";

const VERSION = "v2.0.0";

const canvas = document.getElementById("scene");
const startOverlay = document.getElementById("startOverlay");
const startButton = document.getElementById("startButton");
const versionTag = document.getElementById("versionTag");

// --- Three.js core ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
// Exponential black fog dissolves everything into the void with distance, so the
// sonar only ever reveals your immediate surroundings.
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
const sonar = new SonarSystem(scene);

world.update(player.pos); // prime the chunks around the spawn point

// --- Input ------------------------------------------------------------------
startButton.addEventListener("click", () => canvas.requestPointerLock());

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  startOverlay.classList.toggle("hidden", locked);
  if (locked) sonar.pulse(player.pos); // an opening ping so you can get your bearings
});

// A click while locked fires a sonar pulse from the player's position.
canvas.addEventListener("mousedown", () => {
  if (document.pointerLockElement === canvas) sonar.pulse(player.pos);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Main loop --------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // clamp long frames (e.g. tab switch)
  last = now;

  player.update(dt, world);
  world.update(player.pos);
  sonar.update(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

versionTag.textContent = VERSION;
requestAnimationFrame(loop);
