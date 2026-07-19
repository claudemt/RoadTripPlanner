insert into storage.buckets (id, name, public)
values ('roadtrip-route-assets', 'roadtrip-route-assets', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public can view roadtrip route assets" on storage.objects;
create policy "Public can view roadtrip route assets"
  on storage.objects for select
  using (bucket_id = 'roadtrip-route-assets');
