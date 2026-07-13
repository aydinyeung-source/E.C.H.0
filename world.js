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

const CELL = 6;          // cell size / hallway width (world units)
const WALL_H = 3.2;      // wall + ceiling height (low and oppressive)
const WALL_T = 0.3;      // wall thickness
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
const CHUNK_CELLS = 6;   // cells per chunk edge (bigger = longer unbroken halls)
const CHUNK_SIZE = CELL * CHUNK_CELLS;
// Chunks are 6x6 cells (36u) now, so a radius of 1 already keeps 36-72u of world
// live in every direction — well past where the fog blacks everything out (~40u).
// Keeping this at 2 would quadruple the geometry for scenery you can never see.
const CHUNK_RADIUS = 1;  // chunks kept live around the player (per axis)

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

export function setWorldSeed(seed) {
  SEED = seed >>> 0;
  carveCache.clear(); // layouts depend on the seed
  cellOpenCache.clear();
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

    // The world is unlit; the sonar rings (reveal.js) are what light surfaces.
    [...this.wallMats, this.bloodMat, this.floorMat, this.ceilMat].forEach(installReveal);
    this.tileGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
    this.panelGeo = new THREE.PlaneGeometry(CELL * 0.62, CELL * 0.62);
    // MeshBasicMaterial ignores scene lighting, so panels glow on their own even
    // in the pitch-black world. instanceColor tints each panel lit/dead.
    this.panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
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
        if (wallPresent(0, i, j)) {
          // South edge: spans x across the cell, thin in z.
          const inst = { px: (i + 0.5) * CELL, pz: j * CELL, sx: CELL, sz: WALL_T };
          if (hash2(i, j, 811) < BLOOD_CHANCE) bloodInsts.push(inst);
          else buckets[wallVariant(0, i, j)].push(inst);
          bounds.push({ minX: i * CELL, maxX: (i + 1) * CELL, minZ: j * CELL - WALL_T / 2, maxZ: j * CELL + WALL_T / 2 });
        }
        if (wallPresent(1, i, j)) {
          // West edge: spans z across the cell, thin in x.
          const inst = { px: i * CELL, pz: (j + 0.5) * CELL, sx: WALL_T, sz: CELL };
          if (hash2(i, j, 911) < BLOOD_CHANCE) bloodInsts.push(inst);
          else buckets[wallVariant(1, i, j)].push(inst);
          bounds.push({ minX: i * CELL - WALL_T / 2, maxX: i * CELL + WALL_T / 2, minZ: j * CELL, maxZ: (j + 1) * CELL });
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
        _p.set(w.px, WALL_H / 2, w.pz);
        _s.set(w.sx, WALL_H, w.sz);
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
        // ~14% burnt out (uncanny gaps); ~20% flicker/strobe; the rest steady.
        const r = hash2(i, j, 303);
        if (r < 0.14) {
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
      for (const [ni, nj, passable] of steps) {
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
        let tmin = 0;
        let tmax = 1;
        let hit = true;

        if (Math.abs(dx) < 1e-9) {
          if (x1 < w.minX || x1 > w.maxX) hit = false;
        } else {
          let t1 = (w.minX - x1) / dx;
          let t2 = (w.maxX - x1) / dx;
          if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
          tmin = Math.max(tmin, t1);
          tmax = Math.min(tmax, t2);
          if (tmin > tmax) hit = false;
        }

        if (hit) {
          if (Math.abs(dz) < 1e-9) {
            if (z1 < w.minZ || z1 > w.maxZ) hit = false;
          } else {
            let t1 = (w.minZ - z1) / dz;
            let t2 = (w.maxZ - z1) / dz;
            if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) hit = false;
          }
        }

        if (hit) return true;
      }
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
  collide(pos, radius) {
    const r2 = radius * radius;
    for (let iter = 0; iter < 4; iter++) {
      let overlapped = false;
      for (const chunk of this.chunks.values()) {
        for (const w of chunk.bounds) {
          const nx = Math.max(w.minX, Math.min(pos.x, w.maxX));
          const nz = Math.max(w.minZ, Math.min(pos.z, w.maxZ));
          const dx = pos.x - nx;
          const dz = pos.z - nz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r2) continue;
          overlapped = true;

          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = (radius - d) / d;
            pos.x += dx * push;
            pos.z += dz * push;
          } else {
            // Dead centre inside the box: the push direction is numerically
            // meaningless there, so eject along the SHALLOWEST axis instead.
            // (The old code just skipped this case, leaving you stuck inside.)
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
        }
      }
      if (!overlapped) return; // settled
    }
  }
}
