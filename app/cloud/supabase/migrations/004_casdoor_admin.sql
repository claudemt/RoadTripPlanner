create or replace function public.is_app_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@map.bestapi.best'
    or lower(coalesce(auth.jwt() -> 'user_metadata' ->> 'preferred_username', '')) = 'admin'
    or lower(coalesce(auth.jwt() -> 'user_metadata' ->> 'username', '')) = 'admin'
    or lower(coalesce(auth.jwt() -> 'user_metadata' ->> 'name', '')) = 'admin';
$$;

grant execute on function public.is_app_admin() to authenticated;

drop policy if exists "Admin can create app settings" on public.app_settings;
create policy "Admin can create app settings"
  on public.app_settings for insert
  to authenticated
  with check (public.is_app_admin());

drop policy if exists "Admin can update app settings" on public.app_settings;
create policy "Admin can update app settings"
  on public.app_settings for update
  to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());
