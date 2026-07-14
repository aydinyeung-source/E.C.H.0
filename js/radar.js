// radar.js
// -----------------------------------------------------------------------------
// Bottom-right sonar radar. The outer wireframe ring is always drawn; the
// interior is solid black until you fire a pulse.
//
// On a pulse we snapshot every wall segment inside the pulse radius (in WORLD
// coordinates) and record when the expanding ring will actually reach each one:
// revealAt = pulseTime + distance / WAVE_SPEED. Each frame those blips are
// re-projected into player-relative space (so the radar rotates with you) and faded
// using the SAME decay as the 3D world: alpha = 1 - age / GLOW_TIME.
//
// EVERYTHING in range is mapped — walls behind walls, walls round corners, all of
// it. The dish is a sonar, not a camera; it tells you the SHAPE of where you are.
// What you can actually see is the reveal ring's job, and the ring does that
// properly in the 3D world. See ping() for why the old line-of-sight filter had to
// go.
// -----------------------------------------------------------------------------

import { GLOW_TIME, WAVE_SPEED } from "./reveal.js";

const RANGE = 42; // world units mapped onto the radar's radius
// Bodies are tracked through walls, but only inside this radius — the dish is a
// short-range proximity sense, not a map of the whole level.
const ENTITY_RANGE = 32;

export class Radar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = canvas.width;
    this.center = this.size / 2;
    this.scale = (this.center - 6) / RANGE; // leave a margin for the ring
    this.blips = [];
  }

  clear() {
    this.blips = [];
  }

  // Snapshot EVERY wall within range of a pulse. `now` is in seconds.
  //
  // No line-of-sight filter. There used to be one — the pulse can't see round
  // corners, so neither could the dish — and it read as a bug, because it is
  // indistinguishable from one: you ping, and half the corridors you KNOW are there
  // simply aren't on the radar. Worse, "in line of sight" and "close enough" are
  // different sets, so the dish would drop a wall you were looking straight past
  // while keeping the one behind it. A radar with holes in it is worse than no
  // radar: you stop trusting it, and then it isn't doing anything.
  //
  // It's a SONAR dish, not a camera. It maps what's around you. What you can SEE is
  // the reveal ring's job, and the ring already does that properly.
  //
  // It also now reads world.extraBounds, so safe-room doors and vents actually show
  // up. They were invisible on the dish before, because they aren't part of any
  // chunk's baked geometry — they're runtime bounds the safe rooms own.
  ping(origin, now, world, entityList) {
    const take = (w) => {
      const cx = (w.minX + w.maxX) / 2;
      const cz = (w.minZ + w.maxZ) / 2;
      const d = Math.hypot(cx - origin.x, cz - origin.z);
      if (d > RANGE) return;

      const revealAt = now + d / WAVE_SPEED;
      // A hole you can get through and they can't — a smashed window, an open vent,
      // an open doorway — comes back a different colour. Spotting one of those on
      // the dish is worth a run.
      const win = !!(w.entityOnly || w.window);
      // Represent the wall box as a line along its long axis.
      if (w.maxX - w.minX >= w.maxZ - w.minZ) {
        this.blips.push({ win, x1: w.minX, z1: cz, x2: w.maxX, z2: cz, revealAt });
      } else {
        this.blips.push({ win, x1: cx, z1: w.minZ, x2: cx, z2: w.maxZ, revealAt });
      }
    };

    for (const chunk of world.chunks.values()) {
      for (const w of chunk.bounds) take(w);
    }
    for (const w of world.extraBounds) take(w);
  }

  // World point -> radar pixel, relative to the player's position and heading
  // (player forward points "up" on the radar).
  _toRadar(wx, wz, p, sin, cos) {
    const dx = wx - p.x;
    const dz = wz - p.z;
    const right = dx * cos - dz * sin;   // local +X
    const fwd = -dx * sin - dz * cos;    // local forward
    return { x: this.center + right * this.scale, y: this.center - fwd * this.scale };
  }

  // `entityList` drives the live threat dots (see below).
  draw(now, playerPos, yaw, entityList = []) {
    const g = this.ctx;
    const S = this.size;
    const C = this.center;

    g.clearRect(0, 0, S, S);
    g.fillStyle = "#000"; // interior defaults to solid black
    g.beginPath();
    g.arc(C, C, C - 2, 0, Math.PI * 2);
    g.fill();

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    // Blips are clipped to the dish.
    g.save();
    g.beginPath();
    g.arc(C, C, C - 3, 0, Math.PI * 2);
    g.clip();

    for (let i = this.blips.length - 1; i >= 0; i--) {
      const b = this.blips[i];
      const age = now - b.revealAt;
      if (age < 0) continue; // the ring hasn't swept over it yet
      const alpha = 1 - age / GLOW_TIME; // identical decay to the world walls
      if (alpha <= 0) {
        this.blips.splice(i, 1);
        continue;
      }
      const p1 = this._toRadar(b.x1, b.z1, playerPos, sin, cos);
      const p2 = this._toRadar(b.x2, b.z2, playerPos, sin, cos);
      // Windows read as a bright cyan gap in the green walls — an escape route.
      g.strokeStyle = b.win
        ? `rgba(90, 220, 255, ${alpha})`
        : `rgba(57, 255, 20, ${alpha * 0.8})`;
      g.lineWidth = b.win ? 2.5 : 1.5;
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);
      g.stroke();
    }

    // Live threat dots. Unlike the walls, these are NOT line-of-sight filtered:
    // the dish picks bodies up through walls. If something is within
    // ENTITY_RANGE it gets a dot, full stop — you always know roughly where they
    // are nearby, and the game is about what you do with that, not about being
    // ambushed by something the radar was hiding from you. Anything further out
    // than ENTITY_RANGE simply isn't picked up.
    //
    // The two states still read differently at a glance:
    //   dim, steady dot  — it's there, but it hasn't seen you
    //   bright, pulsing  — it has EYES ON YOU right now
    for (const e of entityList) {
      const d = Math.hypot(e.x - playerPos.x, e.z - playerPos.z);
      if (d > ENTITY_RANGE) continue;
      const p = this._toRadar(e.x, e.z, playerPos, sin, cos);
      if (e.canSee) {
        const pulse = 0.6 + 0.4 * Math.sin(now * 8);
        g.fillStyle = `rgba(255, 40, 40, ${pulse})`;
        g.beginPath();
        g.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = "rgba(255, 70, 70, 0.42)";
        g.beginPath();
        g.arc(p.x, p.y, 3, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Player marker + heading.
    g.fillStyle = "rgba(150, 255, 180, 0.95)";
    g.beginPath();
    g.arc(C, C, 2.5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(150, 255, 180, 0.6)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(C, C);
    g.lineTo(C, C - 9);
    g.stroke();
    g.restore();

    // Permanent outer wireframe ring.
    g.strokeStyle = "rgba(57, 255, 20, 0.75)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(C, C, C - 2, 0, Math.PI * 2);
    g.stroke();
  }
}
