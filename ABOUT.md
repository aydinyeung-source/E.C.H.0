# E.C.H.0 — Complete Game Document

This file is the single source of truth for what E.C.H.0 is. Read it top to
bottom and you'll understand the concept, how it plays, how every system works,
how the code is organised, how to run/host it, and the full version history.

*Current build: v2.21.0*

---

## 1. The Concept

**E.C.H.0** is a **3D first-person liminal horror game** that runs entirely in a
web browser. You are lost in an endless, uncanny Backrooms-style maze of yellow
corridors under a low, humming fluorescent ceiling. The world is **pitch black** —
you cannot see anything on your own.

Your only sense is **sonar**. Click, and a ring of green light sweeps outward from
you. Wherever it passes, the walls are revealed — and then **slowly fade back into
darkness over 15 seconds**, like glow-in-the-dark stars. You navigate by memory
and by pinging the dark.

But you are not alone, and here is the whole bargain of the game:

> **The sonar is a sound nothing down here has ever made.**

The things in the maze **already live here**. They are wandering their own routes,
minding their own business, and they have no idea you exist. They are not spawned
at you and the world is not reacting to you. But the moment you ping — the moment
you make that alien noise to see where you're going — **everything within earshot
turns toward it**.

**The only way to see is to announce yourself.** That is the game.

The goal is to survive and explore as far as you can. How deep you get (your
distance from spawn) is your score.

---

## 2. How To Play

- Open the site and you land on the home screen.
- **(Optional) Make an account** (top-right) so your daily runs are ranked on the
  global leaderboard. Accounts are username + password only.
- **Pick how to play** (center):
  - **Enter** — play a world from the seed box (or a random one if left blank).
  - **Daily Challenge** — today's world. Everyone worldwide gets the same maze
    each day, and your best distance is ranked on the Daily Top 10.
- Explore. Ping as little as you can get away with. Press **Esc** to pause.

🎧 **Headphones are strongly recommended.** Entities are located by 3D spatial
audio, and walls muffle them. Sound is not decoration here — it's information.

### Controls

| Action | PC | Mobile |
|---|---|---|
| Move | **W A S D** | Left half of the screen (analog stick) |
| Look | **Mouse** (just move it) | Right half of the screen |
| Sonar ping | **Left click** (rebindable) | **PING** button |
| Run (toggle) | **Q** | **RUN** button |
| Select hotbar slot | **1–9** or **scroll wheel** | Tap the slot |
| Use selected item | **F** | **USE** button |
| Pause | **Esc** | Pause button |

Right-click does nothing but steer — it will not fire the sonar.

**Settings** (top-left tab) holds look sensitivity, device mode (PC/Mobile), the
sonar keybind, and the build version.

---

## 3. Core Mechanics

### The sonar (see, and be heard)
The world has **no lights**. Every surface is black until a sonar ring reaches it.
One click sends **one expanding ring**; when it sweeps a surface, that surface
lights to ~50% and then **fades back to black over 15 seconds**. Spam it and an
area stays lit; stop and the dark reclaims everything.

Pinging costs **energy** and, far more importantly, **gives you away**: every
entity within **40m** (how far the sound carries) learns your exact position and
comes for it. That knowledge lasts **3 seconds** — break line of sight and stay
unseen for 3 seconds and they **lose you completely**.

The reveal is a custom shader (`reveal.js`) computed analytically from each ring's
age, so there's no per-surface state to store.

### The inhabitants
They are **already in the maze** when you arrive — wandering their own aimless
routes at an unbothered amble, well beyond sight. They hunt you only once they
know about you, via:

- **Sound** — a sonar ping within **40m** exposes you for **3s**.
- **Sight** — a clear line of sight within **20m** locks onto your real position
  and refreshes for **2s** after you break it.

Lose both and they **forget you and go back to wandering**. They are **solid** (no
phasing): with a sightline they beeline at you, otherwise they **A\*-path around
the maze**. They chase at 6.0 u/s — deliberately **capped below your 7.6 sprint**,
so a running player can always break away — and slow to a stalk within 5m.

Population is 4 (ramping to 7 with distance), placed 30–50m out and 22m apart from
each other, so nothing is ever dropped on top of you or pincers you down one
corridor. Touch = **death** (with a jumpscare).

### Energy, running and food
A stamina bar. **Running (Q)** drains it; **walking slowly regenerates it**; a
sonar ping costs a chunk. At zero you can't run — but the sonar always works, so
you can never softlock yourself blind.

### The hotbar
A Minecraft-style **9-slot hotbar**, stacking to 64. Select with 1–9, the scroll
wheel, or by tapping. **F / USE** is context-sensitive.

| Item | Effect |
|---|---|
| **Meat** | Eat to restore energy. Refuses at full energy so nothing is wasted. |
| **Crucifix** *(rare)* | **The panic button.** For 7 seconds: **blinds every entity in the world** (they can't see, hear, track or catch you — they just grope around), fires a **free reveal**, and grants a **1.45× speed burst**. |
| **Torch** *(rarest)* | A real spotlight cone: reveals a slice of what's ahead, silently. **But shine it directly at something and you ENRAGE it** — it then tracks you *through walls* and never stops to stalk, for 10s. Runs on battery. |
| **Battery** | Recharges the torch. |

You always start a run with **one crucifix and one meat**.

The torch and the sonar are opposites: the sonar shows you *everything* but
announces you; the torch shows you a *narrow slice* in silence — unless you point
it at the wrong thing. And the crucifix will snap an enraged entity out of it.

### The radar
Bottom-right dish. The ring is always drawn; the interior is black. A ping plots
the walls it actually **saw** (line-of-sight only — it can't see round corners),
fading on the exact same 15s curve as the world. Anything **currently watching
you** shows as a live pulsing **red dot**, but only within radar range.

### Sound
- **3D spatial audio (HRTF)** — entities are positioned in real 3D. Walls
  **muffle** them (a lowpass drops to 400Hz when a wall is between you; it snaps
  open to 22kHz the instant they step into your sightline).
- **Footsteps** — dry, deliberate; faster as they close.
- **Heartbeat** — kicks in inside 5m, accelerating to ~128bpm at 1m.
- **Ambience** — dead-air static, a detuned sub-bass drone, and distant creaks.
- The **sonar itself is silent**. You get no audio cue back. Only the reveal.

### Seeds & the daily challenge
Seeds work like Minecraft: a number is used literally, any word is hashed, blank
is random. The **Daily Challenge** uses today's UTC date, so it's identical for
every player worldwide — a fair basis for the leaderboard.

### The maze
An infinite grid of 6-unit cells in 6×6-cell chunks that stream around you. Each
chunk is **fully walled, then a depth-first search carves passages through it**,
with a strong **straight bias** that produces long unbroken corridors. Every cell
is guaranteed **at least two exits**, which mathematically eliminates dead ends —
a corridor never traps you at the end. Verified: 0 dead ends, 100% reachable, halls
up to 174 units long. Walls carry procedurally-drawn textures from pristine to
filthy (picked per wall, so neighbours differ), with rare bloody writing.

### Accounts & leaderboard
**Supabase Auth**, username + password (no email). Usernames are case-insensitive
to log in but keep their original casing for display. The **Daily Top 10** ranks
players by distance explored on the current daily seed. Without a backend the game
still runs and falls back to a per-device local leaderboard.

---

## 4. Code Architecture

A **static site** — plain HTML/CSS/JS ES modules, no build step. Three.js (r128)
is loaded from a CDN as a global.

| File | Responsibility |
|---|---|
| `index.html` | Page structure: canvas, home screen, HUD, overlays. |
| `style.css` | All styling: neon horror theme, hotbar, HUD, overlays. |
| `game.js` | Entry point. Three.js scene/loop; wires every subsystem; run control, energy, hotbar, torch, pause/death, input (PC + touch). |
| `world.js` | Infinite carved maze: chunk streaming, wall generation, collision, line-of-sight raycast, A* pathfinding, procedural textures. |
| `player.js` | First-person controls: pointer-lock/touch look, WASD/analog movement, head bob, wall collision. |
| `sonar.js` | Advances the expanding ring and feeds the reveal uniforms. |
| `reveal.js` | The shared sonar-reveal shader (glow-in-the-dark fade), injected into every visible material. |
| `entities.js` | The inhabitants: wandering, hearing, sight, hunting, A* pathing, enrage/blind states. |
| `pickups.js` | Meat / crucifix / torch / battery on the ground. |
| `radar.js` | The bottom-right radar dish. |
| `audio.js` | Web Audio: HRTF spatial entity voices with wall occlusion, footsteps, heartbeat, ambience, stingers. |
| `menu.js` | Account UI and the daily leaderboard. |
| `supabase.js` | Supabase client + auth/leaderboard API, with an offline fallback. |
| `config.js` | Supabase URL + public key. |
| `supabase/schema.sql` | Database schema: profiles, scores, RLS, submit_score RPC. |

---

## 5. Tech & Hosting

- **Rendering:** Three.js (r128) via CDN, WebGL.
- **Backend:** Supabase (Auth + Postgres).
- **Hosting:** Cloudflare, git-connected to `github.com/aydinyeung-source/E.C.H.0`.
  Every push to `main` auto-deploys.
- **To enable accounts:** run `supabase/schema.sql` in the Supabase SQL editor,
  turn OFF "Confirm email", and put your project URL + publishable key in
  `config.js`.

The build version is shown in the Settings tab and in the bottom-right corner.

---

## 6. Version History

Semantic versioning: MAJOR.MINOR.PATCH.

### v1.0.0 — The original 2D game ("Echo Drift")
Began as a 2D top-down endless survival game: a cyan character dodging
downward-scrolling hazards, revealed by a circular sonar wave, with a daily-seed
chunk generator and a Supabase leaderboard. Still recoverable under the `v1.0.0` tag.

### v2.0.0 — Pivot to 3D first-person Backrooms horror
Complete genre rewrite to Three.js: first-person controls, an infinite chunk-based
yellow hallway world, pitch black but for a green sonar pulse.

### v2.1.0 — Seeds, daily challenge, sensitivity
Minecraft-style seeds, a Daily Challenge (UTC-date seed), an adjustable sensitivity slider.

### v2.2.x — Accounts + daily leaderboard
Supabase Auth, a live distance HUD, and a Daily Top 10 by distance explored.
Connected the live Supabase project.

### v2.3.0 — Username-only accounts
Switched to username + password (no email), case-insensitive to log in while
preserving the original casing for display.

### v2.4.0 — The threat & the horror
Killer entities, a death/game-over state, flickering fluorescent lights, and
procedural creepy wall textures.

### v2.5.0 — Home screen & rarer horror
A proper home-screen menu, and bloody writing reduced to a rare ~3% of walls.

### v2.6.0–v2.6.6 — The sonar saga
Reworked the sonar into a shader-based reveal ring with a glow-in-the-dark fade.
This broke badly (the shader compiled but silently did nothing — the injection was
splicing into a chunk name that doesn't exist in r128), was briefly reverted, then
fixed by injecting at a chunk that definitely exists and writing straight to
`gl_FragColor`. Ended with a 15s fade at ~50% brightness, one ring per click.

### v2.7.0 — Energy, running, stealth, jumpscare, food
Stamina + running, sound-driven entity AI, a jumpscare on death, a pause menu, and
decayed meat to hunt for.

### v2.8.0 — Proximity heartbeat, radar, head-bob
A heartbeat that accelerates as things close in, the fading radar dish, and a
sine-wave camera head bob.

### v2.9.x — Uniform chunks, mobile, LOS radar, trackpad fix
Per-wall grime variety, line-of-sight radar, a PC/Mobile device toggle with touch
controls, and a trackpad camera fix (device auto-detect was wrongly forcing mobile
mode on any touchscreen laptop, so pointer lock was never requested).

### v2.10.0 — Line-of-sight hunting + wall pathfinding
Entities track by sight, keep hunting for 2s after losing it, and **A\*-path around
walls** instead of phasing through them.

### v2.11.0–v2.12.0 — Threat dots, safe start, hotbar
Live red dots for anything watching you, and a Minecraft-style 9-slot hotbar
(stacks to 64, number keys / scroll / tap to select).

### v2.13.x — 3D spatial audio
HRTF panners per entity with **wall occlusion** (lowpass to 400Hz through a wall,
snapping open on a clear sightline), plus energy/chase rebalancing. Shipped silent
at first — the panner's `refDistance` was so small that the exponential rolloff
buried everything past a few metres at −30dB.

### v2.14.0 — Headphones prompt + settings tab
### v2.15.0 — No dead ends, cleaner footsteps, realistic heartbeat, louder audio
Guaranteed ≥2 exits per cell (verified: 0 dead ends over 6400 cells), a dry
articulate footfall, and a heartbeat capped at a human ~128bpm (it had been hitting
200bpm, which read as comical).

### v2.16.0 — Silent sonar + ambient dread
The sonar gives you no audio cue back. Added static, a detuned drone, and creaks.

### v2.17.0 — The carved maze (the liminal feel restored)
The generator had been **sprinkling walls onto an open grid**, which left most
cells wide open — a plaza, not hallways, and no amount of extra walls could fix it.
Rebuilt to **carve** instead: fully walled chunks, tunnelled by DFS with a strong
straight bias. Corridors went 48% → 75%, with halls up to 174 units. Chunks grew to
6×6. Walking now regenerates stamina.

### v2.18.0 — Ping exposure window + crucifix
A ping only exposes you for 3s. Added the crucifix as the first real defence.

### v2.19.x — Torch, batteries, and two real bugs
The torch (reveals a slice, but **enrages** anything you shine it at) and
batteries. Fixed the distance counter drifting while stationary (`collide()`
mutated position mid-iteration with no convergence check, so you slowly slid along
walls). Fixed mobile buttons being dead while moving (phone browsers only
synthesize a `click` for a *single-finger* tap, so a button press with the movement
thumb down never registered — switched to `pointerdown`).

### v2.20.0 — Survivability
The crucifix became a true panic button (**blinds every entity**, free reveal, speed
burst), made rarer, and granted at the start of every run alongside a meat.
Entities spawn far apart; more loot on the ground.

### v2.21.0 — Entities are inhabitants, not a spawn system
The current design. They are no longer spawned at you on a timer — **they already
live here**, wandering their own routes and unaware of you. The sonar is the alien
sound that wakes them. Hearing is bounded (40m), sight is bounded (20m), and they
**forget you** and return to wandering if you break contact. The world is populated;
it does not react to you.
