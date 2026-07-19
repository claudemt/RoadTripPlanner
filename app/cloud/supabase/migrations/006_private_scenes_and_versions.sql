alter table public.roadtrip_scene_revisions
  add column if not exists version integer,
  add column if not exists change_note text not null default '';

with ranked as (
  select
    id,
    row_number() over (partition by normalized_name order by created_at asc, id asc) + 1 as version
  from public.roadtrip_scene_revisions
  where version is null
)
update public.roadtrip_scene_revisions revisions
set version = ranked.version
from ranked
where revisions.id = ranked.id;

insert into public.roadtrip_scene_revisions (
  scene_id,
  normalized_name,
  name,
  title,
  edited_by_email,
  description_before,
  description_after,
  images_before,
  images_after,
  diff,
  version,
  change_note,
  created_at
)
select
  scenes.id,
  scenes.normalized_name,
  scenes.name,
  scenes.title,
  coalesce(first_revision.edited_by_email, scenes.updated_by_email, 'legacy@roadtrip.local'),
  '',
  coalesce(first_revision.description_before, scenes.description, ''),
  '[]'::jsonb,
  coalesce(first_revision.images_before, scenes.images, '[]'::jsonb),
  case
    when coalesce(first_revision.description_before, scenes.description, '') = '' then '[]'::jsonb
    else jsonb_build_array(jsonb_build_object(
      'type', 'add',
      'text', coalesce(first_revision.description_before, scenes.description, '')
    ))
  end,
  1,
  '历史初始版本',
  coalesce(first_revision.created_at - interval '1 microsecond', scenes.created_at)
from public.roadtrip_scenes scenes
left join lateral (
  select revisions.*
  from public.roadtrip_scene_revisions revisions
  where revisions.normalized_name = scenes.normalized_name
  order by revisions.created_at asc, revisions.id asc
  limit 1
) first_revision on true
where not exists (
  select 1
  from public.roadtrip_scene_revisions revisions
  where revisions.normalized_name = scenes.normalized_name
    and revisions.version = 1
);

alter table public.roadtrip_scene_revisions
  alter column version set not null;

create unique index if not exists roadtrip_scene_revisions_version_idx
  on public.roadtrip_scene_revisions (normalized_name, version);

create table if not exists public.roadtrip_user_scenes (
  owner_email text not null,
  id uuid not null default gen_random_uuid(),
  normalized_name text not null,
  name text not null,
  title text not null,
  description text not null default '',
  images jsonb not null default '[]'::jsonb,
  source_scene_id uuid references public.roadtrip_scenes(id) on delete set null,
  source_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_email, id),
  unique (owner_email, normalized_name),
  constraint roadtrip_user_scenes_owner_email_check
    check (owner_email = lower(owner_email) and owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

create index if not exists roadtrip_user_scenes_owner_updated_idx
  on public.roadtrip_user_scenes (owner_email, updated_at desc);

drop trigger if exists roadtrip_user_scenes_set_updated_at on public.roadtrip_user_scenes;
create trigger roadtrip_user_scenes_set_updated_at
before update on public.roadtrip_user_scenes
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_user_scenes enable row level security;
revoke all on public.roadtrip_user_scenes from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('roadtrip-scene-private', 'roadtrip-scene-private', false)
on conflict (id) do update set public = excluded.public;
