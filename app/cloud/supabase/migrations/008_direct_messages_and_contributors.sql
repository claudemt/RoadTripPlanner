alter table public.roadtrip_forum_messages
  add column if not exists channel text not null default 'public',
  add column if not exists recipient_email text,
  add column if not exists conversation_key text not null default 'public';

update public.roadtrip_forum_messages
set channel = 'public',
    recipient_email = null,
    conversation_key = 'public'
where channel is null
   or channel = ''
   or conversation_key is null
   or conversation_key = '';

alter table public.roadtrip_forum_messages
  drop constraint if exists roadtrip_forum_messages_channel_check;
alter table public.roadtrip_forum_messages
  add constraint roadtrip_forum_messages_channel_check
  check (
    (channel = 'public' and recipient_email is null and conversation_key = 'public')
    or (channel = 'direct' and recipient_email is not null and conversation_key <> 'public')
  );

create index if not exists roadtrip_forum_messages_channel_idx
  on public.roadtrip_forum_messages (channel, conversation_key, created_at);

revoke all on public.roadtrip_forum_messages from anon, authenticated;
