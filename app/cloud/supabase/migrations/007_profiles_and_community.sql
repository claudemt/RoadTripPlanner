create table if not exists public.roadtrip_profiles (
  owner_email text primary key,
  nickname text not null,
  bio text not null default '',
  avatar jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roadtrip_profiles_owner_email_check
    check (owner_email = lower(owner_email) and owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint roadtrip_profiles_nickname_check
    check (char_length(nickname) between 1 and 40),
  constraint roadtrip_profiles_bio_check
    check (char_length(bio) <= 500)
);

drop trigger if exists roadtrip_profiles_set_updated_at on public.roadtrip_profiles;
create trigger roadtrip_profiles_set_updated_at
before update on public.roadtrip_profiles
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_profiles enable row level security;
revoke all on public.roadtrip_profiles from anon, authenticated;

create table if not exists public.roadtrip_forum_messages (
  id uuid primary key default gen_random_uuid(),
  author_email text not null,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  reply_to_id uuid references public.roadtrip_forum_messages(id) on delete set null,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roadtrip_forum_messages_author_email_check
    check (author_email = lower(author_email) and author_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint roadtrip_forum_messages_body_check
    check (char_length(body) <= 4000)
);

create index if not exists roadtrip_forum_messages_created_idx
  on public.roadtrip_forum_messages (created_at desc);

create index if not exists roadtrip_forum_messages_author_idx
  on public.roadtrip_forum_messages (author_email, created_at desc);

drop trigger if exists roadtrip_forum_messages_set_updated_at on public.roadtrip_forum_messages;
create trigger roadtrip_forum_messages_set_updated_at
before update on public.roadtrip_forum_messages
for each row execute function public.roadtrip_set_updated_at();

alter table public.roadtrip_forum_messages enable row level security;
revoke all on public.roadtrip_forum_messages from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('roadtrip-community-private', 'roadtrip-community-private', false)
on conflict (id) do update set public = excluded.public;
