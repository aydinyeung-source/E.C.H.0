-- Spectating migration (v2.88.0)
-- The ONLY new pieces needed for leaderboard replays. Safe to run on the live
-- database: it adds one nullable column and replaces two functions. No data is
-- dropped or deleted. (Supabase may still warn because of the `alter` keyword.)
--
-- This is a subset of schema.sql — running the full schema.sql does the same
-- thing. Use whichever you prefer.

-- 1. A column to hold the compact replay of each player's best daily run.
alter table public.scores add column if not exists replay text;

-- 2. Keep the greater distance, and only overwrite the seed WHEN the run actually
--    improved, so the stored seed always matches the stored distance (and replay).
--    On an improvement the old replay is cleared; the client then calls
--    attach_replay() to store the new one.
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
        seed       = case when excluded.distance > public.scores.distance
                          then excluded.seed else public.scores.seed end,
        replay     = case when excluded.distance > public.scores.distance
                          then null else public.scores.replay end,
        created_at = now();
end;
$$;

-- 3. Store the replay for the caller's current best row on p_date.
create or replace function public.attach_replay(p_date date, p_replay text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  update public.scores
    set replay = p_replay
    where user_id = auth.uid() and date = p_date;
end;
$$;
