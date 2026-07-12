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
} from "./supabase.js";

const el = (id) => document.getElementById(id);

export const Menu = {
  user: null, // current auth user (or null), so the game can gate score submits

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

    this.mode = "login";
    this._setMode("login");

    this.tabLogin.addEventListener("click", () => this._setMode("login"));
    this.tabSignup.addEventListener("click", () => this._setMode("signup"));
    this.submit.addEventListener("click", () => this._onSubmit());
    this.logout.addEventListener("click", () => this._onLogout());

    if (!isSupabaseConfigured()) {
      this.msg.textContent = "Accounts offline — add Supabase keys to config.js.";
      this.submit.disabled = true;
    }

    // React to any future login/logout, then sync the initial state.
    onAuthChange((user) => this._syncUser(user));
    this.user = await getCurrentUser();
    this._syncUser(this.user);
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
      dist.textContent = `${Math.round(row.distance)}m`;
      li.append(name, dist);
      this.list.appendChild(li);
    });
  },
};
