create table if not exists public.roadtrip_users (
  owner_email text primary key,
  storage_user_id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  constraint roadtrip_users_owner_email_check
    check (owner_email = lower(owner_email) and owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

alter table public.roadtrip_users enable row level security;
revoke all on public.roadtrip_users from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('roadtrip-route-private', 'roadtrip-route-private', false)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('roadtrip-route-public', 'roadtrip-route-public', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public can view roadtrip public route assets" on storage.objects;
create policy "Public can view roadtrip public route assets"
  on storage.objects for select
  using (bucket_id = 'roadtrip-route-public');
