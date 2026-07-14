-- E.C.H.0 — accounts + daily distance leaderboard
-- Run this whole file in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Auth itself (email + password, hashing, sessions) is handled by Supabase Auth
-- and lives in the auth.users table automatically. This script adds:
--   * profiles         - one row per user, holding their chosen username
--   * a signup trigger  - copies the username from signup metadata into profiles
--   * scores           - best distance per user per daily seed
--   * submit_score()   - secure RPC the game calls to record a run
--   * Row Level Security so the anon key is safe in the browser
--
-- IMPORTANT: for instant play, turn OFF email confirmation:
--   Authentication -> Sign In / Providers -> Email -> disable "Confirm email".
-- Otherwise new users must click an email link before they can log in.

-- 1. Profiles ---------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text unique not null,
  created_at timestamptz not null default now()
);

-- Auto-create a profile whenever a new auth user signs up, pulling the username
-- they supplied in options.data.username. A duplicate username raises here and
-- rolls the signup back, so the user can retry with a different name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'username', 'player_' || left(new.id::text, 8)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Scores -----------------------------------------------------------------
create table if not exists public.scores (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  seed       bigint not null,
  date       date not null,               -- daily-challenge date (UTC)
  distance   real not null default 0,      -- furthest distance explored, metres
  created_at timestamptz not null default now(),
  unique (user_id, date)                   -- one best row per player per day
);

create index if not exists scores_date_distance_idx
  on public.scores (date, distance desc);

-- 3. Secure submit RPC ------------------------------------------------------
-- The client never sets user_id/username directly; this function stamps them
-- from the authenticated session and keeps the greater of old/new distance.
create or replace function public.submit_score(p_seed bigint, p_date date, p_distance real)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_username text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select username into v_username from public.profiles where id = auth.uid();
  if v_username is null then
    raise exception 'No profile for user';
  end if;

  insert into public.scores (user_id, username, seed, date, distance)
  values (auth.uid(), v_username, p_seed, p_date, p_distance)
  on conflict (user_id, date) do update
    set distance   = greatest(public.scores.distance, excluded.distance),
        seed       = excluded.seed,
        created_at = now();
end;
$$;

-- 4. Single session per account ---------------------------------------------
-- Log in on a second device and the first one is kicked out.
--
-- Supabase Auth happily runs many sessions per user at once, so this is enforced
-- here instead: exactly one row per user recording which device currently holds
-- the account. Logging in CLAIMS the account (overwriting whoever had it); every
-- client re-checks periodically, and the moment it finds a device id that isn't
-- its own, it signs itself out.
--
-- The table has RLS on and NO policies at all, which means the anon key cannot
-- read or write it directly — the only way in is through the two SECURITY
-- DEFINER functions below. That matters: a device id is a bearer token of sorts,
-- and if the table were readable, anyone could look up the current device id of
-- any player and impersonate their session to avoid being kicked.
create table if not exists public.active_sessions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  device_id  text not null,
  claimed_at timestamptz not null default now()
);

-- Take the account for this device, evicting any other. Called on LOGIN ONLY —
-- never on a page refresh, or every reload would steal the account back and two
-- devices would sit in a loop kicking each other forever.
create or replace function public.claim_session(p_device text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.active_sessions (user_id, device_id)
  values (auth.uid(), p_device)
  on conflict (user_id) do update
    set device_id  = excluded.device_id,
        claimed_at = now();
end;
$$;

-- Does this device still hold the account? Anything that has never claimed (an
-- account made before this existed) counts as valid, so nobody is locked out by
-- the upgrade itself.
create or replace function public.session_valid(p_device text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_device text;
begin
  if auth.uid() is null then
    return false;
  end if;

  select device_id into v_device from public.active_sessions where user_id = auth.uid();
  return v_device is null or v_device = p_device;
end;
$$;

alter table public.active_sessions enable row level security;
-- Deliberately no policies. See the note above.

-- 5. Row Level Security -----------------------------------------------------
alter table public.profiles enable row level security;
alter table public.scores enable row level security;

-- Profiles: everyone can read usernames; a user may edit only their own row.
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select using (true);

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

-- Scores: the leaderboard is public to read. Writes go only through
-- submit_score() (SECURITY DEFINER), so no direct insert/update policy is
-- granted to the anon role.
drop policy if exists "scores readable" on public.scores;
create policy "scores readable" on public.scores for select using (true);
