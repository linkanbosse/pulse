-- PULSE – etapp 4: vänner
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Kräver att etapp3-profiler.sql redan är körd. Filen går att köra igen utan att något förstörs.
--
-- Vad som sparas (nytt i etapp 4):
--   * profiles.friend_code: din vänkod, 8 tecken. Slumpas fram och går att byta.
--   * friend_requests: vem som har skickat en vänförfrågan till vem, och när.
--   * friendships: vilka som är vänner, och sedan när.
--   * blocks: vem som har blockerat vem.
--   * friend_code_attempts: tidpunkter när du har skrivit in en kod (inte själva koden).
--     Används för att stoppa den som försöker gissa koder. Raderas efter en timme.
-- Ingen position sparas i etapp 4.
--
-- Säkerhet: ingen kan läsa eller ändra tabellerna ovan direkt. Allt går via funktionerna längre ner,
-- som kontrollerar vem du är (auth.uid()) och bara visar namn, användarnamn och färg för
-- dina vänner, dina förfrågningar och dem du har blockerat. Andras vänkoder visas aldrig.
-- Den du söker upp med kod får du bara veta namnet på när förfrågan har skickats.

-- 1. Vänkoder -------------------------------------------------------------------------------------

alter table public.profiles add column if not exists friend_code text;

-- 8 tecken utan förväxlingsbara tecken (inget 0, O, 1 eller I). 32^8 ≈ 1 biljon möjliga koder.
-- Slumpen kommer från gen_random_uuid(), som använder kryptografiskt säker slump.
create or replace function public.generate_friend_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b bytea;
  code text;
begin
  loop
    b := uuid_send(gen_random_uuid());
    code := '';
    -- Byte 6 och 8 innehåller fasta versionsbitar i en uuid, därför används byte 0–5 och 9–10.
    for i in 0..7 loop
      code := code || substr(alphabet, (get_byte(b, case when i < 6 then i else i + 3 end) & 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where friend_code = code);
  end loop;
  return code;
end;
$$;

revoke execute on function public.generate_friend_code() from public, anon, authenticated;

-- Ge en kod till alla profiler som saknar en.
update public.profiles set friend_code = public.generate_friend_code() where friend_code is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_friend_code_key') then
    alter table public.profiles add constraint profiles_friend_code_key unique (friend_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_friend_code_format') then
    alter table public.profiles add constraint profiles_friend_code_format
      check (friend_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$');
  end if;
end;
$$;

alter table public.profiles alter column friend_code set not null;

-- Nya profiler får en kod automatiskt. Appen kan inte välja koden själv
-- (kolumnen finns inte med i insert/update-behörigheterna från etapp 3).
create or replace function public.set_friend_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.friend_code is null then
    new.friend_code := public.generate_friend_code();
  end if;
  return new;
end;
$$;

revoke execute on function public.set_friend_code() from public, anon, authenticated;

drop trigger if exists profiles_set_friend_code on public.profiles;
create trigger profiles_set_friend_code
  before insert on public.profiles
  for each row execute function public.set_friend_code();

-- 2. Tabeller -------------------------------------------------------------------------------------

create table if not exists public.friend_requests (
  sender_id uuid not null references public.profiles (id) on delete cascade,
  receiver_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sender_id, receiver_id),
  constraint friend_requests_not_self check (sender_id <> receiver_id)
);
create index if not exists friend_requests_receiver_idx on public.friend_requests (receiver_id);

-- Varje vänskap sparas en gång, med det "minsta" id:t först.
create table if not exists public.friendships (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered check (user_a < user_b)
);
create index if not exists friendships_user_b_idx on public.friendships (user_b);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

create table if not exists public.friend_code_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists friend_code_attempts_user_idx on public.friend_code_attempts (user_id, attempted_at);

-- 3. Row Level Security: påslaget, och inga regler = ingen direkt åtkomst alls ------------------

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.friend_code_attempts enable row level security;

revoke all on public.friend_requests from anon, authenticated;
revoke all on public.friendships from anon, authenticated;
revoke all on public.blocks from anon, authenticated;
revoke all on public.friend_code_attempts from anon, authenticated;

-- 4. Funktioner som appen anropar -----------------------------------------------------------------
-- Alla kräver inloggning och utgår från auth.uid(), aldrig från ett id som appen skickar om "mig".

-- Skicka en vänförfrågan med en vänkod.
-- Svar: { result, display_name }. result är en av:
--   sent, now_friends (personen hade redan skickat till dig), already_sent, already_friends,
--   not_found, self, you_blocked, too_many_pending, rate_limited
-- Om personen har blockerat dig blir svaret not_found, så att en blockering inte avslöjas.
create or replace function public.send_friend_request(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_target uuid;
  v_name text;
begin
  if v_me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Högst 20 kodförsök per timme och person.
  delete from public.friend_code_attempts where attempted_at < now() - interval '1 hour';
  if (select count(*) from public.friend_code_attempts where user_id = v_me) >= 20 then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  insert into public.friend_code_attempts (user_id) values (v_me);

  if length(v_code) <> 8 then
    return jsonb_build_object('result', 'not_found');
  end if;

  select id, display_name into v_target, v_name from public.profiles where friend_code = v_code;
  if v_target is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_target = v_me then
    return jsonb_build_object('result', 'self');
  end if;
  if exists (select 1 from public.blocks where blocker_id = v_me and blocked_id = v_target) then
    return jsonb_build_object('result', 'you_blocked');
  end if;
  if exists (select 1 from public.blocks where blocker_id = v_target and blocked_id = v_me) then
    return jsonb_build_object('result', 'not_found');
  end if;
  if exists (select 1 from public.friendships where user_a = least(v_me, v_target) and user_b = greatest(v_me, v_target)) then
    return jsonb_build_object('result', 'already_friends', 'display_name', v_name);
  end if;

  -- Har personen redan skickat en förfrågan till dig blir ni vänner direkt.
  delete from public.friend_requests where sender_id = v_target and receiver_id = v_me;
  if found then
    insert into public.friendships (user_a, user_b)
    values (least(v_me, v_target), greatest(v_me, v_target))
    on conflict do nothing;
    return jsonb_build_object('result', 'now_friends', 'display_name', v_name);
  end if;

  if exists (select 1 from public.friend_requests where sender_id = v_me and receiver_id = v_target) then
    return jsonb_build_object('result', 'already_sent', 'display_name', v_name);
  end if;
  if (select count(*) from public.friend_requests where sender_id = v_me) >= 50 then
    return jsonb_build_object('result', 'too_many_pending');
  end if;

  insert into public.friend_requests (sender_id, receiver_id) values (v_me, v_target)
  on conflict do nothing;
  return jsonb_build_object('result', 'sent', 'display_name', v_name);
end;
$$;

-- Acceptera (p_accept = true) eller avvisa (false) en förfrågan som någon har skickat till dig.
create or replace function public.respond_to_friend_request(p_sender uuid, p_accept boolean)
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
  delete from public.friend_requests where sender_id = p_sender and receiver_id = v_me;
  if not found then
    raise exception 'request_not_found';
  end if;
  if p_accept then
    delete from public.friend_requests where sender_id = v_me and receiver_id = p_sender;
    insert into public.friendships (user_a, user_b)
    values (least(v_me, p_sender), greatest(v_me, p_sender))
    on conflict do nothing;
  end if;
end;
$$;

-- Ångra en förfrågan som du själv har skickat.
create or replace function public.cancel_friend_request(p_receiver uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.friend_requests where sender_id = auth.uid() and receiver_id = p_receiver;
end;
$$;

-- Ta bort en vän. Personen får inget meddelande om det.
create or replace function public.remove_friend(p_friend uuid)
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
  delete from public.friendships where user_a = least(v_me, p_friend) and user_b = greatest(v_me, p_friend);
end;
$$;

-- Blockera: tar också bort vänskap och förfrågningar åt båda hållen.
-- Den blockerade får inget meddelande och kan inte skicka nya förfrågningar till dig.
create or replace function public.block_user(p_user uuid)
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
  if p_user is null or p_user = v_me then
    raise exception 'cannot_block_self';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user_not_found';
  end if;
  delete from public.friendships where user_a = least(v_me, p_user) and user_b = greatest(v_me, p_user);
  delete from public.friend_requests
    where (sender_id = v_me and receiver_id = p_user) or (sender_id = p_user and receiver_id = v_me);
  insert into public.blocks (blocker_id, blocked_id) values (v_me, p_user) on conflict do nothing;
end;
$$;

create or replace function public.unblock_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.blocks where blocker_id = auth.uid() and blocked_id = p_user;
end;
$$;

-- Byt till en ny vänkod. Den gamla slutar fungera direkt. Redan skickade förfrågningar ligger kvar.
create or replace function public.regenerate_friend_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  update public.profiles set friend_code = public.generate_friend_code()
  where id = auth.uid()
  returning friend_code into v_code;
  return v_code;
end;
$$;

-- Dina vänner.
create or replace function public.list_friends()
returns table (user_id uuid, display_name text, username text, avatar_color text, friends_since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name, p.username, p.avatar_color, f.created_at
  from public.friendships f
  join public.profiles p on p.id = case when f.user_a = (select auth.uid()) then f.user_b else f.user_a end
  where (select auth.uid()) in (f.user_a, f.user_b)
  order by lower(p.display_name), p.id;
$$;

-- Förfrågningar till dig (direction = 'incoming') och från dig ('outgoing').
create or replace function public.list_friend_requests()
returns table (direction text, user_id uuid, display_name text, username text, avatar_color text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select 'incoming', p.id, p.display_name, p.username, p.avatar_color, r.created_at
  from public.friend_requests r
  join public.profiles p on p.id = r.sender_id
  where r.receiver_id = (select auth.uid())
  union all
  select 'outgoing', p.id, p.display_name, p.username, p.avatar_color, r.created_at
  from public.friend_requests r
  join public.profiles p on p.id = r.receiver_id
  where r.sender_id = (select auth.uid())
  order by 6 desc;
$$;

-- Personer du har blockerat. (Vilka som har blockerat dig visas aldrig.)
create or replace function public.list_blocked()
returns table (user_id uuid, display_name text, username text, avatar_color text, blocked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name, p.username, p.avatar_color, b.created_at
  from public.blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = (select auth.uid())
  order by b.created_at desc;
$$;

-- 5. Behörigheter för funktionerna: bara inloggade --------------------------------------------------

revoke execute on function public.send_friend_request(text) from public, anon;
revoke execute on function public.respond_to_friend_request(uuid, boolean) from public, anon;
revoke execute on function public.cancel_friend_request(uuid) from public, anon;
revoke execute on function public.remove_friend(uuid) from public, anon;
revoke execute on function public.block_user(uuid) from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.regenerate_friend_code() from public, anon;
revoke execute on function public.list_friends() from public, anon;
revoke execute on function public.list_friend_requests() from public, anon;
revoke execute on function public.list_blocked() from public, anon;

grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.regenerate_friend_code() to authenticated;
grant execute on function public.list_friends() to authenticated;
grant execute on function public.list_friend_requests() to authenticated;
grant execute on function public.list_blocked() to authenticated;

-- Säg åt Supabase att läsa in de nya funktionerna direkt.
notify pgrst, 'reload schema';
