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
  return data?.user ?? null;
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
  client.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
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

export async function submitDistance({ seed, date, distance }) {
  const client = await loadClient();
  if (!client) {
    // Offline: keep the best distance per date on this device only.
    const store = readLocal();
    store[date] = Math.max(store[date] || 0, distance);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
    return { ok: true, local: true };
  }
  // submit_score is a SECURITY DEFINER function that stamps the user id and
  // username server-side and keeps the greater of the old/new distance.
  const { error } = await client.rpc("submit_score", {
    p_seed: seed,
    p_date: date,
    p_distance: distance,
  });
  return { ok: !error, error };
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
