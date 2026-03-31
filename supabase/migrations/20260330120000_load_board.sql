-- Load board: persisted loads, per-user saved load IDs, post form drafts.
-- Server uses the Supabase service role (bypasses RLS). No anon policies.

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
