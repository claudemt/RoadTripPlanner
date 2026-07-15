create table if not exists public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  route_id text not null,
  route_name text not null,
  render_video boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  phase text not null default 'queued',
  message text not null default '等待渲染服务',
  progress integer not null default 0 check (progress between 0 and 100),
  request_payload jsonb not null,
  artifacts jsonb not null default '[]'::jsonb,
  error text,
  worker_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists export_jobs_user_created_idx
  on public.export_jobs (user_id, created_at desc);

create index if not exists export_jobs_queue_idx
  on public.export_jobs (status, created_at)
  where status = 'queued';

create unique index if not exists export_jobs_one_active_per_user_idx
  on public.export_jobs (user_id)
  where status in ('queued', 'running', 'cancel_requested');

alter table public.export_jobs enable row level security;

drop policy if exists "Users can read their export jobs" on public.export_jobs;
create policy "Users can read their export jobs"
  on public.export_jobs for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their export jobs" on public.export_jobs;
create policy "Users can create their export jobs"
  on public.export_jobs for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'queued'
    and progress = 0
    and artifacts = '[]'::jsonb
    and error is null
    and worker_id is null
  );

revoke update, delete on public.export_jobs from anon, authenticated;

drop trigger if exists export_jobs_set_updated_at on public.export_jobs;
create trigger export_jobs_set_updated_at
before update on public.export_jobs
for each row execute function public.set_updated_at();

create or replace function public.request_export_cancel(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.export_jobs
  set
    status = case when status = 'queued' then 'cancelled' else 'cancel_requested' end,
    phase = case when status = 'queued' then 'cancelled' else 'cancel' end,
    message = case when status = 'queued' then '导出已取消' else '正在请求终止渲染' end,
    completed_at = case when status = 'queued' then now() else completed_at end
  where id = p_job_id
    and user_id = (select auth.uid())
    and status in ('queued', 'running');

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.request_export_cancel(uuid) from public, anon;
grant execute on function public.request_export_cancel(uuid) to authenticated;

create or replace function public.claim_next_export_job(p_worker_id text)
returns setof public.export_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_job_id uuid;
begin
  select id
  into next_job_id
  from public.export_jobs
  where status = 'queued'
  order by created_at
  for update skip locked
  limit 1;

  if next_job_id is null then
    return;
  end if;

  return query
  update public.export_jobs
  set
    status = 'running',
    phase = 'start',
    message = '渲染服务已接收任务',
    progress = 1,
    worker_id = nullif(trim(p_worker_id), ''),
    started_at = coalesce(started_at, now())
  where id = next_job_id
  returning *;
end;
$$;

revoke all on function public.claim_next_export_job(text) from public, anon, authenticated;
grant execute on function public.claim_next_export_job(text) to service_role;

insert into storage.buckets (id, name, public)
values ('route-exports', 'route-exports', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Users can read their route exports" on storage.objects;
create policy "Users can read their route exports"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'route-exports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
