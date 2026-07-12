let clientPromise = null;
let clientError = null;

function getConfig() {
  const globalScope = window;
  return {
    url: globalScope.SUPABASE_URL || globalScope.__SUPABASE_URL__ || "",
    key: globalScope.SUPABASE_ANON_KEY || globalScope.__SUPABASE_ANON_KEY__ || "",
  };
}

async function loadClient() {
  if (clientPromise) {
    return clientPromise;
  }

  clientPromise = (async () => {
    try {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm");
      const { url, key } = getConfig();

      if (!url || !key) {
        clientError = new Error("Supabase URL or anonymous key is missing. Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY before playing.");
        return null;
      }

      return createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    } catch (error) {
      clientError = error;
      console.warn("Supabase client unavailable, leaderboard sync skipped.", error);
      return null;
    }
  })();

  return clientPromise;
}

export function isSupabaseConfigured() {
  const { url, key } = getConfig();
  return Boolean(url && key);
}

// ---------------------------------------------------------------------------
// Offline fallback
// When Supabase credentials are absent (e.g. local dev or a static demo), we
// keep the leaderboard fully functional by persisting scores in localStorage.
// The public API is identical, so game.js never needs to know which backend is
// in use — it just gets `{ ok, rows }` either way.
// ---------------------------------------------------------------------------
const LOCAL_KEY = "echo-drift-local-leaderboard";

function readLocalScores() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || [];
  } catch {
    return [];
  }
}

function writeLocalScores(rows) {
  // Cap stored history so localStorage can't grow unbounded.
  localStorage.setItem(LOCAL_KEY, JSON.stringify(rows.slice(0, 200)));
}

export async function submitScore(payload) {
  const row = {
    nickname: payload.nickname || "Anonymous",
    score: payload.score,
    date: payload.date,
    seed: payload.seed,
    created_at: new Date().toISOString(),
  };

  const client = await loadClient();
  if (!client) {
    // Fallback: append to the local board and report success so the UI flows.
    const rows = readLocalScores();
    rows.push(row);
    writeLocalScores(rows);
    return { ok: true, local: true };
  }

  const { error } = await client.from("leaderboard").insert(row);
  return { ok: !error, error };
}

export async function fetchLeaderboard(date, limit = 10) {
  const client = await loadClient();
  if (!client) {
    // Fallback: filter/sort the local board client-side.
    const rows = readLocalScores()
      .filter((row) => row.date === date)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { ok: true, rows, local: true };
  }

  const { data, error } = await client
    .from("leaderboard")
    .select("nickname, score, date, seed")
    .eq("date", date)
    .order("score", { ascending: false })
    .limit(limit);

  return { ok: !error, rows: data || [], error };
}
