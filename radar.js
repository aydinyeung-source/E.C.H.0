// radar.js
// -----------------------------------------------------------------------------
// Bottom-right sonar radar. The outer wireframe ring is always drawn; the
// interior is solid black until you fire a pulse.
//
// On a pulse we snapshot every wall segment and entity inside the pulse radius
// (in WORLD coordinates) and record when the expanding ring will actually reach
// each one: revealAt = pulseTime + distance / WAVE_SPEED. Each frame those blips
// are re-projected into player-relative space (so the radar rotates with you) and
// faded using the SAME decay as the 3D world: alpha = 1 - age / GLOW_TIME.
// -----------------------------------------------------------------------------

import { GLOW_TIME, WAVE_SPEED } from "./reveal.js";

const RANGE = 42; // world units mapped onto the radar's radius

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

  // Snapshot walls + entities within range of a pulse, but ONLY those in direct
  // line of sight — the pulse can't see around corners, so neither can the radar.
  // `now` is in seconds.
  ping(origin, now, world, entityList) {
    for (const chunk of world.chunks.values()) {
      for (const w of chunk.bounds) {
        const cx = (w.minX + w.maxX) / 2;
        const cz = (w.minZ + w.maxZ) / 2;
        const d = Math.hypot(cx - origin.x, cz - origin.z);
        if (d > RANGE) continue;

        // Stop the ray just short of the wall, or it would "hit" itself.
        if (d > 0.6) {
          const ux = (cx - origin.x) / d;
          const uz = (cz - origin.z) / d;
          const stop = d - 0.4;
          if (world.segmentBlocked(origin.x, origin.z, origin.x + ux * stop, origin.z + uz * stop)) {
            continue; // hidden behind another wall
          }
        }

        const revealAt = now + d / WAVE_SPEED;
        // Represent the wall box as a line along its long axis.
        if (w.maxX - w.minX >= w.maxZ - w.minZ) {
          this.blips.push({ wall: true, x1: w.minX, z1: cz, x2: w.maxX, z2: cz, revealAt });
        } else {
          this.blips.push({ wall: true, x1: cx, z1: w.minZ, x2: cx, z2: w.maxZ, revealAt });
        }
      }
    }
    for (const e of entityList) {
      const d = Math.hypot(e.x - origin.x, e.z - origin.z);
      if (d > RANGE) continue;
      if (world.segmentBlocked(origin.x, origin.z, e.x, e.z)) continue; // behind a wall
      this.blips.push({ wall: false, x1: e.x, z1: e.z, revealAt: now + d / WAVE_SPEED });
    }
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

  draw(now, playerPos, yaw) {
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
      if (b.wall) {
        const p1 = this._toRadar(b.x1, b.z1, playerPos, sin, cos);
        const p2 = this._toRadar(b.x2, b.z2, playerPos, sin, cos);
        g.strokeStyle = `rgba(57, 255, 20, ${alpha * 0.8})`;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();
      } else {
        const p = this._toRadar(b.x1, b.z1, playerPos, sin, cos);
        g.fillStyle = `rgba(255, 45, 45, ${alpha})`;
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
