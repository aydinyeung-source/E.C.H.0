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
    this.email = el("authEmail");
    this.password = el("authPassword");
    this.username = el("authUsername");
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
    this.username.classList.toggle("hidden", !signup);
    this.submit.textContent = signup ? "Create account" : "Log in";
    this.msg.textContent = "";
  },

  async _onSubmit() {
    if (this.submit.disabled) return;
    const email = this.email.value.trim();
    const password = this.password.value;
    const username = this.username.value.trim();
    if (!email || !password || (this.mode === "signup" && !username)) {
      this.msg.textContent = "Fill in all fields.";
      return;
    }

    this.submit.disabled = true;
    this.msg.textContent = "…";
    const res = this.mode === "signup"
      ? await signUp({ email, password, username })
      : await signIn({ email, password });
    this.submit.disabled = false;

    if (!res.ok) {
      this.msg.textContent = res.error?.message || "Something went wrong.";
      return;
    }
    if (this.mode === "signup" && !res.session) {
      // Email confirmation is on: no session yet.
      this.msg.textContent = "Account created — confirm via email, then log in.";
      this._setMode("login");
      return;
    }
    this.msg.textContent = "";
    // _syncUser runs via onAuthChange, but call it directly too for immediacy.
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
