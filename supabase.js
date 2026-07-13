// supabase.js
// -----------------------------------------------------------------------------
// Supabase client loader + the game's auth and leaderboard API.
//
// Auth uses Supabase Auth (email + password). A signup also stores a `username`
// in the user's metadata; a DB trigger copies it into a public `profiles` row
// (see supabase/schema.sql). Scores are submitted through the `submit_score`
// RPC, which keeps each player's best distance per daily seed.
//
// If Supabase isn't configured (blank config.js), auth is disabled and the
// leaderboard falls back to a per-device localStorage best so the game still
// runs offline.
// -----------------------------------------------------------------------------

let clientPromise = null;
let clientError = null;

function getConfig() {
  const g = window;
  const url = g.SUPABASE_URL || g.__SUPABASE_URL__ || "";
  const key = g.SUPABASE_ANON_KEY || g.__SUPABASE_ANON_KEY__ || "";
  // Treat un-filled template placeholders as "not configured".
  const isPlaceholder = url.includes("YOUR-PROJECT") || key.startsWith("YOUR-");
  return { url: isPlaceholder ? "" : url, key: isPlaceholder ? "" : key };
}

async function loadClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    try {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm");
      const { url, key } = getConfig();
      if (!url || !key) {
        clientError = new Error("Supabase URL or anon key missing.");
        return null;
      }
      return createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
    } catch (error) {
      clientError = error;
      console.warn("Supabase unavailable; running offline.", error);
      return null;
    }
  })();
  return clientPromise;
}

export function isSupabaseConfigured() {
  const { url, key } = getConfig();
  return Boolean(url && key);
}

function notConfigured() {
  return new Error("Accounts are offline. Add your Supabase keys to config.js.");
}

// --- Auth -------------------------------------------------------------------

// Supabase Auth is email-based, but the game logs in with usernames only. We
// map each username to a stable synthetic email, lowercased. That makes login
// case-insensitive AND enforces case-insensitive uniqueness for free (Supabase
// rejects a duplicate email), while the original-cased username is kept in the
// profile row for display.
function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@echo0.app`;
}

export async function signUp({ username, password }) {
  const client = await loadClient();
  if (!client) return { ok: false, error: notConfigured() };
  const { data, error } = await client.auth.signUp({
    email: usernameToEmail(username),
    password,
    options: { data: { username: username.trim() } }, // original casing -> profile
  });
  return { ok: !error, error, user: data?.user ?? null, session: data?.session ?? null };
}

export async function signIn({ username, password }) {
  const client = await loadClient();
  if (!client) return { ok: false, error: notConfigured() };
  const { data, error } = await client.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });
  return { ok: !error, error, user: data?.user ?? null };
}

export async function signOut() {
  const client = await loadClient();
  if (!client) return { ok: true };
  const { error } = await client.auth.signOut();
  return { ok: !error, error };
}

export async function getCurrentUser() {
  const client = await loadClient();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  const user = data?.user ?? null;
  rememberUser(user); // so an offline score knows whose it is
  return user;
}

// Prefer the profile row's username; fall back to auth metadata if needed.
export async function getUsername() {
  const client = await loadClient();
  if (!client) return null;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return null;
  const { data } = await client.from("profiles").select("username").eq("id", u.user.id).maybeSingle();
  return data?.username ?? u.user.user_metadata?.username ?? null;
}

// Register a callback fired whenever the auth state changes (login/logout).
export async function onAuthChange(callback) {
  const client = await loadClient();
  if (!client) return;
  client.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    rememberUser(user); // keep the offline-queue attribution in step
    callback(user);
  });
}

// --- Leaderboard (distance explored, per daily seed) ------------------------

const LOCAL_KEY = "echo-local-scores";

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {};
  } catch {
    return {};
  }
}

// --- Offline score queue ----------------------------------------------------
// Scores earned with no connection are serialised into localStorage under
// PENDING_KEY and replayed the next time the game boots online.
//
// A queued score records WHO earned it. submit_score() stamps the user from the
// authenticated session, so a score can only be replayed by the same account
// that set it — otherwise a queued run could be silently credited to whoever
// happens to log in next on that device. Scores earned while signed out aren't
// queued at all (there's no one to attribute them to); they still count towards
// the local best.
const PENDING_KEY = "echo-pending-sync";
const LAST_USER_KEY = "echo-last-user";

function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}

function rememberUser(user) {
  if (user) {
    localStorage.setItem(
      LAST_USER_KEY,
      JSON.stringify({ id: user.id, username: user.user_metadata?.username ?? null })
    );
  } else {
    localStorage.removeItem(LAST_USER_KEY);
  }
}

function lastKnownUser() {
  try {
    return JSON.parse(localStorage.getItem(LAST_USER_KEY));
  } catch {
    return null;
  }
}

function recordLocalBest(date, distance) {
  const store = readLocal();
  store[date] = Math.max(store[date] || 0, distance);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
}

function queueScore({ seed, date, distance }) {
  const who = lastKnownUser();
  if (!who?.id) return false; // signed out: nobody to credit it to
  const pending = readPending();
  pending.push({
    seed,
    date,
    distance,
    userId: who.id,
    username: who.username,
    timestamp: new Date().toISOString(),
  });
  writePending(pending);
  return true;
}

export function pendingSyncCount() {
  return readPending().length;
}

// Replay any queued scores. Called at boot and whenever the connection returns.
// Only replays entries belonging to the CURRENTLY signed-in user; anything else
// is left in the queue for its owner to sync later.
export async function flushPendingScores() {
  if (!navigator.onLine) return { ok: false, synced: 0, reason: "offline" };
  const pending = readPending();
  if (!pending.length) return { ok: true, synced: 0 };

  const client = await loadClient();
  if (!client) return { ok: false, synced: 0, reason: "no client" };

  const { data } = await client.auth.getUser();
  const user = data?.user;
  if (!user) return { ok: false, synced: 0, reason: "signed out" };

  const remaining = [];
  let synced = 0;
  for (const item of pending) {
    if (item.userId !== user.id) {
      remaining.push(item); // not ours to submit
      continue;
    }
    const { error } = await client.rpc("submit_score", {
      p_seed: item.seed,
      p_date: item.date,
      p_distance: item.distance,
    });
    if (error) remaining.push(item); // keep it and try again next time
    else synced++;
  }

  writePending(remaining);
  if (synced) console.info(`[E.C.H.0] synced ${synced} offline score(s) to the leaderboard.`);
  return { ok: true, synced, remaining: remaining.length };
}

export async function submitDistance({ seed, date, distance }) {
  recordLocalBest(date, distance); // the local best is always kept

  // Don't even open a socket if the device knows it's offline — queue it.
  if (!navigator.onLine) {
    return { ok: true, queued: queueScore({ seed, date, distance }), offline: true };
  }

  const client = await loadClient();
  if (!client) return { ok: true, local: true }; // no backend configured

  // submit_score is a SECURITY DEFINER function that stamps the user id and
  // username server-side and keeps the greater of the old/new distance.
  const { error } = await client.rpc("submit_score", {
    p_seed: seed,
    p_date: date,
    p_distance: distance,
  });

  // navigator.onLine lies (it only means "has a network interface", not "can
  // reach the internet"), so a failure here still gets queued for retry.
  if (error) return { ok: false, queued: queueScore({ seed, date, distance }), error };
  return { ok: true };
}

export async function fetchDailyLeaderboard(date, limit = 10) {
  const client = await loadClient();
  if (!client) {
    const store = readLocal();
    const best = store[date];
    const rows = best ? [{ username: "You (local)", distance: best }] : [];
    return { ok: true, rows, local: true };
  }
  const { data, error } = await client
    .from("scores")
    .select("username, distance")
    .eq("date", date)
    .order("distance", { ascending: false })
    .limit(limit);
  return { ok: !error, rows: data || [], error };
}
