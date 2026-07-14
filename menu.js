// menu.js
// -----------------------------------------------------------------------------
// Owns the overlay's account UI (login / signup / logout) and the daily
// leaderboard list. Keeps all auth/DOM glue out of the game loop.
// -----------------------------------------------------------------------------

import {
  isSupabaseConfigured,
  signUp,
  signIn,
  signOut,
  getCurrentUser,
  getUsername,
  onAuthChange,
  fetchDailyLeaderboard,
  isSessionValid,
} from "./supabase.js";

// How often a signed-in client asks the server "do I still hold this account?".
// Logging in elsewhere evicts you within this window.
const SESSION_CHECK_MS = 10000;

const el = (id) => document.getElementById(id);

// PLAYTEST IMMUNITY.
// One account — the developer's — can arm an immunity toggle before a run. It is
// a DEVELOPMENT tool, so it comes with a hard condition: an immune run never
// touches the leaderboard. You cannot play god and post a score.
//
// This gate is client-side, which is worth being honest about: anyone determined
// enough could flip the flag in devtools. That's fine, because the flag's only
// power is to SUPPRESS a score submit, never to inflate one. The worst a forger
// can do to the leaderboard with it is keep themselves off it.
const PLAYTEST_USER_ID = "98545950-20b3-4b89-ad72-27cfd1059f8f";

export const Menu = {
  user: null,      // current auth user (or null), so the game can gate score submits
  playtest: false, // is immunity ARMED for the next run?

  get isPlaytester() {
    return this.user?.id === PLAYTEST_USER_ID;
  },

  async init() {
    this.tabLogin = el("tabLogin");
    this.tabSignup = el("tabSignup");
    this.username = el("authUsername");
    this.password = el("authPassword");
    this.confirm = el("authConfirm");
    this.submit = el("authSubmit");
    this.msg = el("authMsg");
    this.forms = el("authForms");
    this.userBox = el("authUserBox");
    this.userLabel = el("authUserLabel");
    this.logout = el("logoutButton");
    this.list = el("leaderboardList");
    this.playtestRow = el("playtestRow");
    this.playtestToggle = el("playtestToggle");
    this.overlay = el("startOverlay");

    this.mode = "login";
    this._setMode("login");

    this.tabLogin.addEventListener("click", () => this._setMode("login"));
    this.tabSignup.addEventListener("click", () => this._setMode("signup"));
    this.submit.addEventListener("click", () => this._onSubmit());
    this.logout.addEventListener("click", () => this._onLogout());
    this.playtestToggle.addEventListener("click", () => {
      if (!this.isPlaytester) return;
      this.playtest = !this.playtest;
      this._renderPlaytest();
    });
    this._renderPlaytest();

    if (!isSupabaseConfigured()) {
      this.msg.textContent = "Accounts offline — add Supabase keys to config.js.";
      this.submit.disabled = true;
    }

    // React to any future login/logout, then sync the initial state.
    onAuthChange((user) => this._syncUser(user));
    this.user = await getCurrentUser();
    await this._syncUser(this.user);

    // One account, one device. Poll rather than push: it needs no realtime
    // channel, it survives a dropped socket, and a ten-second eviction window is
    // indistinguishable from instant for a human being logging in on their phone.
    setInterval(() => this._checkSession(), SESSION_CHECK_MS);
    this._checkSession(); // and immediately, in case we were evicted while away
  },

  // Fired when this device loses the account to another one. game.js sets this to
  // bail out of any run in progress — you cannot be left wandering the maze with
  // a dead session.
  onSessionRevoked: null,

  async _checkSession() {
    if (!this.user) return;
    if (await isSessionValid()) return;

    await signOut();
    await this._syncUser(null);
    this.msg.textContent = "Signed out — this account was used on another device.";
    if (this.onSessionRevoked) this.onSessionRevoked();
  },

  _setMode(mode) {
    this.mode = mode;
    const signup = mode === "signup";
    this.tabLogin.classList.toggle("active", !signup);
    this.tabSignup.classList.toggle("active", signup);
    this.confirm.classList.toggle("hidden", !signup); // confirm password on signup only
    this.submit.textContent = signup ? "Create account" : "Log in";
    this.msg.textContent = "";
  },

  async _onSubmit() {
    if (this.submit.disabled) return;
    const signup = this.mode === "signup";
    const username = this.username.value.trim();
    const password = this.password.value;
    const confirm = this.confirm.value;

    if (!username || !password || (signup && !confirm)) {
      this.msg.textContent = "Fill in all fields.";
      return;
    }
    if (signup) {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        this.msg.textContent = "Username: 3–20 letters, numbers, or _.";
        return;
      }
      if (password.length < 6) {
        this.msg.textContent = "Password must be at least 6 characters.";
        return;
      }
      if (password !== confirm) {
        this.msg.textContent = "Passwords don't match.";
        return;
      }
    }

    this.submit.disabled = true;
    this.msg.textContent = "…";
    const res = signup
      ? await signUp({ username, password })
      : await signIn({ username, password });
    this.submit.disabled = false;

    if (!res.ok) {
      this.msg.textContent = res.error?.message || "Something went wrong.";
      return;
    }
    if (signup && !res.session) {
      // No session means email confirmation is still on in Supabase — it must be
      // OFF for username logins (the synthetic email can't be confirmed).
      this.msg.textContent = "Account created — turn off email confirmation in Supabase, then log in.";
      this._setMode("login");
      return;
    }
    this.msg.textContent = "";
    // _syncUser also runs via onAuthChange, but call it directly for immediacy.
    this._syncUser(res.user || (await getCurrentUser()));
  },

  async _onLogout() {
    await signOut();
    this._syncUser(null);
  },

  async _syncUser(user) {
    this.user = user;
    const loggedIn = Boolean(user);
    this.forms.classList.toggle("hidden", loggedIn);
    this.userBox.classList.toggle("hidden", !loggedIn);
    if (loggedIn) {
      this.userLabel.textContent = (await getUsername()) || user.email || "player";
    }

    // Signed out = the login screen, and nothing else. But ONLY when there is a
    // backend to sign in to: with blank Supabase keys (offline build, no config)
    // accounts are disabled entirely, and gating on a login nobody can perform
    // would lock the player out of their own game forever.
    this.overlay.classList.toggle("signed-out", isSupabaseConfigured() && !loggedIn);
    // Log out (or log in as anyone else) and immunity is gone AND disarmed — it
    // must never survive an account change and quietly suppress someone's score.
    if (!this.isPlaytester) this.playtest = false;
    this._renderPlaytest();
  },

  _renderPlaytest() {
    if (!this.playtestRow) return;
    this.playtestRow.classList.toggle("hidden", !this.isPlaytester);
    this.playtestToggle.classList.toggle("active", this.playtest);
    this.playtestToggle.textContent = this.playtest
      ? "🛡 Playtest immunity: ON"
      : "🛡 Playtest immunity: OFF";
  },

  // Render the daily top 10 for the given date.
  async refreshLeaderboard(date) {
    if (!this.list) return;
    const { rows } = await fetchDailyLeaderboard(date, 10);
    this.list.innerHTML = "";
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No explorers yet today.";
      this.list.appendChild(li);
      return;
    }
    rows.forEach((row, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${i + 1}. ${row.username || "anon"}`;
      const dist = document.createElement("strong");
      dist.textContent = `${Math.round(row.distance)} cells`;
      li.append(name, dist);
      this.list.appendChild(li);
    });
  },
};
