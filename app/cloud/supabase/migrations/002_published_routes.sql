create table if not exists public.roadtrip_published_routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
  published_by_email text not null,
  source_route_id text,
  source_owner_email text,
  route_data jsonb not null default '{}'::jsonb,
  map_layer text not null default 'standard',
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists roadtrip_published_routes_published_idx
  on public.roadtrip_published_routes (published_at desc);

create index if not exists roadtrip_published_routes_name_idx
  on public.roadtrip_published_routes (name);

drop trigger if exists roadtrip_published_routes_set_updated_at on public.roadtrip_published_routes;
create trigger roadtrip_published_routes_set_updated_at
before update on public.roadtrip_published_routes
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_published_routes enable row level security;
revoke all on public.roadtrip_published_routes from anon, authenticated;
