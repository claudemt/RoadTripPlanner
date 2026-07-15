create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
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

create table if not exists public.routes (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  route_data jsonb not null default '{}'::jsonb,
  map_layer text not null default 'standard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists routes_user_updated_idx
  on public.routes (user_id, updated_at desc);

alter table public.routes enable row level security;

drop policy if exists "Users can read their routes" on public.routes;
create policy "Users can read their routes"
  on public.routes for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their routes" on public.routes;
create policy "Users can create their routes"
  on public.routes for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their routes" on public.routes;
create policy "Users can update their routes"
  on public.routes for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their routes" on public.routes;
create policy "Users can delete their routes"
  on public.routes for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop trigger if exists routes_set_updated_at on public.routes;
create trigger routes_set_updated_at
before update on public.routes
for each row execute function public.set_updated_at();

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  normalized_name text not null unique,
  name text not null,
  title text not null,
  description text not null default '',
  images jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scenes enable row level security;

drop policy if exists "Authenticated users can read scenes" on public.scenes;
create policy "Authenticated users can read scenes"
  on public.scenes for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create scenes" on public.scenes;
create policy "Authenticated users can create scenes"
  on public.scenes for insert
  to authenticated
  with check ((select auth.uid()) = updated_by);

drop policy if exists "Authenticated users can update scenes" on public.scenes;
create policy "Authenticated users can update scenes"
  on public.scenes for update
  to authenticated
  using (true)
  with check ((select auth.uid()) = updated_by);

drop trigger if exists scenes_set_updated_at on public.scenes;
create trigger scenes_set_updated_at
before update on public.scenes
for each row execute function public.set_updated_at();

create table if not exists public.scene_revisions (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.scenes(id) on delete cascade,
  editor_user_id uuid not null references auth.users(id) on delete cascade,
  old_data jsonb,
  new_data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists scene_revisions_scene_created_idx
  on public.scene_revisions (scene_id, created_at desc);

alter table public.scene_revisions enable row level security;

drop policy if exists "Authenticated users can read scene history" on public.scene_revisions;
create policy "Authenticated users can read scene history"
  on public.scene_revisions for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create scene history" on public.scene_revisions;
create policy "Authenticated users can create scene history"
  on public.scene_revisions for insert
  to authenticated
  with check ((select auth.uid()) = editor_user_id);

insert into storage.buckets (id, name, public)
values ('scene-images', 'scene-images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Anyone can view scene images" on storage.objects;
create policy "Anyone can view scene images"
  on storage.objects for select
  using (bucket_id = 'scene-images');

drop policy if exists "Authenticated users can upload scene images" on storage.objects;
create policy "Authenticated users can upload scene images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'scene-images'
    and (storage.foldername(name))[1] = 'scenes'
  );
