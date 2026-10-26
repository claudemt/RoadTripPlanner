create extension if not exists pgcrypto;

create or replace function public.roadtrip_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.roadtrip_routes (
  owner_email text not null,
  id text not null,
  name text not null,
  route_data jsonb not null default '{}'::jsonb,
  map_layer text not null default 'standard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_email, id),
  constraint roadtrip_routes_owner_email_check
    check (owner_email = lower(owner_email) and owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

create index if not exists roadtrip_routes_owner_updated_idx
  on public.roadtrip_routes (owner_email, updated_at desc);

drop trigger if exists roadtrip_routes_set_updated_at on public.roadtrip_routes;
create trigger roadtrip_routes_set_updated_at
before update on public.roadtrip_routes
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_routes enable row level security;
revoke all on public.roadtrip_routes from anon, authenticated;

create table if not exists public.roadtrip_scenes (
  id uuid primary key default gen_random_uuid(),
  normalized_name text not null unique,
  name text not null,
  title text not null,
  description text not null default '',
  images jsonb not null default '[]'::jsonb,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists roadtrip_scenes_updated_idx
  on public.roadtrip_scenes (updated_at desc);

drop trigger if exists roadtrip_scenes_set_updated_at on public.roadtrip_scenes;
create trigger roadtrip_scenes_set_updated_at
before update on public.roadtrip_scenes
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_scenes enable row level security;
revoke all on public.roadtrip_scenes from anon, authenticated;

create table if not exists public.roadtrip_app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists roadtrip_app_settings_set_updated_at on public.roadtrip_app_settings;
create trigger roadtrip_app_settings_set_updated_at
before update on public.roadtrip_app_settings
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_app_settings enable row level security;
revoke all on public.roadtrip_app_settings from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('roadtrip-scene-images', 'roadtrip-scene-images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public can view roadtrip scene images" on storage.objects;
create policy "Public can view roadtrip scene images"
  on storage.objects for select
  using (bucket_id = 'roadtrip-scene-images');
