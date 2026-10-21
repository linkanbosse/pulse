-- PULSE – etapp 6: statusar och aktiviteter
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Kräver att etapp3-, etapp4- och etapp5-filerna redan är körda. Filen går att köra igen.
--
-- Vad som sparas (nytt i etapp 6):
--   * statuses: din status ("Ute", "Hemma" eller "Vill hitta på något"), en valfri kort text
--     (högst 40 tecken) och när statusen slutar gälla. Bara en rad per person. Raderas när den
--     har gått ut (högst 24 timmar) eller när du tar bort den.
--   * activities: aktiviteter du skapar: rubrik, valfri plats som TEXT (inga koordinater) och starttid.
--     Raderas 6 timmar efter starttiden, eller direkt när du ställer in.
--   * activity_members: vem som har gått med i vilken aktivitet, och när.
--
-- Säkerhet: ingen kan läsa eller ändra tabellerna direkt (Row Level Security utan regler).
-- Allt går via funktionerna längre ner, som utgår från auth.uid().
--   * Din status ser bara dina vänner (just nu, ingen blockering åt något håll),
--     och ingen alls när osynligt läge är på.
--   * En aktivitet ser bara skaparens vänner. Bara de kan gå med.
--   * Tar ni bort varandra som vänner, eller blockerar, lämnar ni automatiskt varandras aktiviteter.
--   * Deltagare som du har blockerat (eller som har blockerat dig) visas inte för dig.

-- 1. Tabeller -------------------------------------------------------------------------------------

create table if not exists public.statuses (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  kind text not null,
  note text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint statuses_kind_allowed check (kind in ('out', 'home', 'up')),
  constraint statuses_note_length check (note is null or char_length(note) between 1 and 40)
);
create index if not exists statuses_expires_idx on public.statuses (expires_at);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  place text,
  starts_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint activities_title_length check (char_length(title) between 1 and 60),
  constraint activities_place_length check (place is null or char_length(place) between 1 and 60)
);
create index if not exists activities_creator_idx on public.activities (creator_id);
create index if not exists activities_starts_idx on public.activities (starts_at);

create table if not exists public.activity_members (
  activity_id uuid not null references public.activities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (activity_id, user_id)
);
create index if not exists activity_members_user_idx on public.activity_members (user_id);

-- 2. Row Level Security: påslaget, och inga regler = ingen direkt åtkomst alls ------------------

alter table public.statuses enable row level security;
alter table public.activities enable row level security;
alter table public.activity_members enable row level security;

revoke all on public.statuses from anon, authenticated;
revoke all on public.activities from anon, authenticated;
revoke all on public.activity_members from anon, authenticated;

-- 3. Hjälpfunktioner (används bara inne i databasen) -----------------------------------------------

-- Är a och b vänner just nu, utan blockering åt något håll?
create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.friendships
           where user_a = least(p_a, p_b) and user_b = greatest(p_a, p_b)
         )
     and not exists (
           select 1 from public.blocks
           where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
         );
$$;

revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- Har a och b blockerat varandra (åt något håll)?
create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
  );
$$;

revoke execute on function public.is_blocked_between(uuid, uuid) from public, anon, authenticated;

-- Får p_user se (och gå med i) aktiviteten? Skaparen själv, eller en vän till skaparen,
-- och aktiviteten har inte gått ut (6 timmar efter starttiden).
create or replace function public.activity_visible_to(p_activity uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.activities a
    where a.id = p_activity
      and a.starts_at > now() - interval '6 hours'
      and (a.creator_id = p_user or public.are_friends(a.creator_id, p_user))
  );
$$;

revoke execute on function public.activity_visible_to(uuid, uuid) from public, anon, authenticated;

-- 4. När en vänskap tar slut (borttagen vän eller blockering) lämnar ni varandras aktiviteter -------

create or replace function public.friendship_ended_activities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.activity_members m
  using public.activities a
  where m.activity_id = a.id
    and ((a.creator_id = old.user_a and m.user_id = old.user_b)
      or (a.creator_id = old.user_b and m.user_id = old.user_a));
  return old;
end;
$$;

revoke execute on function public.friendship_ended_activities() from public, anon, authenticated;

drop trigger if exists friendships_end_activities on public.friendships;
create trigger friendships_end_activities
  after delete on public.friendships
  for each row execute function public.friendship_ended_activities();

-- 5. Funktioner för status ---------------------------------------------------------------------------
-- Alla kräver inloggning och utgår från auth.uid(), aldrig från ett id som appen skickar om "mig".

-- Sätt din status. p_kind: 'out' (Ute), 'home' (Hemma) eller 'up' (Vill hitta på något).
-- p_note: valfri text, högst 40 tecken. p_minutes: hur länge statusen gäller, 15–1440 (högst 24 h).
create or replace function public.set_my_status(p_kind text, p_note text, p_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('out', 'home', 'up') then
    raise exception 'invalid_status';
  end if;
  if v_note is not null and char_length(v_note) > 40 then
    raise exception 'note_too_long';
  end if;
  if p_minutes is null or p_minutes < 15 or p_minutes > 1440 then
    raise exception 'invalid_duration';
  end if;

  -- Städa bort statusar som har gått ut (även andras), så att inget gammalt ligger kvar.
  delete from public.statuses where expires_at <= now();

  insert into public.statuses (user_id, kind, note, expires_at, updated_at)
  values (v_me, p_kind, v_note, now() + make_interval(mins => p_minutes), now())
  on conflict (user_id) do update
    set kind = excluded.kind, note = excluded.note, expires_at = excluded.expires_at, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.clear_my_status()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.statuses where user_id = auth.uid();
end;
$$;

-- Din egen status. Svar: { kind, note, expires_in_seconds, hidden_by_ghost }.
-- kind är null om du inte har någon status. hidden_by_ghost = true när osynligt läge är på
-- (då ser ingen vän din status).
create or replace function public.get_my_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_row public.statuses;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_row from public.statuses where user_id = v_me and expires_at > now();
  return jsonb_build_object(
    'kind', v_row.kind,
    'note', v_row.note,
    'expires_in_seconds', case when v_row.kind is not null
                            then greatest(0, floor(extract(epoch from v_row.expires_at - now())))::integer end,
    'hidden_by_ghost', coalesce((select ghost from public.location_settings where user_id = v_me), false)
  );
end;
$$;

-- Vännernas statusar. Bara vänner just nu, utan blockering, som inte är osynliga
-- och vars status inte har gått ut. age_seconds = hur länge sedan statusen sattes.
create or replace function public.get_friend_statuses()
returns table (user_id uuid, display_name text, avatar_color text, kind text, note text, age_seconds integer)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select (select auth.uid()) as id)
  select p.id, p.display_name, p.avatar_color, s.kind, s.note,
         greatest(0, floor(extract(epoch from now() - s.updated_at)))::integer
  from public.friendships f
  cross join me
  join public.profiles p on p.id = case when f.user_a = me.id then f.user_b else f.user_a end
  join public.statuses s on s.user_id = p.id and s.expires_at > now()
  left join public.location_settings ls on ls.user_id = p.id
  where me.id in (f.user_a, f.user_b)
    and not coalesce(ls.ghost, false)
    and not public.is_blocked_between(me.id, p.id)
  order by s.updated_at desc;
$$;

-- 6. Funktioner för aktiviteter ----------------------------------------------------------------------

-- Skapa en aktivitet som alla dina vänner ser och kan gå med i. Du går med automatiskt.
-- p_title 1–60 tecken, p_place valfri (högst 60), p_starts_at från en timme sedan till 7 dagar fram.
-- Högst 5 aktiviteter igång samtidigt per person. Svar: aktivitetens id.
create or replace function public.create_activity(p_title text, p_place text, p_starts_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_place text := nullif(btrim(regexp_replace(coalesce(p_place, ''), '\s+', ' ', 'g')), '');
  v_id uuid;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 60 then
    raise exception 'invalid_title';
  end if;
  if v_place is not null and char_length(v_place) > 60 then
    raise exception 'invalid_place';
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '1 hour' or p_starts_at > now() + interval '7 days' then
    raise exception 'invalid_time';
  end if;

  -- Städa bort aktiviteter som har gått ut (även andras).
  delete from public.activities where starts_at <= now() - interval '6 hours';

  if (select count(*) from public.activities where creator_id = v_me) >= 5 then
    raise exception 'too_many_activities';
  end if;

  insert into public.activities (creator_id, title, place, starts_at)
  values (v_me, v_title, v_place, p_starts_at)
  returning id into v_id;
  insert into public.activity_members (activity_id, user_id) values (v_id, v_me);
  return v_id;
end;
$$;

-- Ställ in (radera) en aktivitet du själv har skapat.
create or replace function public.cancel_activity(p_activity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.activities where id = p_activity and creator_id = auth.uid();
  if not found then
    raise exception 'activity_not_found';
  end if;
end;
$$;

-- Gå med i en väns aktivitet. Fungerar bara om du får se den (se activity_visible_to).
-- Finns den inte, eller får du inte se den, blir felet detsamma: activity_not_found.
create or replace function public.join_activity(p_activity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.activity_visible_to(p_activity, v_me) then
    raise exception 'activity_not_found';
  end if;
  if (select count(*) from public.activity_members where activity_id = p_activity) >= 50 then
    raise exception 'activity_full';
  end if;
  insert into public.activity_members (activity_id, user_id) values (p_activity, v_me)
  on conflict do nothing;
end;
$$;

-- Lämna en aktivitet. Den som har skapat aktiviteten ställer in den i stället.
create or replace function public.leave_activity(p_activity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from public.activities where id = p_activity and creator_id = v_me) then
    raise exception 'creator_cannot_leave';
  end if;
  delete from public.activity_members where activity_id = p_activity and user_id = v_me;
end;
$$;

-- Aktiviteter du får se: dina egna och dina vänners, som inte har gått ut.
-- members: deltagarna du får se, som [{ user_id, display_name, avatar_color }].
-- Deltagare som du har blockerat, eller som har blockerat dig, är bortfiltrerade.
-- starts_in_seconds räknas av servern (negativ = har börjat), så att fel klocka i mobilen inte spelar roll.
create or replace function public.list_activities()
returns table (
  id uuid, title text, place text, starts_at timestamptz, starts_in_seconds integer,
  creator_id uuid, creator_name text, creator_color text, is_mine boolean, i_joined boolean, members jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select (select auth.uid()) as id)
  select
    a.id, a.title, a.place, a.starts_at,
    floor(extract(epoch from a.starts_at - now()))::integer,
    a.creator_id, c.display_name, c.avatar_color,
    a.creator_id = me.id,
    exists (select 1 from public.activity_members m where m.activity_id = a.id and m.user_id = me.id),
    coalesce((
      select jsonb_agg(jsonb_build_object('user_id', p.id, 'display_name', p.display_name, 'avatar_color', p.avatar_color)
                       order by m.joined_at)
      from public.activity_members m
      join public.profiles p on p.id = m.user_id
      where m.activity_id = a.id
        and (m.user_id = me.id or not public.is_blocked_between(me.id, m.user_id))
    ), '[]'::jsonb)
  from public.activities a
  cross join me
  join public.profiles c on c.id = a.creator_id
  where me.id is not null
    and a.starts_at > now() - interval '6 hours'
    and (a.creator_id = me.id or public.are_friends(a.creator_id, me.id))
  order by a.starts_at, a.created_at;
$$;

-- 7. Automatisk städning var 15:e minut (pg_cron, samma som i etapp 5) -----------------------------
-- Om pg_cron inte går att slå på hoppas steget över; städningen sker då när någon sätter en status
-- eller skapar en aktivitet, och gamla rader visas aldrig ändå.
do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'pulse-social-cleanup';
  perform cron.schedule(
    'pulse-social-cleanup',
    '*/15 * * * *',
    $job$delete from public.statuses where expires_at <= now();
         delete from public.activities where starts_at <= now() - interval '6 hours'$job$
  );
exception when others then
  raise notice 'pg_cron kunde inte slås på (%). Städningen sker i stället när statusar och aktiviteter skapas.', sqlerrm;
end;
$cron$;

-- 8. Behörigheter för funktionerna: bara inloggade --------------------------------------------------

revoke execute on function public.set_my_status(text, text, integer) from public, anon;
revoke execute on function public.clear_my_status() from public, anon;
revoke execute on function public.get_my_status() from public, anon;
revoke execute on function public.get_friend_statuses() from public, anon;
revoke execute on function public.create_activity(text, text, timestamptz) from public, anon;
revoke execute on function public.cancel_activity(uuid) from public, anon;
revoke execute on function public.join_activity(uuid) from public, anon;
revoke execute on function public.leave_activity(uuid) from public, anon;
revoke execute on function public.list_activities() from public, anon;

grant execute on function public.set_my_status(text, text, integer) to authenticated;
grant execute on function public.clear_my_status() to authenticated;
grant execute on function public.get_my_status() to authenticated;
grant execute on function public.get_friend_statuses() to authenticated;
grant execute on function public.create_activity(text, text, timestamptz) to authenticated;
grant execute on function public.cancel_activity(uuid) to authenticated;
grant execute on function public.join_activity(uuid) to authenticated;
grant execute on function public.leave_activity(uuid) to authenticated;
grant execute on function public.list_activities() to authenticated;

-- Säg åt Supabase att läsa in de nya funktionerna direkt.
notify pgrst, 'reload schema';
