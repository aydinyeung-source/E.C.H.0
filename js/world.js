// world.js
// -----------------------------------------------------------------------------
import { installReveal } from "./reveal.js";

// -----------------------------------------------------------------------------
// Chunk-based, infinite Backrooms generator.
//
// The world is an endless grid of CELLs. CELLs are grouped into square CHUNKs
// that stream in and out around the player, so geometry only ever exists near
// them. Everything is decided by a deterministic hash of the cell coordinates,
// which means:
//   * the maze is identical on every visit (no state stored),
//   * it is seamless across chunk borders (each cell owns exactly its own walls),
//   * chunks can be discarded and rebuilt on demand with no visible seams.
//
// Each chunk contains, kept intentionally simple per the liminal-horror brief:
//   * walls   - one InstancedMesh of yellow boxes (cheap: 1 draw call/chunk)
//   * floor   - a single yellow plane
//   * ceiling - a single yellow plane
//   * lights  - a grid of EMISSIVE fluorescent panels (they glow but cast no
//               light; the world stays black until the green sonar reveals it,
//               with ~14% burnt out for uncanny gaps in the ceiling grid)
// -----------------------------------------------------------------------------

export const CELL = 6;   // cell size / hallway width (world units)
export const WALL_H = 3.2; // wall + ceiling height (low and oppressive)
export const WALL_T = 0.3; // wall thickness
// The maze is CARVED, not sprinkled: every chunk starts fully walled and a
// depth-first search tunnels passages through it. Sprinkling walls onto an open
// grid (the old approach) left most cells wide open — which is exactly what
// killed the liminal, boxed-in feeling.
//
// STRAIGHT_BIAS is the chance the carver keeps going in the same direction,
// which is what produces long unbroken corridors instead of a twisty warren.
// DOOR_PROB opens doorways along chunk borders so chunks connect (each border
// edge is decided by a pure hash, so both neighbouring chunks always agree).
const STRAIGHT_BIAS = 0.85;
const DOOR_PROB = 0.3;
const BLOOD_CHANCE = 0.03; // fraction of individual walls that carry bloody writing

// BROKEN WINDOWS. Each wall independently has this chance of being smashed out:
// two posts, a lintel, and a waist-high SILL with a hole above it.
//
// It is a HOLE IN A WALL, not a doorway. You do not walk through it — you have to
// get your body over the sill, and the game vaults you automatically the moment
// you push into one (see player.js). The entities cannot follow: they're blocked
// by the sill, and their pathfinder won't even consider the wall.
//
// It's a hail mary. Dive through a window and whatever is chasing you has to go
// the long way round — but it can still SEE you through the hole the whole time.
//
// Note this is a per-wall roll with no cap, so a corridor might have two windows
// or none — and yes, there is a vanishingly small but real chance that every wall
// in a given maze is windowed. That's intentional; the odds are the odds.
const WINDOW_CHANCE = 0.07;
const WINDOW_OPEN = 0.5;   // fraction of the wall that's the gap
const WINDOW_SILL = 0.95;  // height of the sill you have to clear
const WINDOW_H = 2.2;      // top of the opening (lintel sits above it)

// Loot lying in the world, rolled PER CELL in TWO stages:
//   1. Does this cell hold anything at all? CELL_LOOT_CHANCE says yes 5% of the
//      time. A chunk is 36 cells, so that's ~1.8 items per 36x36m chunk — things
//      scattered about, the way they would be in a building people fled.
//   2. If it does, WHAT is it? A weighted pick: meat is the everyday scrap you
//      live on, a torch is a lucky find, a crucifix is the rare prize.
//
// Splitting it this way (a spawn gate, then a type roll) keeps the two knobs
// independent: CELL_LOOT_CHANCE controls how MUCH loot there is, and the weights
// control the MIX, without either one dragging the other around.
const CELL_LOOT_CHANCE = 0.05;
// Weights must sum to 1. Order = the order they're tested against the roll.
const LOOT_WEIGHTS = [
  ["meat", 0.75],     // ~1.35 / chunk
  ["torch", 0.20],    // ~0.36 / chunk
  ["crucifix", 0.05], // ~0.09 / chunk — one every ~11 chunks; the panic item stays rare
];
const CHUNK_CELLS = 6;   // cells per chunk edge (bigger = longer unbroken halls)
const CHUNK_SIZE = CELL * CHUNK_CELLS;
// Chunks are 6x6 cells (36u). At radius 1 the WORST case — standing at a chunk's
// edge — leaves only 36u of world built in front of you, which was fine when the
// fog blacked everything out at ~35u but is not fine now that you can see 60u.
// See further than the world exists and you get to watch corridors end in void.
//
// Radius 2 guarantees at least 72u of built world in every direction, which
// covers the fog with room to spare. It costs: 25 live chunks instead of 9, so
// roughly 2.8x the geometry. That's the price of the view, and it's an honest
// trade — these chunks are a handful of InstancedMeshes each.
const CHUNK_RADIUS = 2;  // chunks kept live around the player (per axis)

const COL_WALL = 0xd8c840;  // backrooms wall yellow
const COL_FLOOR = 0xb8a63a; // grimy carpet yellow
const COL_CEIL = 0xcabf6a;  // ceiling-tile yellow
const COL_LIGHT = 0xfff6df; // warm fluorescent white
const COL_DEAD = 0x0b0b09;  // burnt-out panel (near black)

export const SPAWN = new THREE.Vector3(CELL * 0.5, 1.7, CELL * 0.5);

// Reusable scratch objects so per-chunk builds don't churn the garbage collector.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _xAxis = new THREE.Vector3(1, 0, 0);

// Grime levels for the wall variants: pristine -> filthy, picked PER WALL.
// Index 0 is unnaturally clean — an untouched wall in a rotting hallway is its
// own kind of wrong. Each variant draws its own random blotches, so no two wall
// types share a stain pattern.
const WALL_GRIME_LEVELS = [0.0, 0.1, 0.3, 0.55, 0.8, 1.0];
// How often each variant appears (sums to 1). Clean walls show up often enough
// to be unsettling; filthy is still the norm.
const WALL_VARIANT_WEIGHTS = [0.14, 0.16, 0.24, 0.22, 0.16, 0.08];

// The world seed (Minecraft-style): the same seed always produces the same
// maze, a different seed a completely different one. Set before a run starts.
let SEED = 0;
const carveCache = new Map();    // chunk key -> Set of edges the maze tunnelled
const cellOpenCache = new Map(); // cell key -> Set of edges forced open (or null)
const roomCache = new Map();     // chunk key -> safe-room descriptor (or null)

export function setWorldSeed(seed) {
  SEED = seed >>> 0;
  carveCache.clear(); // layouts depend on the seed
  cellOpenCache.clear();
  roomCache.clear();
}

// --- Procedural textures ----------------------------------------------------
// Drawn once on a <canvas> so there are no external image assets. Walls come in
// grimy variants (some with bloody writing) for an uncanny, detailed look; the
// sonar reveals them out of the dark.
// `grime` (0..1) drives how filthy the wall is. At 0 you get an unnaturally
// clean, pristine wall — which reads as deeply wrong next to a filthy one. Every
// variant draws its own random blotches, so no two walls share a stain pattern.
function makeWallTexture(grime, kind) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");

  g.fillStyle = "#c9b83a"; // base wallpaper yellow
  g.fillRect(0, 0, 256, 256);

  // Faint vertical wallpaper stripes (always present, even when clean).
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = (x / 16) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)";
    g.fillRect(x, 0, 8, 256);
  }
  // Grime speckle, scaled by filthiness.
  const speckles = Math.floor(2600 * grime);
  for (let i = 0; i < speckles; i++) {
    g.fillStyle = `rgba(40,30,0,${Math.random() * 0.09})`;
    const s = Math.random() * 3;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // Dark water stains, also scaled by filthiness.
  const stains = Math.round(18 * grime);
  for (let i = 0; i < stains; i++) {
    const rx = Math.random() * 256, ry = Math.random() * 256, rr = 10 + Math.random() * 42;
    const grd = g.createRadialGradient(rx, ry, 0, rx, ry, rr);
    grd.addColorStop(0, "rgba(28,20,0,0.38)");
    grd.addColorStop(1, "rgba(28,20,0,0)");
    g.fillStyle = grd;
    g.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
  }
  // Wainscot line.
  g.fillStyle = "rgba(0,0,0,0.22)";
  g.fillRect(0, 200, 256, 5);

  // Bloody scrawl (only on the dedicated blood material).
  if (kind === "blood") {
    const words = ["GET OUT", "NO EXIT", "TURN BACK", "IT SEES YOU"];
    const word = words[Math.floor(Math.random() * words.length)];
    g.save();
    g.translate(22, 112);
    g.rotate(-0.08);
    g.fillStyle = "rgba(120,0,0,0.92)";
    g.font = "bold 40px Georgia, serif";
    g.fillText(word, 0, 0);
    for (let i = 0; i < 28; i++) {
      const dx = Math.random() * 210;
      g.fillRect(dx, 6, 2, Math.random() * 48); // drips
    }
    g.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}

// --- Safe-room surfaces ------------------------------------------------------
// Inside a safe room NOTHING is yellow. It is bare poured concrete and steel
// plate — a service space, built by people who meant it to hold, dropped into the
// middle of a rotting hotel corridor. Crossing the threshold should feel like
// stepping into a different building, because that contrast is the entire promise
// the room is making you.
function makeConcreteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");

  g.fillStyle = "#5a5e60";
  g.fillRect(0, 0, 256, 256);

  // Aggregate speckle.
  for (let i = 0; i < 4200; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(0,0,0,${Math.random() * 0.12})` : `rgba(255,255,255,${Math.random() * 0.08})`;
    const s = Math.random() * 2.4;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // Form-work seams: the lines left by the boards the concrete was poured against.
  g.strokeStyle = "rgba(0,0,0,0.22)";
  g.lineWidth = 2;
  for (let y = 42; y < 256; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  // Tie-rod holes.
  for (let y = 42; y < 256; y += 64) {
    for (let x = 32; x < 256; x += 64) {
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Damp patches creeping up from the bottom.
  for (let i = 0; i < 5; i++) {
    const rx = Math.random() * 256;
    const rr = 20 + Math.random() * 50;
    const grd = g.createRadialGradient(rx, 256, 0, rx, 256, rr);
    grd.addColorStop(0, "rgba(20,26,24,0.5)");
    grd.addColorStop(1, "rgba(20,26,24,0)");
    g.fillStyle = grd;
    g.fillRect(rx - rr, 256 - rr, rr * 2, rr);
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Steel diamond plate for the room's floor — the tread pattern reads instantly as
// "industrial" and it catches the torch beam beautifully.
function makeTreadTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");

  g.fillStyle = "#4a4f54";
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
  }

  // Raised diamonds, drawn as a lit edge over a dark one so they read as 3D.
  const draw = (ox, oy) => {
    for (let x = 8; x < 128; x += 32) {
      for (let y = 8; y < 128; y += 32) {
        g.save();
        g.translate(x + ox, y + oy);
        g.rotate(((x + y) % 64 ? 1 : -1) * 0.6);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(-9, -3, 18, 6);
        g.fillStyle = "rgba(190,200,210,0.22)";
        g.fillRect(-9, -3, 18, 3);
        g.restore();
      }
    }
  };
  draw(0, 0);
  draw(16, 16);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

function makeFloorTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#a89a34";
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
  }
  for (let i = 0; i < 6; i++) {
    const rx = Math.random() * 128, ry = Math.random() * 128, rr = 8 + Math.random() * 22;
    const grd = g.createRadialGradient(rx, ry, 0, rx, ry, rr);
    grd.addColorStop(0, "rgba(20,15,0,0.3)");
    grd.addColorStop(1, "rgba(20,15,0,0)");
    g.fillStyle = grd;
    g.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(CHUNK_CELLS, CHUNK_CELLS);
  return t;
}

// Deterministic hashes, folding in the world seed so the layout is unique per
// seed yet identical for everyone using that seed.
function hashInt(x, y, salt) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + salt * 2654435761 + SEED * 40503;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash2(x, y, salt) {
  return hashInt(x, y, salt) / 4294967296;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The edges around spawn cell (0,0) are forced open so the player never starts
// walled in. type 0 = horizontal (south) edge, type 1 = vertical (west) edge.
function isSpawnEdge(type, i, j) {
  if (type === 0) return i === 0 && (j === 0 || j === 1);
  return j === 0 && (i === 0 || i === 1);
}

// The edge id separating two adjacent cells.
function edgeBetween(i1, j1, i2, j2) {
  if (i2 === i1 + 1) return "1:" + i2 + ":" + j1; // west edge of the right cell
  if (i2 === i1 - 1) return "1:" + i1 + ":" + j1; // west edge of this cell
  if (j2 === j1 + 1) return "0:" + i1 + ":" + j2; // south edge of the far cell
  return "0:" + i1 + ":" + j1;                    // south edge of this cell
}

// Carve a maze through one chunk: depth-first search from its corner, tunnelling
// through walls. The STRAIGHT_BIAS makes the carver prefer to keep heading the
// same way, which is what turns a twisty warren into long hallways.
function chunkCarved(cx, cy) {
  const key = cx + ":" + cy;
  const cached = carveCache.get(key);
  if (cached) return cached;

  const rng = mulberry32(hashInt(cx, cy, 7717));
  const i0 = cx * CHUNK_CELLS;
  const j0 = cy * CHUNK_CELLS;
  const carved = new Set();
  const visited = new Set([i0 + "," + j0]);
  const stack = [{ i: i0, j: j0, dir: null }];

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = [];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = cur.i + di;
      const nj = cur.j + dj;
      if (ni < i0 || ni >= i0 + CHUNK_CELLS || nj < j0 || nj >= j0 + CHUNK_CELLS) continue;
      if (visited.has(ni + "," + nj)) continue;
      options.push([di, dj, ni, nj]);
    }
    if (!options.length) {
      stack.pop();
      continue;
    }

    let pick = null;
    if (cur.dir) {
      const straight = options.find((o) => o[0] === cur.dir[0] && o[1] === cur.dir[1]);
      if (straight && rng() < STRAIGHT_BIAS) pick = straight; // keep the hall going
    }
    if (!pick) pick = options[Math.floor(rng() * options.length)];

    const [di, dj, ni, nj] = pick;
    carved.add(edgeBetween(cur.i, cur.j, ni, nj));
    visited.add(ni + "," + nj);
    stack.push({ i: ni, j: nj, dir: [di, dj] });
  }

  if (carveCache.size > 200) carveCache.clear(); // bound memory
  carveCache.set(key, carved);
  return carved;
}

function rawWall(type, i, j) {
  if (isSpawnEdge(type, i, j)) return false;

  // Which two cells does this edge separate?
  const bi = type === 0 ? i : i - 1;
  const bj = type === 0 ? j - 1 : j;
  const ca = { cx: Math.floor(i / CHUNK_CELLS), cy: Math.floor(j / CHUNK_CELLS) };
  const cb = { cx: Math.floor(bi / CHUNK_CELLS), cy: Math.floor(bj / CHUNK_CELLS) };

  if (ca.cx === cb.cx && ca.cy === cb.cy) {
    // Internal to one chunk: solid unless the maze carved through it.
    return !chunkCarved(ca.cx, ca.cy).has(type + ":" + i + ":" + j);
  }
  // Chunk border: solid unless it's a doorway. A pure hash of the edge, so both
  // chunks sharing it always reach the same answer.
  return hash2(i, j, type === 0 ? 311 : 411) >= DOOR_PROB;
}

// NO DEAD ENDS: every cell is guaranteed at least TWO open edges, so you can
// always walk through it rather than being funnelled into a pocket you have to
// back out of. (A dead end is by definition a cell with only one exit; a sealed
// cell has none.) If a cell has fewer than two openings we deterministically
// knock out however many walls it takes. This only ever REMOVES walls, so a
// neighbour's opening count can never be reduced by someone else's fix — the
// result is stable and both chunks sharing a border edge always agree.
function cellOpenings(i, j) {
  const key = i + "," + j;
  const cached = cellOpenCache.get(key);
  if (cached !== undefined) return cached;

  const edges = [
    ["0:" + i + ":" + j, rawWall(0, i, j)],             // south
    ["0:" + i + ":" + (j + 1), rawWall(0, i, j + 1)],   // north
    ["1:" + i + ":" + j, rawWall(1, i, j)],             // west
    ["1:" + (i + 1) + ":" + j, rawWall(1, i + 1, j)],   // east
  ];
  const walled = edges.filter((e) => e[1]).map((e) => e[0]);
  const need = 2 - (4 - walled.length); // how many more openings we must carve

  let result = null;
  if (need > 0 && walled.length > 0) {
    result = new Set();
    const start = Math.floor(hash2(i, j, 999) * walled.length);
    for (let k = 0; k < need && k < walled.length; k++) {
      result.add(walled[(start + k) % walled.length]);
    }
  }

  if (cellOpenCache.size > 4000) cellOpenCache.clear(); // bound memory
  cellOpenCache.set(key, result);
  return result;
}

function wallPresent(type, i, j) {
  // A safe room's shell overrides the maze entirely — the carver may not tunnel
  // through it and the dead-end fixer may not knock it out. This check comes
  // FIRST for exactly that reason.
  const room = roomEdge(type, i, j);
  if (room === "solid") return true;
  if (room) return false; // "open" (inside the room) or "door" (the door fills it)

  if (!rawWall(type, i, j)) return false;
  const id = type + ":" + i + ":" + j;
  // Each edge borders two cells; if EITHER of them needs this edge as one of its
  // guaranteed openings, the wall comes out.
  const own = cellOpenings(i, j);
  if (own && own.has(id)) return false;
  const neighbour = type === 0 ? cellOpenings(i, j - 1) : cellOpenings(i - 1, j);
  if (neighbour && neighbour.has(id)) return false;
  return true;
}

// Is this wall smashed out into a window? Deterministic per wall.
//
// NEVER on a safe room's shell. That isn't cosmetic — a window in a safe-room
// wall is a hole you could vault straight through, which would let you skip the
// switch, skip the serial, skip the door, and walk into the reward. The room's
// one-way-in guarantee IS the mechanic, and this is where it's enforced.
function isWindow(type, i, j) {
  if (roomEdge(type, i, j)) return false;
  return hash2(i, j, type === 0 ? 611 : 711) < WINDOW_CHANCE;
}

// A wall that is present AND smashed out. The safe rooms use it to avoid bolting
// a KeySwitch onto a wall with a hole in it — you'd be able to see and reach the
// lever from the wrong side, and it looks broken.
export function isWindowWall(type, i, j) {
  return wallPresent(type, i, j) && isWindow(type, i, j);
}

// -----------------------------------------------------------------------------
// SAFE ROOMS
//
// 8% of chunks hold one instead of pure hallway: a sealed 2x2-cell room with a
// heavy door, a terminal, a locker and a vent. The room is part of
// the MAZE, not a decoration bolted on top — its walls are real walls, so the
// carver, the collision, the sightlines and the pathfinder all agree about it.
//
// NO TWO ADJACENT CHUNKS may both hold one — not even diagonally — or you'd get a
// bunker district. The rule is decided with no global state: a chunk that rolls a
// room checks its 8 neighbours, and if a neighbour ALSO rolled one and outranks it
// on a hash, this chunk yields. Any two adjacent contenders compare the same two
// ranks and reach the same verdict, so the result is consistent no matter which
// chunk you ask first — which matters, because chunks are generated in whatever
// order you happen to walk.
//
// ROOM_CHANCE IS THE ROLL, NOT THE OUTCOME, and the gap between the two is the
// whole point of this comment. The exclusion above rejects a lot of winners, so
// the realised density is always well below the roll, and it SATURATES:
//
//     roll 0.08  ->   6.2% of chunks
//     roll 0.125 ->   7.9%
//     roll 0.22  ->  10.1%
//     roll 0.60  ->  11.2%   <-- the setting. essentially the ceiling.
//     roll 1.00  ->  11.1%
//
// (Measured, not derived — a sweep over 3 seeds x 2025 chunks each.)
//
// ~11.1% is the CEILING and the number is not a coincidence: turn the roll up to
// 1 and EVERY chunk is a contender, so a room lands exactly where a chunk
// out-ranks all 8 of its neighbours — which is one chunk in nine. The strict
// no-adjacent rule mathematically cannot do better than one room per 3x3
// neighbourhood, no matter what you set this to.
//
// Sitting at 0.60 rather than 1.0 keeps the knob meaningful (turn it down and you
// get fewer rooms) while giving up nothing: the last 0.4 buys ~0.1%.
//
// The room sits at cell offset 1..3 inside the 6x6 chunk. That's deliberate: it
// guarantees every one of its perimeter edges belongs to THIS chunk, so a room
// can never reach across a chunk border and fight with a neighbour's maze.
// -----------------------------------------------------------------------------
const ROOM_CHANCE = 0.6; // the ROLL. yields ~11% of chunks — see above.
const ROOM_OFF_MIN = 1;
const ROOM_OFF_MAX = 3;

function roomRolled(cx, cy) {
  return hash2(cx, cy, 5150) < ROOM_CHANCE;
}

// Returns the safe-room descriptor for a chunk, or null. Cached.
export function chunkRoom(cx, cy) {
  const key = cx + ":" + cy;
  const cached = roomCache.get(key);
  if (cached !== undefined) return cached;

  let room = null;
  if (roomRolled(cx, cy)) {
    const mine = hashInt(cx, cy, 5151);
    let beaten = false;
    for (let dx = -1; dx <= 1 && !beaten; dx++) {
      for (let dy = -1; dy <= 1 && !beaten; dy++) {
        if (!dx && !dy) continue;
        if (!roomRolled(cx + dx, cy + dy)) continue;
        const theirs = hashInt(cx + dx, cy + dy, 5151);
        // Strict rank, with the coordinates themselves as the tie-break, so the
        // comparison is a total order and never says "we both win".
        if (theirs > mine || (theirs === mine && (cx + dx) * 31 + (cy + dy) > cx * 31 + cy)) {
          beaten = true;
        }
      }
    }
    if (!beaten) room = buildRoomSpec(cx, cy);
  }

  if (roomCache.size > 400) roomCache.clear();
  roomCache.set(key, room);
  return room;
}

function buildRoomSpec(cx, cy) {
  const span = ROOM_OFF_MAX - ROOM_OFF_MIN + 1;
  const a = ROOM_OFF_MIN + Math.floor(hash2(cx, cy, 5152) * span);
  const b = ROOM_OFF_MIN + Math.floor(hash2(cx, cy, 5153) * span);
  const ri = cx * CHUNK_CELLS + a; // room's low cell corner, in global cells
  const rj = cy * CHUNK_CELLS + b;

  // THE DOOR CODE. Ten digits, stencilled on the door itself, in the paint.
  //
  // The keypad sits on the wall right beside it — and the memory game survives that
  // anyway, because using the keypad puts a full-screen panel in front of you. The
  // instant you start typing you can no longer see the door. So it is still: read
  // it, hold it, enter it blind. You just don't have to go on a scavenger hunt to
  // find the thing that eats it.
  //
  // Nothing in the game ever tells you this code. It is written on a door, in the
  // dark, and reading it is your job.
  let code = "";
  for (let k = 0; k < 10; k++) code += Math.floor(hash2(cx, cy, 5160 + k) * 10);

  // Every edge on the room's shell. `out` is the cell on the OUTSIDE of it,
  // which is where a besieging entity will stand.
  const shell = [
    { type: 1, i: ri, j: rj, side: "W", out: [ri - 1, rj] },
    { type: 1, i: ri, j: rj + 1, side: "W", out: [ri - 1, rj + 1] },
    { type: 1, i: ri + 2, j: rj, side: "E", out: [ri + 2, rj] },
    { type: 1, i: ri + 2, j: rj + 1, side: "E", out: [ri + 2, rj + 1] },
    { type: 0, i: ri, j: rj, side: "S", out: [ri, rj - 1] },
    { type: 0, i: ri + 1, j: rj, side: "S", out: [ri + 1, rj - 1] },
    { type: 0, i: ri, j: rj + 2, side: "N", out: [ri, rj + 2] },
    { type: 0, i: ri + 1, j: rj + 2, side: "N", out: [ri + 1, rj + 2] },
  ];
  const door = shell[Math.floor(hash2(cx, cy, 5155) * shell.length)];

  // THE VENT. A second way out, in the BACK wall — the side opposite the door, as
  // far from the way you came in as the room gets. It's a crawlspace: barred by a
  // grate until you pry it off, and then only you can fit through it.
  //
  // It is a hole in the shell exactly like the doorway is, so the maze must leave
  // that edge alone too and let the safe room supply its own geometry there.
  const opposite = { W: "E", E: "W", N: "S", S: "N" }[door.side];
  const backEdges = shell.filter((e) => e.side === opposite);
  const vent = backEdges[Math.floor(hash2(cx, cy, 5158) * backEdges.length)];

  // The four edges strictly INSIDE the room: these come out, so the 2x2 is one
  // open space rather than four cells.
  const interior = new Set([
    "1:" + (ri + 1) + ":" + rj,
    "1:" + (ri + 1) + ":" + (rj + 1),
    "0:" + ri + ":" + (rj + 1),
    "0:" + (ri + 1) + ":" + (rj + 1),
  ]);

  const doorId = door.type + ":" + door.i + ":" + door.j;
  const ventId = vent.type + ":" + vent.i + ":" + vent.j;
  const perimeter = new Set(shell.map((e) => e.type + ":" + e.i + ":" + e.j));
  // Both openings are holes in the shell. The maze builds no wall at either; the
  // safe room fills them with a door and a grate, and owns their collision.
  perimeter.delete(doorId);
  perimeter.delete(ventId);

  // The keypad goes on the OTHER shell edge on the door's own side — i.e. the
  // stretch of wall immediately beside the doorway, facing the corridor. You cannot
  // stand at the door without it being right there.
  //
  // It cannot go on the door edge itself: the door fills that whole cell, so a
  // keypad there would be floating in the opening. The sibling edge is guaranteed
  // to be a real wall (it's in `perimeter`), and it's guaranteed not to be the vent,
  // because the vent is always on the far side.
  const keypadEdge = shell.find(
    (e) => e.side === door.side && !(e.type === door.type && e.i === door.i && e.j === door.j)
  );

  const edgePos = (e) =>
    e.type === 0
      ? { x: (e.i + 0.5) * CELL, z: e.j * CELL }
      : { x: e.i * CELL, z: (e.j + 0.5) * CELL };

  const doorPos = edgePos(door);
  const ventPos = edgePos(vent);
  const kpPos = edgePos(keypadEdge);

  // Which way is OUT of the room through a given side, as a unit direction on the
  // XZ plane. `dir`, NOT `out` — `out` already means "the cell on the far side of
  // this edge" and overloading it would be a bug waiting to happen.
  const outward = { W: [-1, 0], E: [1, 0], S: [0, -1], N: [0, 1] };

  return {
    key: cx + ":" + cy,
    cx, cy, ri, rj, code,
    door: {
      ...door, id: doorId, x: doorPos.x, z: doorPos.z, horiz: door.type === 0,
      dir: outward[door.side], // which way is the corridor. the keypad lives on this face.
    },
    vent: {
      ...vent, id: ventId, x: ventPos.x, z: ventPos.z, horiz: vent.type === 0,
      dir: outward[vent.side],
      // Where you come out when you crawl, and where they'll gather if you open it.
      outside: { x: (vent.out[0] + 0.5) * CELL, z: (vent.out[1] + 0.5) * CELL },
    },
    keypad: {
      ...keypadEdge, x: kpPos.x, z: kpPos.z, horiz: keypadEdge.type === 0,
      dir: outward[keypadEdge.side],
    },
    // Where a besieger stands: the middle of the cell on the far side of the door.
    outside: { x: (door.out[0] + 0.5) * CELL, z: (door.out[1] + 0.5) * CELL },
    interior,
    perimeter,
    minX: ri * CELL, maxX: (ri + 2) * CELL,
    minZ: rj * CELL, maxZ: (rj + 2) * CELL,
    cxWorld: (ri + 1) * CELL,
    czWorld: (rj + 1) * CELL,
  };
}

// What, if anything, does a safe room say about this edge?
//   "open"    - inside the room; no wall
//   "solid"   - the room's shell; an unbreakable wall the maze may not touch
//   "opening" - the doorway or the vent; no maze wall, the safe room fills it and
//               owns its collision (see saferoom.js _rebuildBounds)
function roomEdge(type, i, j) {
  const cells = type === 0 ? [[i, j], [i, j - 1]] : [[i, j], [i - 1, j]];
  const id = type + ":" + i + ":" + j;
  for (const [ci, cj] of cells) {
    const r = chunkRoom(Math.floor(ci / CHUNK_CELLS), Math.floor(cj / CHUNK_CELLS));
    if (!r) continue;
    if (r.door.id === id || r.vent.id === id) return "opening";
    if (r.perimeter.has(id)) return "solid";
    if (r.interior.has(id)) return "open";
  }
  return null;
}

// What loot is lying in this chunk. Every cell rolls, in two stages: a spawn gate
// (CELL_LOOT_CHANCE), then a weighted type pick (LOOT_WEIGHTS). Deterministic and
// seeded, so the daily challenge puts the same things in the same corridors for
// everyone.
//
// Safe-room cells are skipped. A room has its own reward locked behind its own
// task, and finding a free crucifix on the floor next to it would undercut the
// entire point of going through the door.
export function chunkItems(cx, cy) {
  const items = [];
  const room = chunkRoom(cx, cy);

  for (let di = 0; di < CHUNK_CELLS; di++) {
    for (let dj = 0; dj < CHUNK_CELLS; dj++) {
      const i = cx * CHUNK_CELLS + di;
      const j = cy * CHUNK_CELLS + dj;

      if (room && i >= room.ri && i <= room.ri + 1 && j >= room.rj && j <= room.rj + 1) {
        continue; // inside a safe room — its loot is behind the terminal
      }

      // Stage 1: does anything spawn here at all?
      if (hash2(i, j, 24) >= CELL_LOOT_CHANCE) continue;

      // Stage 2: what is it? A separate hash walks the weight table. Using a
      // DIFFERENT salt from the gate means the type doesn't correlate with whether
      // a cell spawned — the two rolls are genuinely independent.
      let r = hash2(i, j, 25);
      let type = LOOT_WEIGHTS[LOOT_WEIGHTS.length - 1][0];
      for (const [t, w] of LOOT_WEIGHTS) {
        if (r < w) { type = t; break; }
        r -= w;
      }

      // Drop it somewhere RANDOM in the cell, not tidily in the middle. None of
      // this was placed — it was left, dropped, or died here:
      //   * MEAT     — a carcass, half-decayed against a wall. Nobody put it out
      //                for you; you eat it because the alternative is starving.
      //   * CRUCIFIX — left behind by whoever was here before you, for whatever
      //                good it did them.
      //   * TORCH    — the remains of an explorer who didn't make it. You're taking
      //                the light off the dead.
      // So it lies wherever it fell. Spread across ~0.78 of the cell (leaving a
      // margin off the walls so nothing clips into them), X and Z rolled
      // independently. Every cell is walkable (the maze carves passages, it never
      // seals a cell), so anywhere in it is reachable.
      const ox = (hash2(i, j, 121) - 0.5) * CELL * 0.78;
      const oz = (hash2(i, j, 221) - 0.5) * CELL * 0.78;
      items.push({
        id: `${type}:${i}:${j}`, // stable id, so a collected item stays collected
        type,
        x: (i + 0.5) * CELL + ox,
        z: (j + 0.5) * CELL + oz,
      });
    }
  }
  return items;
}

// Exposed so the safe rooms can find a real wall to bolt their KeySwitch onto.
export function isWall(type, i, j) {
  return wallPresent(type, i, j);
}

// Deterministic per-wall texture variant (weighted), so adjacent walls differ.
function wallVariant(type, i, j) {
  let r = hash2(i, j, type === 0 ? 313 : 414);
  for (let v = 0; v < WALL_VARIANT_WEIGHTS.length; v++) {
    r -= WALL_VARIANT_WEIGHTS[v];
    if (r <= 0) return v;
  }
  return WALL_VARIANT_WEIGHTS.length - 1;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();               // "cx:cy" -> { group, bounds }
    this.playerChunk = { cx: NaN, cy: NaN };

    // Collision that CHANGES at runtime — currently just safe-room doors, which
    // open, shut and get smashed off their hinges. The per-chunk `bounds` are
    // baked at build time and can't express that, so the safe rooms keep their
    // live boxes here and collide()/segmentBlocked() consult both.
    this.extraBounds = [];
    // An extra veto on the entity pathfinder: (type,i,j) => true means "you may
    // not walk through this edge right now". A shut door uses it so besiegers
    // route to the OUTSIDE of the room instead of strolling in.
    this.pathGate = null;

    // Shared geometry/materials keep each chunk lightweight to build and drop.
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    // Wall variants from pristine to filthy. Index 0 is unnaturally clean — an
    // untouched wall in a rotting hallway is its own kind of wrong. Each variant
    // draws its own random blotches, so walls don't repeat the same stain map.
    this.wallMats = WALL_GRIME_LEVELS.map(
      (grime) => new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 0, map: makeWallTexture(grime, "grime") })
    );
    // Rare bloody-writing material, applied to only a scattered few walls so it
    // stays a shock rather than plastering every surface.
    this.bloodMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 0, map: makeWallTexture(0.5, "blood") });
    this.floorMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 0, map: makeFloorTexture() });
    this.ceilMat = new THREE.MeshPhongMaterial({ color: COL_CEIL, shininess: 0 });

    // --- Safe-room surfaces -------------------------------------------------
    // Concrete and steel, and not a trace of yellow.
    //
    // THE ROOM IS LIT. Everywhere else in this game is pitch black until the sonar
    // reveals it — but a safe room has its own emergency lamp, and you should be
    // able to SEE that through the doorway rather than having to ping the inside
    // of your own refuge. `emissiveMap` is the trick: the emissive contribution is
    // multiplied by the texture, so the surfaces glow with their own detail
    // instead of turning into flat coloured cards. The tint is the dull red of the
    // lamp above them.
    const concrete = makeConcreteTexture();
    concrete.repeat.set(2, 1);
    const tread = makeTreadTexture();
    this.roomWallMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 4, map: concrete,
      emissive: 0x6b3a30, emissiveMap: concrete,
    });
    this.roomFloorMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, shininess: 22, map: tread,
      emissive: 0x5e3128, emissiveMap: tread,
    });
    this.roomCeilMat = new THREE.MeshPhongMaterial({
      color: 0x2a2e30, shininess: 0, emissive: 0x2a1512,
    });
    this.roomGeo = new THREE.PlaneGeometry(CELL * 2, CELL * 2); // a room is exactly 2x2 cells
    this.liningGeo = new THREE.BoxGeometry(1, 1, 1);

    // The world is unlit; the sonar rings (reveal.js) are what light surfaces.
    [
      ...this.wallMats, this.bloodMat, this.floorMat, this.ceilMat,
      this.roomWallMat, this.roomFloorMat, this.roomCeilMat,
    ].forEach(installReveal);
    this.tileGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
    this.panelGeo = new THREE.PlaneGeometry(CELL * 0.62, CELL * 0.62);
    // MeshBasicMaterial ignores scene lighting, so panels glow on their own even
    // in the pitch-black world. instanceColor tints each panel lit/dead.
    this.panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  }

  // One wall edge. Normally a single solid box. But ~7% of the time it's a
  // BROKEN WINDOW: two posts and a lintel with a floor-level gap.
  //
  // The trick is that the geometry, the collision and the sightlines all have to
  // agree about what a window is:
  //   * the POSTS are solid to everyone,
  //   * the GAP is tagged `entityOnly` — the player's collision ignores it (you
  //     squeeze through), the entities' collision does not (they're stopped),
  //   * the gap is ALSO ignored by segmentBlocked, so you can see and be seen
  //     and heard through a smashed window — it's a hole, not a mirror,
  //   * and because the wall still "exists" to wallPresent(), the entity
  //     pathfinder won't even try to route through it. It goes the long way.
  _buildWall(type, i, j, list, bounds) {
    const horiz = type === 0;
    const cx = horiz ? (i + 0.5) * CELL : i * CELL;
    const cz = horiz ? j * CELL : (j + 0.5) * CELL;
    const halfT = WALL_T / 2;

    if (!isWindow(type, i, j)) {
      list.push({
        px: cx, py: WALL_H / 2, pz: cz,
        sx: horiz ? CELL : WALL_T,
        sy: WALL_H,
        sz: horiz ? WALL_T : CELL,
      });
      bounds.push(
        horiz
          ? { minX: i * CELL, maxX: (i + 1) * CELL, minZ: cz - halfT, maxZ: cz + halfT }
          : { minX: cx - halfT, maxX: cx + halfT, minZ: j * CELL, maxZ: (j + 1) * CELL }
      );
      return;
    }

    const openW = CELL * WINDOW_OPEN;
    const postW = (CELL - openW) / 2;
    const lintelH = WALL_H - WINDOW_H;

    if (horiz) {
      const x0 = i * CELL;
      const x1 = (i + 1) * CELL;
      list.push({ px: x0 + postW / 2, py: WALL_H / 2, pz: cz, sx: postW, sy: WALL_H, sz: WALL_T });
      list.push({ px: x1 - postW / 2, py: WALL_H / 2, pz: cz, sx: postW, sy: WALL_H, sz: WALL_T });
      list.push({ px: cx, py: WINDOW_H + lintelH / 2, pz: cz, sx: openW, sy: lintelH, sz: WALL_T }); // lintel
      list.push({ px: cx, py: WINDOW_SILL / 2, pz: cz, sx: openW, sy: WINDOW_SILL, sz: WALL_T });    // sill

      bounds.push({ minX: x0, maxX: x0 + postW, minZ: cz - halfT, maxZ: cz + halfT });
      bounds.push({ minX: x1 - postW, maxX: x1, minZ: cz - halfT, maxZ: cz + halfT });
      bounds.push({
        minX: x0 + postW, maxX: x1 - postW, minZ: cz - halfT, maxZ: cz + halfT,
        window: true, // the sill: solid to everyone — but YOU can vault it
      });
    } else {
      const z0 = j * CELL;
      const z1 = (j + 1) * CELL;
      list.push({ px: cx, py: WALL_H / 2, pz: z0 + postW / 2, sx: WALL_T, sy: WALL_H, sz: postW });
      list.push({ px: cx, py: WALL_H / 2, pz: z1 - postW / 2, sx: WALL_T, sy: WALL_H, sz: postW });
      list.push({ px: cx, py: WINDOW_H + lintelH / 2, pz: cz, sx: WALL_T, sy: lintelH, sz: openW });
      list.push({ px: cx, py: WINDOW_SILL / 2, pz: cz, sx: WALL_T, sy: WINDOW_SILL, sz: openW });

      bounds.push({ minX: cx - halfT, maxX: cx + halfT, minZ: z0, maxZ: z0 + postW });
      bounds.push({ minX: cx - halfT, maxX: cx + halfT, minZ: z1 - postW, maxZ: z1 });
      bounds.push({
        minX: cx - halfT, maxX: cx + halfT, minZ: z0 + postW, maxZ: z1 - postW,
        window: true,
      });
    }
  }

  // Build every mesh for one chunk and return its group + collision bounds.
  _buildChunk(cx, cy) {
    const group = new THREE.Group();
    const bounds = [];
    const flickers = []; // panel indices that strobe (see animate())
    const i0 = cx * CHUNK_CELLS;
    const j0 = cy * CHUNK_CELLS;

    // --- Walls: gather present edges. Each wall independently picks a grime
    //     variant (so neighbours don't share a stain pattern, and some come out
    //     unnaturally clean), with a rare few carrying bloody writing instead. ---
    const buckets = this.wallMats.map(() => []); // one instance list per variant
    const bloodInsts = [];
    for (let di = 0; di < CHUNK_CELLS; di++) {
      for (let dj = 0; dj < CHUNK_CELLS; dj++) {
        const i = i0 + di;
        const j = j0 + dj;
        for (const type of [0, 1]) {
          if (!wallPresent(type, i, j)) continue;
          // A safe room's shell walls are ORDINARY walls from the corridor side.
          // They used to be built out of concrete, which meant the hallway outside
          // a room was lined with grey — a dead giveaway, and it broke the
          // liminal yellow the instant a room was anywhere nearby. The concrete
          // now only exists as a LINING on the inside faces (see below), so from
          // the corridor a safe room looks like any other stretch of wall.
          const list =
            hash2(i, j, type === 0 ? 811 : 911) < BLOOD_CHANCE
              ? bloodInsts
              : buckets[wallVariant(type, i, j)];
          this._buildWall(type, i, j, list, bounds);
        }
      }
    }

    // Pack a list of wall instances into one InstancedMesh with the given
    // material. frustumCulled is off because instances live in world space but
    // the mesh's bounding sphere sits at the origin (would wrongly cull chunks).
    const addWalls = (list, material) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(this.boxGeo, material, list.length);
      mesh.frustumCulled = false;
      for (let k = 0; k < list.length; k++) {
        const w = list[k];
        _p.set(w.px, w.py, w.pz);
        _s.set(w.sx, w.sy, w.sz);
        _m.compose(_p, _q.identity(), _s);
        mesh.setMatrixAt(k, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    };
    buckets.forEach((list, v) => addWalls(list, this.wallMats[v]));
    addWalls(bloodInsts, this.bloodMat);

    // --- Floor & ceiling planes ---------------------------------------------
    const centerX = i0 * CELL + CHUNK_SIZE / 2;
    const centerZ = j0 * CELL + CHUNK_SIZE / 2;

    const floor = new THREE.Mesh(this.tileGeo, this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, 0, centerZ);
    group.add(floor);

    const ceil = new THREE.Mesh(this.tileGeo, this.ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(centerX, WALL_H, centerZ);
    group.add(ceil);

    // A safe room gets its own floor, ceiling and wall lining laid over the
    // chunk's, a millimetre proud of them so there's no z-fighting. Step through
    // the door and the grimy yellow carpet becomes steel tread plate under your
    // feet and the wallpaper becomes poured concrete — but ONLY on this side. The
    // corridor outside sees an ordinary wall.
    const room = chunkRoom(cx, cy);
    if (room) {
      const rFloor = new THREE.Mesh(this.roomGeo, this.roomFloorMat);
      rFloor.rotation.x = -Math.PI / 2;
      rFloor.position.set(room.cxWorld, 0.012, room.czWorld);
      group.add(rFloor);

      const rCeil = new THREE.Mesh(this.roomGeo, this.roomCeilMat);
      rCeil.rotation.x = Math.PI / 2;
      rCeil.position.set(room.cxWorld, WALL_H - 0.012, room.czWorld);
      group.add(rCeil);

      // One lining slab per shell wall, sitting just inside it. `perimeter` already
      // excludes the doorway and the vent, so neither opening gets boarded over.
      const inset = WALL_T / 2 + 0.03;
      for (const id of room.perimeter) {
        const [type, i, j] = id.split(":").map(Number);
        const horiz = type === 0;
        const lining = new THREE.Mesh(this.liningGeo, this.roomWallMat);
        if (horiz) {
          // Which way is the room from this wall? South edge => room is at +Z.
          const inward = j === room.rj ? 1 : -1;
          lining.scale.set(CELL, WALL_H, 0.06);
          lining.position.set((i + 0.5) * CELL, WALL_H / 2, j * CELL + inward * inset);
        } else {
          const inward = i === room.ri ? 1 : -1;
          lining.scale.set(0.06, WALL_H, CELL);
          lining.position.set(i * CELL + inward * inset, WALL_H / 2, (j + 0.5) * CELL);
        }
        group.add(lining);
      }
    }

    // --- Fluorescent light panels (one per cell, emissive) ------------------
    _q.setFromAxisAngle(_xAxis, Math.PI / 2); // lay each panel flat, facing down
    const panelMesh = new THREE.InstancedMesh(this.panelGeo, this.panelMat, CHUNK_CELLS * CHUNK_CELLS);
    panelMesh.frustumCulled = false; // same world-space culling caveat as walls
    let k = 0;
    for (let di = 0; di < CHUNK_CELLS; di++) {
      for (let dj = 0; dj < CHUNK_CELLS; dj++) {
        const i = i0 + di;
        const j = j0 + dj;
        _p.set((i + 0.5) * CELL, WALL_H - 0.02, (j + 0.5) * CELL);
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        panelMesh.setMatrixAt(k, _m);
        // A safe room's cells get NO fluorescent panel — the hotel's lighting
        // doesn't reach in there. It has its own emergency lamp instead, which is
        // why the inside of one glows red rather than that sick yellow-white.
        const inRoom =
          room && i >= room.ri && i <= room.ri + 1 && j >= room.rj && j <= room.rj + 1;
        // ~14% burnt out (uncanny gaps); ~20% flicker/strobe; the rest steady.
        const r = hash2(i, j, 303);
        if (inRoom || r < 0.14) {
          panelMesh.setColorAt(k, _c.setHex(COL_DEAD));
        } else {
          panelMesh.setColorAt(k, _c.setHex(COL_LIGHT));
          if (r < 0.34) flickers.push({ index: k, phase: hash2(i, j, 505) * Math.PI * 2 });
        }
        k++;
      }
    }
    panelMesh.instanceMatrix.needsUpdate = true;
    if (panelMesh.instanceColor) panelMesh.instanceColor.needsUpdate = true;
    group.add(panelMesh);

    this.scene.add(group);
    return { group, bounds, panelMesh, flickers };
  }

  // Animate the flickering fluorescent panels. Each flicker panel buzzes with a
  // sine wave plus random dropouts, so the ceiling grid never sits still.
  animate(time) {
    for (const chunk of this.chunks.values()) {
      if (!chunk.flickers || !chunk.flickers.length) continue;
      for (const f of chunk.flickers) {
        let v = 0.72 + 0.28 * Math.sin(time * 11 + f.phase);
        if (Math.random() < 0.05) v = 0.12; // sudden blackout blink
        _c.setHex(COL_LIGHT).multiplyScalar(v);
        chunk.panelMesh.setColorAt(f.index, _c);
      }
      chunk.panelMesh.instanceColor.needsUpdate = true;
    }
  }

  // Tear down every live chunk. Call this after changing the seed so the next
  // update() rebuilds the world fresh from the new seed.
  reset() {
    for (const chunk of this.chunks.values()) {
      this.scene.remove(chunk.group);
      chunk.group.traverse((obj) => {
        if (obj.isInstancedMesh) obj.dispose();
      });
    }
    this.chunks.clear();
    this.playerChunk = { cx: NaN, cy: NaN };
  }

  // Stream chunks in/out whenever the player crosses a chunk boundary.
  update(playerPos) {
    const cx = Math.floor(playerPos.x / CHUNK_SIZE);
    const cy = Math.floor(playerPos.z / CHUNK_SIZE);
    if (cx === this.playerChunk.cx && cy === this.playerChunk.cy) return;
    this.playerChunk = { cx, cy };

    const needed = new Set();
    for (let x = cx - CHUNK_RADIUS; x <= cx + CHUNK_RADIUS; x++) {
      for (let y = cy - CHUNK_RADIUS; y <= cy + CHUNK_RADIUS; y++) {
        const key = `${x}:${y}`;
        needed.add(key);
        if (!this.chunks.has(key)) this.chunks.set(key, this._buildChunk(x, y));
      }
    }
    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        this.scene.remove(chunk.group);
        chunk.group.traverse((obj) => {
          if (obj.isInstancedMesh) obj.dispose(); // frees per-instance buffers only
        });
        this.chunks.delete(key);
      }
    }
  }

  // Grid A* across the cell maze, so entities can walk AROUND walls instead of
  // through them. Returns an array of {x,z} waypoints (cell centres) from the
  // start cell to the goal, or null if no route was found within the node budget.
  findPath(sx, sz, gx, gz, maxNodes = 600) {
    const si = Math.floor(sx / CELL);
    const sj = Math.floor(sz / CELL);
    const gi = Math.floor(gx / CELL);
    const gj = Math.floor(gz / CELL);
    if (si === gi && sj === gj) return []; // already in the goal cell

    const key = (i, j) => i + "," + j;
    const open = [{ i: si, j: sj, g: 0, f: Math.abs(gi - si) + Math.abs(gj - sj), parent: null }];
    const bestG = new Map([[key(si, sj), 0]]);
    let expanded = 0;

    while (open.length && expanded < maxNodes) {
      let b = 0; // pop the lowest f (the open list stays small)
      for (let k = 1; k < open.length; k++) if (open[k].f < open[b].f) b = k;
      const cur = open.splice(b, 1)[0];
      expanded++;

      if (cur.i === gi && cur.j === gj) {
        const path = [];
        for (let n = cur; n; n = n.parent) {
          path.push({ x: (n.i + 0.5) * CELL, z: (n.j + 0.5) * CELL });
        }
        path.reverse();
        path.shift(); // drop the cell we're already standing in
        return path;
      }

      // A cell's edges: moving +i crosses the west edge of (i+1,j), etc.
      const steps = [
        [cur.i + 1, cur.j, !wallPresent(1, cur.i + 1, cur.j)],
        [cur.i - 1, cur.j, !wallPresent(1, cur.i, cur.j)],
        [cur.i, cur.j + 1, !wallPresent(0, cur.i, cur.j + 1)],
        [cur.i, cur.j - 1, !wallPresent(0, cur.i, cur.j)],
      ];
      const gate = this.pathGate;
      const steps2 = gate
        ? [
            [cur.i + 1, cur.j, steps[0][2] && !gate(1, cur.i + 1, cur.j)],
            [cur.i - 1, cur.j, steps[1][2] && !gate(1, cur.i, cur.j)],
            [cur.i, cur.j + 1, steps[2][2] && !gate(0, cur.i, cur.j + 1)],
            [cur.i, cur.j - 1, steps[3][2] && !gate(0, cur.i, cur.j)],
          ]
        : steps;

      for (const [ni, nj, passable] of steps2) {
        if (!passable) continue;
        const g = cur.g + 1;
        const k = key(ni, nj);
        const prev = bestG.get(k);
        if (prev !== undefined && prev <= g) continue;
        bestG.set(k, g);
        open.push({ i: ni, j: nj, g, f: g + Math.abs(gi - ni) + Math.abs(gj - nj), parent: cur });
      }
    }
    return null; // no route within budget
  }

  // Line-of-sight test on the XZ plane: is any wall between (x1,z1) and (x2,z2)?
  // Standard slab method against each wall's AABB. Used so the sonar/radar only
  // report what the player can actually see, not things around corners.
  segmentBlocked(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    for (const chunk of this.chunks.values()) {
      for (const w of chunk.bounds) {
        if (segHitsBox(x1, z1, dx, dz, w)) return true;
      }
    }
    // Doors: a shut one blocks sight like any wall; an open or smashed one has
    // no box here at all, so you can be seen straight through the doorway.
    for (const w of this.extraBounds) {
      if (segHitsBox(x1, z1, dx, dz, w)) return true;
    }
    return false;
  }

  // Push a circle (the player) out of any wall box it overlaps, on the XZ plane.
  // Relax out of any overlapping walls, iterating until nothing overlaps (or we
  // give up). This MUST settle: it runs every frame even when standing still, so
  // if it never reaches a resting state the player slowly slides along the
  // geometry on their own — which is what made the distance counter creep up
  // while stationary. Wall boxes genuinely overlap at grid intersections, so
  // being pushed by two at once is normal and has to converge.
  // `opts` distinguishes WHO is colliding, because the two pass-through bounds
  // behave differently:
  //   { player: true }   - an open safe-room doorway's ward box is nothing to you
  //                        (you walk through it); to an entity it is a wall.
  //   { vaulting: true } - a window's SILL is solid to you too. It only opens
  //                        while you are actually mid-vault, in the air over it.
  // Entities pass no opts at all, so every bound is solid to them.
  collide(pos, radius, opts = null) {
    const isPlayer = !!(opts && opts.player);
    const vaulting = !!(opts && opts.vaulting);
    for (let iter = 0; iter < 4; iter++) {
      let overlapped = false;
      for (const chunk of this.chunks.values()) {
        for (const w of chunk.bounds) {
          if (pushOutOfBox(pos, radius, w, isPlayer, vaulting)) overlapped = true;
        }
      }
      for (const w of this.extraBounds) {
        if (pushOutOfBox(pos, radius, w, isPlayer, vaulting)) overlapped = true;
      }
      if (!overlapped) return; // settled
    }
  }

  // The nearest thing you have to climb THROUGH within `radius`, or null. That's a
  // smashed window's sill, or an open safe-room vent. player.js uses it to know
  // when to hoist you over one (or duck you into one — see the `crawl` flag).
  //
  // It searches extraBounds as well as the chunks: the vent is a runtime bound
  // owned by the safe room, so a chunks-only search would never find it and
  // walking into an open vent would just bump you off a wall.
  windowNear(x, z, radius) {
    const hit = (w) => {
      if (!w.window) return false;
      const nx = Math.max(w.minX, Math.min(x, w.maxX));
      const nz = Math.max(w.minZ, Math.min(z, w.maxZ));
      const dx = x - nx;
      const dz = z - nz;
      return dx * dx + dz * dz < radius * radius;
    };
    for (const chunk of this.chunks.values()) {
      for (const w of chunk.bounds) if (hit(w)) return w;
    }
    for (const w of this.extraBounds) if (hit(w)) return w;
    return null;
  }
}

// Slab test: does the segment (x1,z1)+(dx,dz) cross this box on the XZ plane?
// A smashed window (or an open doorway's entity ward) is a HOLE: you can see, be
// seen and be heard through it. It only stops bodies, not light or sound. This is
// what makes diving through a window a gamble rather than an escape — it still
// has eyes on you the whole time, it just can't follow.
function segHitsBox(x1, z1, dx, dz, w) {
  if (w.entityOnly || w.window) return false;

  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x1 < w.minX || x1 > w.maxX) return false;
  } else {
    let t1 = (w.minX - x1) / dx;
    let t2 = (w.maxX - x1) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z1 < w.minZ || z1 > w.maxZ) return false;
  } else {
    let t1 = (w.minZ - z1) / dz;
    let t2 = (w.maxZ - z1) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  return true;
}

// Push a circle out of one box. Returns true if it was overlapping.
function pushOutOfBox(pos, radius, w, isPlayer, vaulting) {
  if (w.entityOnly && isPlayer) return false;      // open doorway: you just walk through
  if (w.window && isPlayer && vaulting) return false; // mid-vault: you're over the sill

  const nx = Math.max(w.minX, Math.min(pos.x, w.maxX));
  const nz = Math.max(w.minZ, Math.min(pos.z, w.maxZ));
  const dx = pos.x - nx;
  const dz = pos.z - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return false;

  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = (radius - d) / d;
    pos.x += dx * push;
    pos.z += dz * push;
  } else {
    // Dead centre inside the box: the push direction is numerically meaningless
    // there, so eject along the SHALLOWEST axis instead. (Skipping this case is
    // what used to leave you stuck inside a wall.)
    const left = pos.x - w.minX;
    const right = w.maxX - pos.x;
    const back = pos.z - w.minZ;
    const front = w.maxZ - pos.z;
    const m = Math.min(left, right, back, front);
    if (m === left) pos.x = w.minX - radius;
    else if (m === right) pos.x = w.maxX + radius;
    else if (m === back) pos.z = w.minZ - radius;
    else pos.z = w.maxZ + radius;
  }
  return true;
}
