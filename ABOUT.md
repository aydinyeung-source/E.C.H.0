# E.C.H.0 — Complete Game Document

This file is the single source of truth for what E.C.H.0 is. Read it top to
bottom and you'll understand the concept, how it plays, how every system works,
how the code is organised, how to run/host it, and the full version history.

---

## 1. The Concept

**E.C.H.0** is a **3D first-person liminal horror game** that runs entirely in a
web browser. You are lost in an endless, uncanny Backrooms-style maze of yellow
hallways under a low, humming fluorescent ceiling. The world is **pitch black** —
you cannot see anything on your own.

Your only sense is **sonar**. Click, and a pulse of green wavefronts ripples out
from you. Wherever a wave passes, the walls light up green and then **slowly fade
back into darkness over ~15 seconds**, like glow-in-the-dark stars. You navigate
by memory and by pinging the dark.

But you are not alone. **Entities** stalk the halls. They are invisible in the
black — you only see their shape when a sonar wave washes over them — but their
red eyes glow faintly, and you can *hear* their footsteps quicken as they close
in. They move slightly slower than you, so you can outrun them, but stop moving,
hesitate, or get cornered and one will reach you. Contact = death.

The goal is simply to **survive and explore as far as you can**. How deep you get
(your distance from spawn) is your score.

---

## 2. How To Play

- **Open the site** and you land on the home screen.
- **(Optional) Make an account** (top-right) so your daily runs are ranked on the
  global leaderboard. Accounts are username + password only.
- **Pick how to play** (center):
  - **Enter** — play a world from the seed box (or a random one if left blank).
  - **Daily Challenge** — play today's world. Everyone worldwide gets the exact
    same maze each day, and your best distance is ranked on the Daily Top 10.
- Click into the game to lock the mouse, then explore. Press **Esc** to return to
  the menu (this ends the run and submits your daily distance).

### Controls (PC)

| Action | Input |
|---|---|
| Move | **W A S D** (or arrow keys) |
| Look | **Mouse** (just move it — no button needed) |
| Sonar pulse | **Left click** (sends 3 wavefronts) |
| Release cursor / pause | **Esc** |

Right-click does nothing but steer — it will not fire the sonar.

Look sensitivity is adjustable in **Settings** (top-left) and is saved between
sessions.

---

## 3. Core Mechanics In Detail

### Sonar & glow-in-the-dark reveal
The world has **no lights**. Every surface is black until a sonar wavefront
reaches it. Each **left click emits 3 expanding green wavefronts**, staggered
slightly so they ripple outward one after another. When a wavefront's shell
sweeps across a surface, that surface lights to full brightness (showing its
grimy yellow texture, tinted green), then **fades back to black over ~15 seconds**
— a phosphorescent afterglow. Spam the sonar and a whole area stays dimly lit;
stop pinging and everything sinks back into darkness. This is implemented as a
custom shader effect (see `reveal.js`), computed analytically from each wave's
age, so there is no per-surface state to store.

### The Backrooms maze
The world is an **infinite grid** of 6-unit cells, grouped into chunks that
stream in and out around you as you move. Walls are placed by a deterministic
hash of each cell's coordinates, folded with the world **seed** — so the same
seed always produces the exact same maze, seamlessly, forever, without storing
anything. Walls carry procedurally-drawn grimy/stained yellow textures; a rare
~3% of walls have **bloody writing** ("GET OUT", "IT SEES YOU", …) for the
occasional shock. The ceiling is a grid of fluorescent light panels, ~14% of them
burnt out and ~20% flickering/strobing, for that uncanny liminal feel.

### Entities (the threat)
Figures spawn out in the dark (after a short grace period at the start of a run)
and home straight toward you, phasing through walls. They are near-black — only a
sonar wave reveals their shape — but their **red eyes always glow**. They move at
2.5 u/s versus your 3.4 u/s walk, so you can escape by keeping moving, but they
never stop. The number of simultaneous entities grows the further you explore
(up to 5). Touch = death.

### Footsteps
When the nearest entity comes within ~15 units, you hear a low footstep thud.
The closer it gets, the **louder and faster** the footsteps — your audio warning
that something is right behind you. Sounds are synthesised in the browser (Web
Audio), no external files.

### Death & scoring
If an entity reaches you, the run ends on a **"TAKEN"** screen showing how far you
explored, with a **Try Again** button. "Distance explored" = furthest straight-
line distance you reached from the spawn point. For **Daily Challenge** runs, that
best distance is submitted to the global leaderboard when the run ends.

### Seeds & the daily challenge
The **seed** works like Minecraft: type a number and it's used literally; type any
word/phrase and it's hashed into a seed; leave it blank for a random world. The
**Daily Challenge** uses today's UTC date as the seed, so it's identical for every
player in the world on a given day — a fair basis for the daily leaderboard.

### Accounts & leaderboard
Accounts use **Supabase Auth** with **username + password** (no email). Usernames
are case-insensitive for login and uniqueness (log in as `PLAYER`, stay `player`),
but your original casing is preserved for display. The **Daily Top 10** leaderboard
ranks players by distance explored on the current daily seed. If the backend isn't
configured, the game still runs and falls back to a per-device local leaderboard.

---

## 4. Code Architecture

E.C.H.0 is a **static site** — plain HTML/CSS/JavaScript ES modules, no build step.
Three.js is loaded from a CDN as a global. Files:

| File | Responsibility |
|---|---|
| `index.html` | Page structure: canvas, home-screen menu, game-over overlay, HUD. |
| `style.css` | All styling: neon horror theme, home-screen layout, overlays. |
| `game.js` | Entry point. Three.js scene/renderer/loop; wires every subsystem; run control (start/seed/daily), death, distance tracking, footstep scheduling, input. |
| `world.js` | Infinite chunk-based Backrooms generator: walls, floor, ceiling, fluorescent panels (flicker), collision, procedural textures. |
| `player.js` | First-person controls: pointer-lock mouse look + WASD movement with wall collision. |
| `sonar.js` | Advances the 3-per-click sonar wavefronts and feeds the reveal uniforms. |
| `reveal.js` | The shared sonar-reveal shader (glow-in-the-dark afterglow) injected into every visible material. |
| `entities.js` | The stalker entities: spawning, homing, contact/death, nearest-distance tracking. |
| `audio.js` | Web Audio helper; synthesises the footstep sound. |
| `menu.js` | Account UI (login/signup/logout) and the daily leaderboard list. |
| `supabase.js` | Supabase client + auth and leaderboard API, with an offline localStorage fallback. |
| `config.js` | Supabase project URL + public key (blank = offline). |
| `supabase/schema.sql` | Database schema: profiles, scores, RLS, and the secure submit_score RPC. |

---

## 5. Tech & Hosting

- **Rendering:** Three.js (r128) via CDN, WebGL.
- **Backend:** Supabase (Auth + Postgres) for accounts and the leaderboard.
- **Hosting:** Cloudflare Pages, connected to the GitHub repo
  (`github.com/aydinyeung-source/E.C.H.0`). Every push to `main` auto-deploys.
- **Setup to enable accounts/leaderboard:** run `supabase/schema.sql` in the
  Supabase SQL editor, turn OFF "Confirm email" in Supabase Auth, and put the
  project URL + publishable key in `config.js`.

The current build version is always shown in the bottom-right corner in-game.

---

## 6. Version History / Update Log

Semantic versioning: MAJOR.MINOR.PATCH.

### v1.0.0 — Original 2D game ("Echo Drift")
The project began as a **2D top-down endless survival** game for mobile: a glowing
cyan character dodging downward-scrolling hazards, revealing them with a circular
sonar wave, using a daily-seed chunk generator and a Supabase leaderboard. Still
recoverable under the `v1.0.0` git tag.

### v2.0.0 — Pivot to 3D first-person Backrooms horror
Complete genre rewrite to Three.js: first-person controls, an infinite chunk-based
yellow hallway world, a pitch-black scene lit only by a green sonar pulse.

### v2.1.0 — Seeds, daily challenge, sensitivity
Minecraft-style seed input, a Daily Challenge button (UTC-date seed, identical
worldwide), and an adjustable, persisted look-sensitivity slider.

### v2.2.0 — Accounts + daily distance leaderboard
Added Supabase Auth (originally email+password), a profile username, a live
distance HUD, and a Daily Top 10 leaderboard ranked by distance explored.

### v2.2.1 / v2.2.2 — Backend connected & tidied
Connected the live Supabase project via `config.js`; removed the obsolete
2D-era leaderboard SQL in favour of the new schema.

### v2.3.0 — Username-only accounts
Switched auth to **username + password + confirm** (no email), mapped to a hidden
synthetic email so login and uniqueness are case-insensitive while the original
username casing is preserved for display.

### v2.4.0 — The threat & the horror
Added **killer entities** (sonar-revealed stalkers with glowing red eyes that home
in and kill on contact), a **death / game-over** state with Try Again, **flickering
fluorescent lights**, and **procedural creepy wall textures** (grime, stains, and
bloody writing) plus a grimy floor.

### v2.5.0 — Home screen & rarer horror
Rebuilt the start screen into a proper **home-screen menu** (settings top-left,
account top-right, seed + Daily Challenge + leaderboard centered), and made bloody
writing a **rare ~3% of walls** instead of covering whole areas.

### v2.6.0 — Sonar rework, glow-in-the-dark, footsteps
Reworked the sonar so a click sends **3 expanding wavefronts** that ripple surfaces
into view (a shader effect rather than a flood light), added **glow-in-the-dark
persistence** (lit surfaces fade back over ~15 seconds), and added **footstep audio**
that grows louder and faster as an entity closes in.
