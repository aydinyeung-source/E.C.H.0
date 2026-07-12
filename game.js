import { fetchLeaderboard, submitScore, isSupabaseConfigured } from "./supabase.js";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const startOverlay = document.getElementById("startOverlay");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const startButton = document.getElementById("startButton");
const restartButton = document.getElementById("restartButton");
const submitScoreButton = document.getElementById("submitScoreButton");
const nicknameInput = document.getElementById("nicknameInput");
const scoreText = document.getElementById("scoreText");
const bestText = document.getElementById("bestText");
const gameOverSummary = document.getElementById("gameOverSummary");
const dailyBestText = document.getElementById("dailyBestText");
const leaderboardList = document.getElementById("leaderboardList");
const versionTag = document.getElementById("versionTag");

// Single source of truth for the build version (semver: MAJOR.MINOR.PATCH).
// Bumped on every deploy and shown in the corner of the phone frame.
const VERSION = "v1.0.0";

const VIEW_WIDTH = 450;
const VIEW_HEIGHT = 800;
const PLAYER_RADIUS = 18;
const PLAYER_Y = VIEW_HEIGHT - 120;

// Chunk grid: every chunk is a fixed 450x900 slice laid out on a 9x18 grid of
// 50px cells. 9 cols * 50 = 450 (full screen width); 18 rows * 50 = 900 tall.
// Designing obstacles on cell boundaries keeps safe paths clean to reason about.
const CELL = 50;
const GRID_COLS = 9;
const GRID_ROWS = 18;
const CHUNK_HEIGHT = GRID_ROWS * CELL; // 900

const BASE_SCROLL_SPEED = 180;
const MAX_SCROLL_SPEED = 420;
const REVEAL_DURATION_MS = 2000;

const state = {
  mode: "start",
  score: 0,
  cameraY: 0,
  scrollSpeed: BASE_SCROLL_SPEED,
  player: {
    x: VIEW_WIDTH / 2,
    y: PLAYER_Y,
    targetX: VIEW_WIDTH / 2,
  },
  chunks: [],
  waves: [],
  lastTime: 0,
  nextChunkY: 0,
  dailyBest: 0,
  activePointer: false,
  seed: "",
  seedRng: null,
  leaderboardStatus: "",
};

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createSeededRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function getDailySeed() {
  const now = new Date();
  const rawSeed = Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`);
  return rawSeed % 0x100000000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function loadDailyBest(date) {
  const key = `echo-drift-daily-best-${date}`;
  const stored = localStorage.getItem(key);
  state.dailyBest = stored ? Number(stored) : 0;
  bestText.textContent = String(state.dailyBest);
  dailyBestText.textContent = String(state.dailyBest);
}

function saveDailyBest(date) {
  const key = `echo-drift-daily-best-${date}`;
  localStorage.setItem(key, String(state.dailyBest));
}

function applyDifficulty() {
  if (state.score < 90) {
    state.scrollSpeed = BASE_SCROLL_SPEED;
  } else if (state.score < 220) {
    state.scrollSpeed = BASE_SCROLL_SPEED + 70;
  } else {
    state.scrollSpeed = clamp(BASE_SCROLL_SPEED + 140 + state.score * 0.14, BASE_SCROLL_SPEED, MAX_SCROLL_SPEED);
  }
}

// Gap sizes per difficulty, measured in grid CELLS. A 1-cell gap is 50px wide;
// the player diameter is 36px (PLAYER_RADIUS * 2), so even the tightest 2-cell
// (100px) opening is comfortably passable.
const GAP_EASY_CELLS = 3; // 150px
const GAP_MEDIUM_CELLS = 2; // 100px
const GAP_HARD_CELLS = 2; // 100px

// Build the two solid wall segments that flank a single horizontal gap, snapped
// to the 9x18 grid. The gap is the guaranteed-safe opening the player steers
// through; because every barrier spans the full width EXCEPT this opening, and
// openings are spaced several rows apart (enough time to re-position), every
// chunk always has a continuous safe path from its top edge to its bottom edge.
//   gapCol    = index (0..GRID_COLS) of the gap's left-most open cell
//   gapCells  = width of the gap in cells
//   row       = grid row (0..GRID_ROWS) of the barrier's top edge
//   rowsTall  = barrier thickness in cells (default 1 = 50px)
function gridBarrier(gapCol, gapCells, row, rowsTall = 1) {
  const y = row * CELL;
  const h = rowsTall * CELL;
  const parts = [];
  if (gapCol > 0) {
    parts.push({ x: 0, y, width: gapCol * CELL, height: h });
  }
  const rightCol = gapCol + gapCells;
  if (rightCol < GRID_COLS) {
    parts.push({ x: rightCol * CELL, y, width: (GRID_COLS - rightCol) * CELL, height: h });
  }
  return parts;
}

// Deterministically choose a gap's left-most cell so the opening always stays
// fully on the grid. Uses the daily seeded RNG so the sequence is identical
// for every player worldwide.
function pickGapCol(rng, gapCells) {
  return Math.floor(rng() * (GRID_COLS - gapCells + 1));
}

// Each chunk is a modular 450x900 slice. Layouts are visually distinct but all
// built from guaranteed-passable grid gaps so the "safe entrance and exit" rule
// always holds. Barrier rows are chosen across the 18-row height so successive
// gates are far enough apart to weave between at any scroll speed.
function buildChunk(type, rng) {
  let obstacles = [];

  switch (type) {
    case "corridor": {
      // EASY: a single wide gate near the middle — lots of reaction time.
      obstacles = gridBarrier(pickGapCol(rng, GAP_EASY_CELLS), GAP_EASY_CELLS, 8);
      break;
    }
    case "columns": {
      // MEDIUM: two staggered gates you must line up in sequence.
      obstacles = [
        ...gridBarrier(pickGapCol(rng, GAP_MEDIUM_CELLS), GAP_MEDIUM_CELLS, 4),
        ...gridBarrier(pickGapCol(rng, GAP_MEDIUM_CELLS), GAP_MEDIUM_CELLS, 12),
      ];
      break;
    }
    case "maze": {
      // HARD: three tight gates spread top-to-bottom for a fast weaving path.
      obstacles = [
        ...gridBarrier(pickGapCol(rng, GAP_HARD_CELLS), GAP_HARD_CELLS, 2),
        ...gridBarrier(pickGapCol(rng, GAP_HARD_CELLS), GAP_HARD_CELLS, 8),
        ...gridBarrier(pickGapCol(rng, GAP_HARD_CELLS), GAP_HARD_CELLS, 14),
      ];
      break;
    }
    case "moving": {
      // MEDIUM/HARD: a sliding gate. Both wall segments drift in unison (same
      // amplitude/speed/phase) so the opening slides side to side but never
      // closes — the gap width is constant, guaranteeing it stays passable.
      const gapW = GAP_MEDIUM_CELLS * CELL;
      const leftW = VIEW_WIDTH / 2 - gapW / 2; // left segment spans [0, leftW]
      const rightX = VIEW_WIDTH / 2 + gapW / 2; // right segment starts here
      const y = 8 * CELL;
      const drift = { drift: true, amplitude: 92, speed: 1.6, phase: 0.4 };
      obstacles = [
        { x: 0, baseX: 0, y, width: leftW, height: CELL, ...drift },
        { x: rightX, baseX: rightX, y, width: VIEW_WIDTH - rightX, height: CELL, ...drift },
      ];
      break;
    }
    default:
      break;
  }

  return obstacles.map((obstacle) => ({
    ...obstacle,
    revealedAt: null,
    visibleAlpha: 0,
  }));
}

function getNextChunkType() {
  const roll = state.seedRng();
  const tier = state.score < 90 ? 0 : state.score < 220 ? 1 : 2;
  const pools = [
    ["corridor", "corridor", "columns"],
    ["columns", "moving", "corridor"],
    ["maze", "moving", "columns"],
  ];
  const pool = pools[tier];
  return pool[Math.floor(roll * pool.length)];
}

function spawnChunk() {
  const type = getNextChunkType();
  const chunk = {
    y: state.nextChunkY,
    height: CHUNK_HEIGHT,
    type,
    obstacles: buildChunk(type, state.seedRng),
  };
  state.chunks.push(chunk);
  state.nextChunkY += CHUNK_HEIGHT;
}

// Keep enough chunks queued above the top of the screen that the downward
// scroll never reveals empty space before the next chunk streams in.
function primeChunks() {
  while (state.nextChunkY - state.cameraY < VIEW_HEIGHT + CHUNK_HEIGHT) {
    spawnChunk();
  }
}

function triggerSonar() {
  state.waves.push({
    x: state.player.x,
    y: state.player.y,
    radius: 10,
    maxRadius: 220,
    createdAt: performance.now(),
  });
}

function updatePlayer(dt) {
  state.player.x += (state.player.targetX - state.player.x) * 0.2;
  state.player.x = clamp(state.player.x, PLAYER_RADIUS + 8, VIEW_WIDTH - PLAYER_RADIUS - 8);

  for (const wave of state.waves) {
    const age = performance.now() - wave.createdAt;
    wave.radius = 10 + (age / 1000) * (state.scrollSpeed + 160);
  }

  state.waves = state.waves.filter((wave) => wave.radius < wave.maxRadius + 20);
}

function updateChunks(dt) {
  state.cameraY += state.scrollSpeed * dt;
  state.score = Math.floor(state.cameraY / 12);

  applyDifficulty();
  scoreText.textContent = String(state.score);

  if (state.score > state.dailyBest) {
    state.dailyBest = state.score;
    bestText.textContent = String(state.dailyBest);
    dailyBestText.textContent = String(state.dailyBest);
    saveDailyBest(getTodayKey());
  }

  for (const chunk of state.chunks) {
    for (const obstacle of chunk.obstacles) {
      if (obstacle.drift) {
        const driftTime = performance.now() * 0.001;
        obstacle.x = obstacle.baseX + Math.sin(driftTime * obstacle.speed + obstacle.phase) * obstacle.amplitude;
      }
    }
  }

  // Stream new chunks in above the screen as the camera advances downward...
  while (state.nextChunkY - state.cameraY < VIEW_HEIGHT + CHUNK_HEIGHT) {
    spawnChunk();
  }

  // ...and retire chunks once they have fully scrolled off the bottom edge.
  while (state.chunks.length > 0 && state.chunks[0].y < state.cameraY - VIEW_HEIGHT) {
    state.chunks.shift();
  }
}

function revealIntersectingObstacles(wave) {
  const now = performance.now();
  for (const chunk of state.chunks) {
    for (const obstacle of chunk.obstacles) {
      const rectX = obstacle.x;
      const rectY = state.cameraY - chunk.y + obstacle.y;
      const rectW = obstacle.width;
      const rectH = obstacle.height;
      const closestX = clamp(wave.x, rectX, rectX + rectW);
      const closestY = clamp(wave.y, rectY, rectY + rectH);
      const dx = wave.x - closestX;
      const dy = wave.y - closestY;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared <= wave.radius * wave.radius) {
        obstacle.revealedAt = now;
        obstacle.visibleAlpha = 1;
      }
    }
  }
}

function checkPlayerCollisions() {
  const player = state.player;
  const now = performance.now();

  for (const chunk of state.chunks) {
    for (const obstacle of chunk.obstacles) {
      const rectY = state.cameraY - chunk.y + obstacle.y;
      const rectX = obstacle.x;
      const rectW = obstacle.width;
      const rectH = obstacle.height;

      const nearestX = clamp(player.x, rectX, rectX + rectW);
      const nearestY = clamp(player.y, rectY, rectY + rectH);
      const dx = player.x - nearestX;
      const dy = player.y - nearestY;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared <= PLAYER_RADIUS * PLAYER_RADIUS) {
        // Obstacles are solid whether or not they've been revealed — the sonar
        // is for seeing ahead, not a shield. Flash the wall that killed you so
        // the game-over moment reads clearly, then end the run.
        obstacle.revealedAt = now;
        obstacle.visibleAlpha = 1;
        endGame();
        return;
      }
    }
  }
}

function endGame() {
  if (state.mode !== "playing") {
    return;
  }

  state.mode = "over";
  gameOverOverlay.classList.remove("hidden");
  startOverlay.classList.add("hidden");
  gameOverSummary.textContent = `You survived ${state.score} meters and reached ${state.dailyBest} on your daily best.`;
  nicknameInput.value = "";
  nicknameInput.placeholder = "Anonymous";
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const todayKey = getTodayKey();
  const { rows, ok } = await fetchLeaderboard(todayKey, 10);
  leaderboardList.innerHTML = "";

  if (!ok || !rows.length) {
    const emptyItem = document.createElement("li");
    emptyItem.textContent = isSupabaseConfigured()
      ? "No scores yet today."
      : "No scores yet today (local board — add Supabase keys for a global board).";
    leaderboardList.appendChild(emptyItem);
    return;
  }

  rows.forEach((entry, index) => {
    const item = document.createElement("li");
    item.textContent = `${index + 1}. ${entry.nickname || "Anonymous"} — ${entry.score}`;
    leaderboardList.appendChild(item);
  });
}

async function submitCurrentScore() {
  const nickname = nicknameInput.value.trim() || "Anonymous";
  const result = await submitScore({
    nickname,
    score: state.score,
    date: getTodayKey(),
    seed: state.seed,
  });

  if (result.ok) {
    gameOverSummary.textContent = `Saved ${nickname}'s score of ${state.score}.`;
    await refreshLeaderboard();
  } else {
    gameOverSummary.textContent = `Could not save score: ${result.error?.message || "Unknown error"}`;
  }
}

function resetGame() {
  state.mode = "playing";
  state.score = 0;
  state.cameraY = 0;
  state.scrollSpeed = BASE_SCROLL_SPEED;
  state.player.x = VIEW_WIDTH / 2;
  state.player.targetX = VIEW_WIDTH / 2;
  state.player.y = PLAYER_Y;
  state.chunks = [];
  state.waves = [];
  state.lastTime = 0;
  state.nextChunkY = 0;
  state.seed = getDailySeed();
  state.seedRng = createSeededRng(state.seed);
  primeChunks();
  startOverlay.classList.add("hidden");
  gameOverOverlay.classList.add("hidden");
  scoreText.textContent = "0";
  bestText.textContent = String(state.dailyBest);
  dailyBestText.textContent = String(state.dailyBest);
}

function showStartScreen() {
  state.mode = "start";
  startOverlay.classList.remove("hidden");
  gameOverOverlay.classList.add("hidden");
  scoreText.textContent = "0";
  bestText.textContent = String(state.dailyBest);
  dailyBestText.textContent = String(state.dailyBest);
}

function drawBackground() {
  ctx.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

  const bgGradient = ctx.createRadialGradient(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.25, 60, VIEW_WIDTH / 2, VIEW_HEIGHT * 0.25, 400);
  bgGradient.addColorStop(0, "rgba(26, 60, 114, 0.45)");
  bgGradient.addColorStop(1, "rgba(1, 5, 16, 0)");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let y = 0; y < VIEW_HEIGHT; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(VIEW_WIDTH, y);
    ctx.stroke();
  }
}

function drawPlayer() {
  ctx.save();
  ctx.shadowBlur = 18;
  ctx.shadowColor = "#5df3ff";
  ctx.fillStyle = "#56f4ff";
  ctx.beginPath();
  ctx.arc(state.player.x, state.player.y, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWaves() {
  for (const wave of state.waves) {
    const alpha = 1 - Math.min(1, wave.radius / wave.maxRadius);
    ctx.strokeStyle = `rgba(48, 229, 255, ${0.3 + alpha * 0.4})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawChunks() {
  // Each chunk is drawn as a modular vertical slice in world space.
  // Obstacles are rendered relative to the camera so the game feels like a smooth endless scroll.
  for (const chunk of state.chunks) {
    // screenTop maps a chunk's world position into screen space. cameraY grows
    // over time, so a fixed chunk's screenTop increases => it scrolls DOWNWARD.
    const screenTop = state.cameraY - chunk.y;
    if (screenTop > VIEW_HEIGHT + CHUNK_HEIGHT || screenTop < -CHUNK_HEIGHT) {
      continue;
    }

    for (const obstacle of chunk.obstacles) {
      const obstacleY = screenTop + obstacle.y;
      const alpha = obstacle.revealedAt === null ? 0 : Math.max(0, 1 - (performance.now() - obstacle.revealedAt) / REVEAL_DURATION_MS);

      if (alpha <= 0) {
        obstacle.revealedAt = null;
        obstacle.visibleAlpha = 0;
        continue;
      }

      // This is the sonar alpha-fading logic. A hit on a hidden obstacle marks it as revealed,
      // and the fade-out smoothly returns it to darkness over two seconds.
      obstacle.visibleAlpha = alpha;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 77, 77, ${alpha})`;
      ctx.lineWidth = 2.4;
      ctx.strokeRect(obstacle.x, obstacleY, obstacle.width, obstacle.height);
      ctx.restore();
    }
  }
}

function render() {
  drawBackground();
  drawChunks();
  drawWaves();
  drawPlayer();
}

function gameLoop(timestamp) {
  if (!state.lastTime) {
    state.lastTime = timestamp;
  }
  const delta = (timestamp - state.lastTime) / 1000;
  state.lastTime = timestamp;

  if (state.mode === "playing") {
    updatePlayer(delta);
    updateChunks(delta);
    for (const wave of state.waves) {
      revealIntersectingObstacles(wave);
    }
    checkPlayerCollisions();
  }

  render();
  requestAnimationFrame(gameLoop);
}

function setupInput() {
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    state.activePointer = true;
    const point = getPointerPosition(event);
    state.player.targetX = point.x;
    triggerSonar();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.activePointer) {
      return;
    }
    event.preventDefault();
    const point = getPointerPosition(event);
    state.player.targetX = point.x;
    triggerSonar();
  });

  canvas.addEventListener("pointerup", () => {
    state.activePointer = false;
  });

  canvas.addEventListener("pointerleave", () => {
    state.activePointer = false;
  });
}

function getPointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = VIEW_WIDTH / rect.width;
  const scaleY = VIEW_HEIGHT / rect.height;
  return {
    x: clamp((event.clientX - rect.left) * scaleX, 0, VIEW_WIDTH),
    y: clamp((event.clientY - rect.top) * scaleY, 0, VIEW_HEIGHT),
  };
}

function bindButtons() {
  startButton.addEventListener("click", () => {
    resetGame();
  });

  restartButton.addEventListener("click", () => {
    resetGame();
  });

  submitScoreButton.addEventListener("click", () => {
    submitCurrentScore();
  });
}

function initialize() {
  versionTag.textContent = VERSION;
  loadDailyBest(getTodayKey());
  setupInput();
  bindButtons();
  showStartScreen();
  requestAnimationFrame(gameLoop);
}

initialize();
