-- Echo Drift — leaderboard table + Row Level Security
-- Run this in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- The game connects with the PUBLIC anon key from the browser, so security is
-- enforced entirely by these RLS policies: anyone may read the board and insert
-- their own score, but no one can update or delete existing rows.

-- 1. Table -----------------------------------------------------------------
create table if not exists public.leaderboard (
  id         bigint generated always as identity primary key,
  nickname   text        not null default 'Anonymous',
  score      integer     not null,
  date       date        not null,          -- daily-seed date, e.g. 2026-07-12
  seed       bigint,                         -- deterministic daily seed
  created_at timestamptz not null default now()
);

-- Fast "top N for a given day" lookups (matches the game's query:
-- .eq('date', d).order('score', desc).limit(n)).
create index if not exists leaderboard_date_score_idx
  on public.leaderboard (date, score desc);

-- 2. Row Level Security ----------------------------------------------------
alter table public.leaderboard enable row level security;

-- Anyone (anon) can read the leaderboard.
drop policy if exists "Public read access" on public.leaderboard;
create policy "Public read access"
  on public.leaderboard
  for select
  using (true);

-- Anyone (anon) can submit a score, with light sanity checks. No update/delete
-- policies exist, so those operations are denied for the anon role by default.
drop policy if exists "Public insert access" on public.leaderboard;
create policy "Public insert access"
  on public.leaderboard
  for insert
  with check (
    score >= 0
    and score < 1000000
    and char_length(nickname) between 1 and 24
  );
