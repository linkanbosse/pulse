-- PULSE – etapp 3: profiler
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Filen går att köra igen utan att något förstörs (t.ex. om du ändrar något senare).
--
-- Vad som sparas om varje användare:
--   * Supabase Auth (inbyggt): e-post, krypterat lösenord, tid för inloggningar.
--   * Tabellen profiles (nedan): visningsnamn, valfritt användarnamn, avatarfärg, när profilen skapades/ändrades.
-- Ingen position sparas i etapp 3.
--
-- Säkerhet: Row Level Security (RLS) är påslaget. Varje inloggad användare kan bara
-- läsa och ändra sin egen profil. Utloggade besökare kommer inte åt tabellen alls.

-- 1. Tabellen
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Ny användare',
  username text unique,
  avatar_color text not null default 'violet',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 30),
  constraint profiles_username_format check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_avatar_color_allowed check (avatar_color in ('violet', 'pink', 'orange', 'green', 'blue', 'yellow'))
);

-- 2. Row Level Security
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Inga delete-regler: profilen raderas automatiskt när kontot raderas (on delete cascade).

-- 3. Behörigheter: utloggade (anon) får ingenting. Inloggade får bara röra de kolumner appen behöver.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name, username, avatar_color) on public.profiles to authenticated;
grant update (display_name, username, avatar_color) on public.profiles to authenticated;

-- 4. Skapa en profil automatiskt när någon registrerar sig
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  v_name := left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 30);
  if v_name = '' then
    v_name := 'Ny användare';
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, v_name)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. Uppdatera updated_at automatiskt
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- 6. Låt användaren radera sitt eget konto (och därmed sin profil)
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Inte inloggad';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 7. Ge profiler till konton som skapades innan den här filen kördes
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;
