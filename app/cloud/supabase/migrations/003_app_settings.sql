create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "Authenticated users can read app settings" on public.app_settings;
create policy "Authenticated users can read app settings"
  on public.app_settings for select
  to authenticated
  using (true);

drop policy if exists "Admin can create app settings" on public.app_settings;
create policy "Admin can create app settings"
  on public.app_settings for insert
  to authenticated
  with check (lower((auth.jwt() ->> 'email')) = 'admin@map.bestapi.best');

drop policy if exists "Admin can update app settings" on public.app_settings;
create policy "Admin can update app settings"
  on public.app_settings for update
  to authenticated
  using (lower((auth.jwt() ->> 'email')) = 'admin@map.bestapi.best')
  with check (lower((auth.jwt() ->> 'email')) = 'admin@map.bestapi.best');

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();
