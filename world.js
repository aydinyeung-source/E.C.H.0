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
const WALL_PROB = 0.5;   // chance a given cell edge carries a wall
const BLOOD_CHANCE = 0.03; // fraction of individual walls that carry bloody writing
const CHUNK_CELLS = 4;   // cells per chunk edge
const CHUNK_SIZE = CELL * CHUNK_CELLS;
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

// The world seed (Minecraft-style): the same seed always produces the same
// maze, a different seed a completely different one. Set before a run starts.
let SEED = 0;
export function setWorldSeed(seed) {
  SEED = seed >>> 0;
}

// --- Procedural textures ----------------------------------------------------
// Drawn once on a <canvas> so there are no external image assets. Walls come in
// grimy variants (some with bloody writing) for an uncanny, detailed look; the
// sonar reveals them out of the dark.
function makeWallTexture(kind, variant) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");

  g.fillStyle = "#c9b83a"; // base wallpaper yellow
  g.fillRect(0, 0, 256, 256);

  // Faint vertical wallpaper stripes.
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = (x / 16) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)";
    g.fillRect(x, 0, 8, 256);
  }
  // Grime speckle.
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = `rgba(40,30,0,${Math.random() * 0.08})`;
    const s = Math.random() * 3;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // Dark water stains (more on the "stain" variant).
  const stains = kind === "stain" ? 16 : 6;
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

  // Bloody scrawl.
  if (kind === "blood") {
    const words = ["GET OUT", "NO EXIT", "TURN BACK", "IT SEES YOU"];
    const word = words[variant % words.length];
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

// Deterministic 2D hash -> [0, 1). Folds in the world seed so the layout is
// unique per seed, yet identical for everyone using that seed.
function hash2(x, y, salt) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + salt * 2654435761 + SEED * 40503;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The edges around spawn cell (0,0) are forced open so the player never starts
// walled in. type 0 = horizontal (south) edge, type 1 = vertical (west) edge.
function isSpawnEdge(type, i, j) {
  if (type === 0) return i === 0 && (j === 0 || j === 1);
  return j === 0 && (i === 0 || i === 1);
}

function wallPresent(type, i, j) {
  if (isSpawnEdge(type, i, j)) return false;
  return hash2(i, j, type === 0 ? 101 : 202) < WALL_PROB;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();               // "cx:cy" -> { group, bounds }
    this.playerChunk = { cx: NaN, cy: NaN };

    // Shared geometry/materials keep each chunk lightweight to build and drop.
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    // Normal (non-bloody) wall variants; a chunk picks one for visual variety.
    this.wallMats = [
      new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeWallTexture("grime", 0) }),
      new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeWallTexture("grime", 1) }),
      new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeWallTexture("stain", 2) }),
    ];
    // Rare bloody-writing material, applied to only a scattered few walls so it
    // stays a shock rather than plastering every surface.
    this.bloodMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeWallTexture("blood", 0) });
    this.floorMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeFloorTexture() });
    this.ceilMat = new THREE.MeshLambertMaterial({ color: COL_CEIL });

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
    const wallMat = this.wallMats[Math.floor(hash2(cx, cy, 777) * this.wallMats.length)];

    // --- Walls: gather present edges, splitting off a rare few for bloody
    //     writing so it's an occasional shock rather than on every wall. ---
    const normalInsts = [];
    const bloodInsts = [];
    for (let di = 0; di < CHUNK_CELLS; di++) {
      for (let dj = 0; dj < CHUNK_CELLS; dj++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (wallPresent(0, i, j)) {
          // South edge: spans x across the cell, thin in z.
          const inst = { px: (i + 0.5) * CELL, pz: j * CELL, sx: CELL, sz: WALL_T };
          (hash2(i, j, 811) < BLOOD_CHANCE ? bloodInsts : normalInsts).push(inst);
          bounds.push({ minX: i * CELL, maxX: (i + 1) * CELL, minZ: j * CELL - WALL_T / 2, maxZ: j * CELL + WALL_T / 2 });
        }
        if (wallPresent(1, i, j)) {
          // West edge: spans z across the cell, thin in x.
          const inst = { px: i * CELL, pz: (j + 0.5) * CELL, sx: WALL_T, sz: CELL };
          (hash2(i, j, 911) < BLOOD_CHANCE ? bloodInsts : normalInsts).push(inst);
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
    addWalls(normalInsts, wallMat);
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

  // Push a circle (the player) out of any wall box it overlaps, on the XZ plane.
  collide(pos, radius) {
    for (const chunk of this.chunks.values()) {
      for (const w of chunk.bounds) {
        const nx = Math.max(w.minX, Math.min(pos.x, w.maxX));
        const nz = Math.max(w.minZ, Math.min(pos.z, w.maxZ));
        const dx = pos.x - nx;
        const dz = pos.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 < radius * radius && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (radius - d) / d;
          pos.x += dx * push;
          pos.z += dz * push;
        }
      }
    }
  }
}
