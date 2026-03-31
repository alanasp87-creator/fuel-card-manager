-- Run once in Supabase → SQL Editor (Dashboard).
-- Same migration: supabase/migrations/20260328203000_profiles.sql (use with `npx supabase db push` after link).
-- Creates app profile rows linked to auth.users.
--
-- If CREATE TRIGGER fails on "execute function", replace the last line with:
--   for each row execute procedure public.handle_new_user();

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  dashboard jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Server uses service role and bypasses RLS; policies cover direct browser access if you add a Supabase client later.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Load board (same migration: supabase/migrations/20260330120000_load_board.sql)

create table if not exists public.load_board_loads (
  id uuid primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists load_board_loads_created_at_idx
  on public.load_board_loads (created_at desc);

alter table public.load_board_loads enable row level security;

create table if not exists public.load_board_saved_ids (
  user_id text primary key,
  ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.load_board_saved_ids enable row level security;

create table if not exists public.load_board_post_drafts (
  user_id text primary key,
  draft jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.load_board_post_drafts enable row level security;
