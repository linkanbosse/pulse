-- PULSE – etapp 5: platsdelning
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Kräver att etapp3-profiler.sql och etapp4-vanner.sql redan är körda. Filen går att köra igen.
--
-- Vad som sparas (nytt i etapp 5):
--   * location_shares: vilka vänner du har valt ska få se din position. Ingen är vald från början.
--   * location_settings: om du har pausat delningen (och till när) och om osynligt läge är på.
--   * locations: din SENASTE position (latitud, longitud, noggrannhet i meter, tidpunkt).
--     Bara en rad per person, den skrivs över vid varje uppdatering. Ingen historik sparas.
--     Raden raderas direkt när du pausar, blir osynlig eller slutar dela med alla,
--     och positioner som är äldre än 24 timmar raderas automatiskt.
--
-- Säkerhet: ingen kan läsa eller ändra tabellerna direkt (Row Level Security utan regler).
-- Allt går via funktionerna längre ner. En vän får bara din position om ALLT detta stämmer:
--   1. ni är vänner just nu,
--   2. ingen av er har blockerat den andra,
--   3. du har valt att just den vännen får se dig,
--   4. du har inte pausat och inte osynligt läge på,
--   5. positionen är yngre än 24 timmar.
-- Annars får vännen inga koordinater alls, bara "delar inte" (eller "pausad" om du har valt hen).
-- Osynligt läge ser för vännerna ut precis som att du inte delar.

-- 1. Tabeller -------------------------------------------------------------------------------------

create table if not exists public.location_shares (
  owner_id uuid not null references public.profiles (id) on delete cascade,   -- den som delar
  viewer_id uuid not null references public.profiles (id) on delete cascade,  -- vännen som får se
  created_at timestamptz not null default now(),
  primary key (owner_id, viewer_id),
  constraint location_shares_not_self check (owner_id <> viewer_id)
);
create index if not exists location_shares_viewer_idx on public.location_shares (viewer_id);

create table if not exists public.location_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  ghost boolean not null default false,
  paused_until timestamptz,          -- null = inte pausad, 'infinity' = pausad tills du startar igen
  updated_at timestamptz not null default now()
);

create table if not exists public.locations (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real not null,
  updated_at timestamptz not null default now(),
  constraint locations_lat_range check (lat between -90 and 90),
  constraint locations_lng_range check (lng between -180 and 180),
  constraint locations_accuracy_range check (accuracy_m >= 0 and accuracy_m <= 100000)
);
create index if not exists locations_updated_idx on public.locations (updated_at);

-- 2. Row Level Security: påslaget, och inga regler = ingen direkt åtkomst alls ------------------

alter table public.location_shares enable row level security;
alter table public.location_settings enable row level security;
alter table public.locations enable row level security;

revoke all on public.location_shares from anon, authenticated;
revoke all on public.location_settings from anon, authenticated;
revoke all on public.locations from anon, authenticated;

-- 3. När en vänskap tar slut (borttagen vän eller blockering) slutar ni dela med varandra ---------

create or replace function public.friendship_ended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.location_shares
    where (owner_id = old.user_a and viewer_id = old.user_b)
       or (owner_id = old.user_b and viewer_id = old.user_a);
  -- Den som inte längre delar med någon behöver ingen sparad position.
  delete from public.locations l
    where l.user_id in (old.user_a, old.user_b)
      and not exists (select 1 from public.location_shares s where s.owner_id = l.user_id);
  return old;
end;
$$;

revoke execute on function public.friendship_ended() from public, anon, authenticated;

drop trigger if exists friendships_end_location_shares on public.friendships;
create trigger friendships_end_location_shares
  after delete on public.friendships
  for each row execute function public.friendship_ended();

-- Rensa delningar som redan saknar vänskap (om filen körs igen efter ändringar).
delete from public.location_shares s
where not exists (
  select 1 from public.friendships f
  where f.user_a = least(s.owner_id, s.viewer_id) and f.user_b = greatest(s.owner_id, s.viewer_id)
);

-- 4. Hjälpfunktion: är jag synlig för någon just nu? (används bara inne i databasen) -------------

create or replace function public.location_sharing_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.location_shares where owner_id = p_user)
     and not exists (
       select 1 from public.location_settings
       where user_id = p_user and (ghost or coalesce(paused_until > now(), false))
     );
$$;

revoke execute on function public.location_sharing_active(uuid) from public, anon, authenticated;

-- 5. Funktioner som appen anropar -----------------------------------------------------------------
-- Alla kräver inloggning och utgår från auth.uid(), aldrig från ett id som appen skickar om "mig".

-- Dina egna inställningar. Svar: { ghost, paused, paused_until, paused_forever, viewer_ids, active,
-- location_age_seconds }. paused_until är null om du inte har pausat eller har pausat tills vidare.
create or replace function public.get_my_location_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_ghost boolean := false;
  v_until timestamptz;
  v_paused boolean;
  v_age integer;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select ghost, paused_until into v_ghost, v_until from public.location_settings where user_id = v_me;
  v_ghost := coalesce(v_ghost, false);
  v_paused := coalesce(v_until > now(), false);
  select greatest(0, floor(extract(epoch from now() - updated_at)))::integer into v_age
  from public.locations where user_id = v_me;

  return jsonb_build_object(
    'ghost', v_ghost,
    'paused', v_paused,
    'paused_forever', v_paused and v_until = 'infinity'::timestamptz,
    'paused_until', case when v_paused and v_until <> 'infinity'::timestamptz then v_until end,
    'viewer_ids', coalesce((select jsonb_agg(viewer_id order by created_at)
                            from public.location_shares where owner_id = v_me), '[]'::jsonb),
    'active', public.location_sharing_active(v_me),
    'location_age_seconds', v_age
  );
end;
$$;

-- Välj om en vän får se din position (p_allowed = true) eller inte (false).
create or replace function public.set_location_viewer(p_friend uuid, p_allowed boolean)
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
  if p_allowed then
    if not exists (
      select 1 from public.friendships
      where user_a = least(v_me, p_friend) and user_b = greatest(v_me, p_friend)
    ) then
      raise exception 'not_friends';
    end if;
    insert into public.location_shares (owner_id, viewer_id) values (v_me, p_friend)
    on conflict do nothing;
  else
    delete from public.location_shares where owner_id = v_me and viewer_id = p_friend;
    -- Delar du inte med någon längre behövs positionen inte.
    if not exists (select 1 from public.location_shares where owner_id = v_me) then
      delete from public.locations where user_id = v_me;
    end if;
  end if;
end;
$$;

-- Pausa delningen i p_minutes minuter (1–1440). null = tills du startar igen. 0 = starta igen nu.
-- Positionen raderas direkt när du pausar.
create or replace function public.pause_location_sharing(p_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_until timestamptz;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_minutes is not null and (p_minutes < 0 or p_minutes > 1440) then
    raise exception 'invalid_pause';
  end if;
  v_until := case
    when p_minutes is null then 'infinity'::timestamptz
    when p_minutes = 0 then null
    else now() + make_interval(mins => p_minutes)
  end;
  insert into public.location_settings (user_id, paused_until, updated_at) values (v_me, v_until, now())
  on conflict (user_id) do update set paused_until = excluded.paused_until, updated_at = now();
  if v_until is not null then
    delete from public.locations where user_id = v_me;
  end if;
end;
$$;

-- Osynligt läge på (true) eller av (false). Positionen raderas direkt när det slås på.
create or replace function public.set_ghost_mode(p_on boolean)
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
  insert into public.location_settings (user_id, ghost, updated_at) values (v_me, coalesce(p_on, false), now())
  on conflict (user_id) do update set ghost = excluded.ghost, updated_at = now();
  if p_on then
    delete from public.locations where user_id = v_me;
  end if;
end;
$$;

-- Spara din senaste position. Sparas bara om du delar med minst en vän och inte har pausat
-- eller osynligt läge på. Svar: saved, too_soon (högst var 5:e sekund), no_viewers, paused, ghost.
create or replace function public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy real)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_ghost boolean;
  v_until timestamptz;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_lat is null or p_lng is null or p_accuracy is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or p_accuracy < 0 or p_accuracy > 100000 or p_lat = 'NaN' or p_lng = 'NaN' or p_accuracy = 'NaN' then
    raise exception 'invalid_location';
  end if;

  -- Städa bort alla positioner som är äldre än 24 timmar (även andras), så att inget gammalt ligger kvar.
  delete from public.locations where updated_at < now() - interval '24 hours';

  select ghost, paused_until into v_ghost, v_until from public.location_settings where user_id = v_me;
  if coalesce(v_ghost, false) then
    delete from public.locations where user_id = v_me;
    return 'ghost';
  end if;
  if coalesce(v_until > now(), false) then
    delete from public.locations where user_id = v_me;
    return 'paused';
  end if;
  if not exists (select 1 from public.location_shares where owner_id = v_me) then
    delete from public.locations where user_id = v_me;
    return 'no_viewers';
  end if;
  if exists (select 1 from public.locations where user_id = v_me and updated_at > now() - interval '5 seconds') then
    return 'too_soon';
  end if;

  insert into public.locations (user_id, lat, lng, accuracy_m, updated_at)
  values (v_me, p_lat, p_lng, p_accuracy, now())
  on conflict (user_id) do update
    set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, updated_at = excluded.updated_at;
  return 'saved';
end;
$$;

-- Ta bort din sparade position direkt (t.ex. när du loggar ut).
create or replace function public.clear_my_location()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.locations where user_id = auth.uid();
end;
$$;

-- Alla dina vänner med deras platsläge, och om du delar med dem (i_share).
-- state: 'sharing' (position finns), 'paused' (vännen delar med dig men har pausat),
--        'off' (vännen delar inte med dig, är osynlig eller har ingen färsk position).
-- lat, lng, accuracy_m och age_seconds är null om state inte är 'sharing'.
-- age_seconds räknas av servern, så att fel klocka i mobilen inte får en gammal position att se ny ut.
create or replace function public.get_friend_locations()
returns table (
  user_id uuid, display_name text, username text, avatar_color text, i_share boolean,
  state text, lat double precision, lng double precision, accuracy_m real, age_seconds integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select (select auth.uid()) as id),
  friends as (
    select case when f.user_a = me.id then f.user_b else f.user_a end as friend_id
    from public.friendships f, me
    where me.id in (f.user_a, f.user_b)
  ),
  info as (
    select
      fr.friend_id,
      exists (select 1 from public.location_shares s where s.owner_id = me.id and s.viewer_id = fr.friend_id) as i_share,
      exists (select 1 from public.location_shares s where s.owner_id = fr.friend_id and s.viewer_id = me.id)
        and not exists (
          select 1 from public.blocks b
          where (b.blocker_id = me.id and b.blocked_id = fr.friend_id)
             or (b.blocker_id = fr.friend_id and b.blocked_id = me.id)
        ) as shares_with_me,
      coalesce(ls.ghost, false) as ghost,
      coalesce(ls.paused_until > now(), false) as paused,
      l.lat, l.lng, l.accuracy_m, l.updated_at
    from friends fr
    cross join me
    left join public.location_settings ls on ls.user_id = fr.friend_id
    left join public.locations l on l.user_id = fr.friend_id and l.updated_at > now() - interval '24 hours'
  ),
  judged as (
    select i.*,
      case
        when not i.shares_with_me or i.ghost then 'off'
        when i.paused then 'paused'
        when i.updated_at is not null then 'sharing'
        else 'off'
      end as state
    from info i
  )
  select
    p.id, p.display_name, p.username, p.avatar_color, j.i_share, j.state,
    case when j.state = 'sharing' then j.lat end,
    case when j.state = 'sharing' then j.lng end,
    case when j.state = 'sharing' then j.accuracy_m end,
    case when j.state = 'sharing' then greatest(0, floor(extract(epoch from now() - j.updated_at)))::integer end
  from judged j
  join public.profiles p on p.id = j.friend_id
  order by lower(p.display_name), p.id;
$$;

-- 6. Behörigheter för funktionerna: bara inloggade --------------------------------------------------

revoke execute on function public.get_my_location_settings() from public, anon;
revoke execute on function public.set_location_viewer(uuid, boolean) from public, anon;
revoke execute on function public.pause_location_sharing(integer) from public, anon;
revoke execute on function public.set_ghost_mode(boolean) from public, anon;
revoke execute on function public.update_my_location(double precision, double precision, real) from public, anon;
revoke execute on function public.clear_my_location() from public, anon;
revoke execute on function public.get_friend_locations() from public, anon;

grant execute on function public.get_my_location_settings() to authenticated;
grant execute on function public.set_location_viewer(uuid, boolean) to authenticated;
grant execute on function public.pause_location_sharing(integer) to authenticated;
grant execute on function public.set_ghost_mode(boolean) to authenticated;
grant execute on function public.update_my_location(double precision, double precision, real) to authenticated;
grant execute on function public.clear_my_location() to authenticated;
grant execute on function public.get_friend_locations() to authenticated;

-- Säg åt Supabase att läsa in de nya funktionerna direkt.
notify pgrst, 'reload schema';
