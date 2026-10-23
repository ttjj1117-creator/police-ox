-- Account-partitioned immutable log. Run with Supabase's migration role.
-- No secret/service key is used by the browser. Namespace real only.
-- The transaction also makes a manual SQL Editor rerun all-or-nothing.
begin;
create table if not exists public.police_sync_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cursor bigint not null default 0 check (cursor >= 0),
  bank_version bigint not null default 0 check (bank_version >= 0)
);
create table if not exists public.police_sync_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  device_id uuid not null,
  device_sequence bigint not null check (device_sequence > 0),
  seq bigint not null check (seq > 0),
  bank_version bigint not null,
  mark_version bigint,
  wire jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key (user_id, event_id),
  unique (user_id, device_id, device_sequence),
  unique (user_id, seq)
);
create table if not exists public.police_sync_marks (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id text not null,
  version bigint not null check (version > 0),
  event_id uuid not null,
  primary key (user_id, question_id)
);
alter table public.police_sync_heads enable row level security;
alter table public.police_sync_events enable row level security;
alter table public.police_sync_marks enable row level security;
revoke all on public.police_sync_heads, public.police_sync_events, public.police_sync_marks from public, anon, authenticated;
grant select on public.police_sync_heads, public.police_sync_events, public.police_sync_marks to authenticated;

-- Ownership is enforced for every operation; direct mutations are additionally
-- ungranted, because they would bypass event idempotency/CAS bookkeeping.
-- Only policies created by this migration are replaced; other application
-- policies and all existing rows remain untouched on a manual rerun.
drop policy if exists sync_heads_select on public.police_sync_heads;
drop policy if exists sync_heads_insert on public.police_sync_heads;
drop policy if exists sync_heads_update on public.police_sync_heads;
drop policy if exists sync_heads_delete on public.police_sync_heads;
drop policy if exists sync_events_select on public.police_sync_events;
drop policy if exists sync_events_insert on public.police_sync_events;
drop policy if exists sync_events_update on public.police_sync_events;
drop policy if exists sync_events_delete on public.police_sync_events;
drop policy if exists sync_marks_select on public.police_sync_marks;
drop policy if exists sync_marks_insert on public.police_sync_marks;
drop policy if exists sync_marks_update on public.police_sync_marks;
drop policy if exists sync_marks_delete on public.police_sync_marks;
create policy sync_heads_select on public.police_sync_heads for select to authenticated using ((select auth.uid()) = user_id);
create policy sync_heads_insert on public.police_sync_heads for insert to authenticated with check ((select auth.uid()) = user_id);
create policy sync_heads_update on public.police_sync_heads for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy sync_heads_delete on public.police_sync_heads for delete to authenticated using ((select auth.uid()) = user_id);
create policy sync_events_select on public.police_sync_events for select to authenticated using ((select auth.uid()) = user_id);
create policy sync_events_insert on public.police_sync_events for insert to authenticated with check ((select auth.uid()) = user_id);
create policy sync_events_update on public.police_sync_events for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy sync_events_delete on public.police_sync_events for delete to authenticated using ((select auth.uid()) = user_id);
create policy sync_marks_select on public.police_sync_marks for select to authenticated using ((select auth.uid()) = user_id);
create policy sync_marks_insert on public.police_sync_marks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy sync_marks_update on public.police_sync_marks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy sync_marks_delete on public.police_sync_marks for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('police-sync-private', 'police-sync-private', false, 1048576, array['application/json','application/octet-stream','image/png','image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists sync_objects_select on storage.objects;
drop policy if exists sync_objects_insert on storage.objects;
drop policy if exists sync_objects_owner_guard on storage.objects;
drop policy if exists sync_objects_no_anon on storage.objects;
drop policy if exists sync_objects_immutable_update on storage.objects;
drop policy if exists sync_objects_immutable_delete on storage.objects;
create policy sync_objects_select on storage.objects for select to authenticated using (bucket_id = 'police-sync-private' and (storage.foldername(name))[1] = (select auth.uid())::text and (storage.foldername(name))[2] = 'real');
create policy sync_objects_insert on storage.objects for insert to authenticated with check (bucket_id = 'police-sync-private' and (storage.foldername(name))[1] = (select auth.uid())::text and (storage.foldername(name))[2] = 'real');
-- Restrictive guards also protect this bucket if an unrelated permissive policy
-- exists on storage.objects in an existing Supabase project.
create policy sync_objects_owner_guard on storage.objects as restrictive for all to authenticated using (bucket_id <> 'police-sync-private' or ((storage.foldername(name))[1] = (select auth.uid())::text and (storage.foldername(name))[2] = 'real')) with check (bucket_id <> 'police-sync-private' or ((storage.foldername(name))[1] = (select auth.uid())::text and (storage.foldername(name))[2] = 'real'));
create policy sync_objects_no_anon on storage.objects as restrictive for all to anon using (bucket_id <> 'police-sync-private') with check (bucket_id <> 'police-sync-private');
create policy sync_objects_immutable_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'police-sync-private') with check (bucket_id <> 'police-sync-private');
create policy sync_objects_immutable_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'police-sync-private');

create or replace function public.police_sync_push(p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
<<sync_request>>
declare
  owner_id uuid := auth.uid();
  head public.police_sync_heads%rowtype;
  existing public.police_sync_events%rowtype;
  event_id uuid;
  device_id uuid;
  device_sequence bigint;
  kind text;
  path text;
  bank_version bigint;
  mark_version bigint;
  question_id text;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' or p_event->>'protocolVersion' is null or (p_event->>'protocolVersion')::integer <> 1 or pg_column_size(p_event) > 32768 then raise exception 'invalid_event'; end if;
  event_id := (p_event->>'eventId')::uuid;
  device_id := (p_event->>'deviceId')::uuid;
  device_sequence := (p_event->>'deviceSequence')::bigint;
  kind := p_event->>'kind';
  path := p_event->>'bodyPath';
  if event_id is null or device_id is null or device_sequence is null or device_sequence < 1 or kind is null or kind not in ('bank','session','mark','resolution') then raise exception 'invalid_event_identity'; end if;
  if (p_event->>'baseCursor')::bigint < 0 or (p_event->>'baseCursor') is null or (p_event->>'createdAt') is null then raise exception 'invalid_event_order'; end if;
  perform (p_event->>'createdAt')::timestamptz;
  if path is null or split_part(path,'/',1) <> owner_id::text or split_part(path,'/',2) <> 'real' or path like '%..%' or (p_event->>'bodySha256') !~ '^[a-f0-9]{64}$' or (p_event->>'bodySha256') is null or p_event->>'bodyBytes' is null or (p_event->>'bodyBytes')::bigint not between 1 and 1048576 then raise exception 'invalid_private_body_reference' using errcode = '42501'; end if;
  insert into public.police_sync_heads(user_id) values(owner_id) on conflict do nothing;
  select * into head from public.police_sync_heads where user_id = owner_id for update;
  select * into existing from public.police_sync_events where user_id = owner_id and police_sync_events.event_id = sync_request.event_id;
  if found then
    if existing.wire <> p_event then raise exception 'event_id_content_conflict' using errcode = '23505'; end if;
    return jsonb_build_object('seq',existing.seq,'bankVersion',existing.bank_version,'markVersion',existing.mark_version,'duplicate',true,'serverTime',clock_timestamp());
  end if;
  if not exists(select 1 from storage.objects where bucket_id = 'police-sync-private' and name = path) then raise exception 'body_not_uploaded'; end if;
  if (p_event->>'baseCursor')::bigint > head.cursor then raise exception 'cursor_ahead_of_server'; end if;
  bank_version := head.bank_version;
  if kind = 'bank' then
    if (p_event->>'baseVersion') is null or (p_event->>'baseVersion')::bigint <> bank_version then raise exception 'bank_version_conflict' using errcode = '40001'; end if;
    bank_version := bank_version + 1;
  elsif p_event->>'baseVersion' is not null then raise exception 'unexpected_bank_version'; end if;
  if kind = 'mark' then
    question_id := p_event->>'markQuestionId';
    if question_id is null or length(question_id) not between 1 and 300 or (p_event->>'baseMarkVersion') is null then raise exception 'invalid_mark'; end if;
    select version into mark_version from public.police_sync_marks where user_id = owner_id and police_sync_marks.question_id = sync_request.question_id;
    mark_version := coalesce(mark_version,0);
    if (p_event->>'baseMarkVersion')::bigint <> mark_version then raise exception 'mark_version_conflict' using errcode = '40001'; end if;
    mark_version := mark_version + 1;
    insert into public.police_sync_marks(user_id,question_id,version,event_id) values(owner_id,question_id,mark_version,event_id)
      on conflict on constraint police_sync_marks_pkey do update set version = excluded.version, event_id = excluded.event_id;
  elsif p_event->>'baseMarkVersion' is not null or p_event->>'markQuestionId' is not null then raise exception 'unexpected_mark_version'; end if;
  update public.police_sync_heads set cursor = head.cursor + 1, bank_version = sync_request.bank_version where user_id = owner_id;
  insert into public.police_sync_events(user_id,event_id,device_id,device_sequence,seq,bank_version,mark_version,wire)
    values(owner_id,event_id,device_id,device_sequence,head.cursor + 1,bank_version,mark_version,p_event);
  return jsonb_build_object('seq',head.cursor+1,'bankVersion',bank_version,'markVersion',mark_version,'duplicate',false,'serverTime',clock_timestamp());
end $$;

create or replace function public.police_sync_pull(p_after bigint default 0, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); result jsonb; next_cursor bigint; bank_version bigint;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_after is null or p_limit is null or p_after < 0 or p_limit not between 1 and 100 then raise exception 'invalid_cursor_or_limit'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('seq',e.seq,'bankVersion',e.bank_version,'markVersion',e.mark_version,'event',e.wire) order by e.seq),'[]'::jsonb),coalesce(max(e.seq),p_after)
    into result,next_cursor from (select * from public.police_sync_events where user_id = owner_id and seq > p_after order by seq limit p_limit) e;
  select h.bank_version into bank_version from public.police_sync_heads h where h.user_id = owner_id;
  return jsonb_build_object('events',result,'cursor',next_cursor,'bankVersion',coalesce(bank_version,0),'serverTime',clock_timestamp());
end $$;
revoke all on function public.police_sync_push(jsonb), public.police_sync_pull(bigint,integer) from public, anon;
grant execute on function public.police_sync_push(jsonb), public.police_sync_pull(bigint,integer) to authenticated;
commit;
