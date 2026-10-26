create table if not exists public.roadtrip_scene_revisions (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid,
  normalized_name text not null,
  name text not null,
  title text not null,
  edited_by_email text not null,
  description_before text not null default '',
  description_after text not null default '',
  images_before jsonb not null default '[]'::jsonb,
  images_after jsonb not null default '[]'::jsonb,
  diff jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists roadtrip_scene_revisions_name_idx
  on public.roadtrip_scene_revisions (normalized_name, created_at desc);

create index if not exists roadtrip_scene_revisions_created_idx
  on public.roadtrip_scene_revisions (created_at desc);

alter table public.roadtrip_scene_revisions enable row level security;
revoke all on public.roadtrip_scene_revisions from anon, authenticated;
