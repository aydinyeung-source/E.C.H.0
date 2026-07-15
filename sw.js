// sw.js — E.C.H.0 service worker (offline / PWA support)
// -----------------------------------------------------------------------------
// NOTE ON WHAT IS ACTUALLY CACHED:
// This game ships NO binary assets. Every wall texture is drawn onto a <canvas>
// at runtime (see makeWallTexture in world.js) and every sound — spatial
// footsteps, the proximity heartbeat, the ambience, the stingers — is synthesised
// in Web Audio (audio.js). There are no .png/.mp3 files to pre-cache, and none
// are invented here. The entire game is a handful of text files plus Three.js,
// which is why it goes offline so cleanly.
//
// STRATEGY
//   * App shell (our own HTML/CSS/JS): NETWORK-FIRST, falling back to cache.
//     This matters because the game deploys constantly — network-first means a
//     player online always gets the newest build instead of a stale cached one,
//     while the cache still guarantees it runs with no connection at all.
//   * Three.js from the CDN: CACHE-FIRST. It's large, versioned and immutable,
//     so re-fetching it every load is pure waste.
//   * Supabase (auth + leaderboard): NEVER intercepted. Those are dynamic,
//     authenticated, cross-origin calls; serving them from a cache would hand
//     back stale or wrong-user data. They fail cleanly offline and the game
//     queues scores locally instead (see supabase.js pendingSync).
// -----------------------------------------------------------------------------

const CACHE_VERSION = "echo-v2.63.0";
const THREE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";

// The complete app shell.
//
// sw.js itself deliberately stays at the ROOT while every module lives in js/. A
// service worker can only control pages at or below its own path, so moving this
// file into js/ would silently shrink its scope to /js/ and it would stop
// controlling the game at all — it'd register fine and then do nothing.
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./icon.svg",
  "./js/config.js",
  "./js/game.js",
  "./js/world.js",
  "./js/player.js",
  "./js/sonar.js",
  "./js/reveal.js",
  "./js/entities.js",
  "./js/pickups.js",
  "./js/saferoom.js",
  "./js/radar.js",
  "./js/audio.js",
  "./js/menu.js",
  "./js/supabase.js",
  // The two small audio clips are precached; the ~9MB movement bed is NOT — it
  // would bloat the install, and the fetch handler caches it on first play anyway,
  // so offline still works after one online session.
  "./audio/sonar.wav",
  "./audio/entity-step.wav",
  THREE_CDN,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // allSettled, NOT addAll: addAll rejects the whole install if a single URL
      // fails (a CDN hiccup would leave the player with no service worker at
      // all). Cache what we can and report what we couldn't.
      const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      const failed = PRECACHE.filter((_, i) => results[i].status === "rejected");
      if (failed.length) console.warn("[E.C.H.0 sw] failed to pre-cache:", failed);
      await self.skipWaiting(); // a new build takes over immediately
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous builds.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GETs are cacheable at all, and we never touch anything else.
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Leave Supabase (and anything else third-party) completely alone.
  if (!sameOrigin && req.url !== THREE_CDN) return;

  // Three.js: cache-first — immutable and big.
  if (req.url === THREE_CDN) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
        return res;
      })()
    );
    return;
  }

  // Our own files: network-first so an online player always gets the latest
  // build, with the cache as the offline safety net.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        // A navigation with nothing cached for it still gets the shell.
        if (req.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        throw new Error("offline and not cached: " + req.url);
      }
    })()
  );
});
