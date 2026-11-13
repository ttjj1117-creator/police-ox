-- Install on the Supabase project that already hosts the app's private sync.
-- Register public.police_ox_check_signup as Before User Created in Auth Hooks.
begin;

create schema if not exists police_ox_access;
revoke all on schema police_ox_access from public, anon, authenticated;
grant usage on schema police_ox_access to authenticated, supabase_auth_admin;

create table if not exists police_ox_access.allowed_emails (
  email text primary key,
  constraint allowed_email_normalized check (email <> '' and email = lower(btrim(email)))
);
alter table police_ox_access.allowed_emails enable row level security;
revoke all on table police_ox_access.allowed_emails from public, anon, authenticated, supabase_auth_admin;
grant select on table police_ox_access.allowed_emails to supabase_auth_admin;

drop policy if exists ox_signup_check_emails on police_ox_access.allowed_emails;
create policy ox_signup_check_emails on police_ox_access.allowed_emails
  for select to supabase_auth_admin using (true);

create or replace function public.police_ox_check_signup(event jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when event #>> '{user,is_anonymous}' is distinct from 'true'
      and exists (
        select 1
        from police_ox_access.allowed_emails
        where email = lower(btrim(event #>> '{user,email}'))
      )
    then '{}'::jsonb
    else jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', '등록된 이메일만 가입할 수 있습니다.')
    )
  end;
$$;
grant usage on schema public to supabase_auth_admin;
revoke all on function public.police_ox_check_signup(jsonb) from public, anon, authenticated;
grant execute on function public.police_ox_check_signup(jsonb) to supabase_auth_admin;

-- Derive membership from the current verified Auth record of the caller.
create or replace function police_ox_access.can_read_library()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users as account
    join police_ox_access.allowed_emails as entry
      on entry.email = lower(btrim(account.email))
    where account.id = (select auth.uid())
      and account.email_confirmed_at is not null
      and not account.is_anonymous
      and (account.banned_until is null or account.banned_until <= statement_timestamp())
  );
$$;
revoke all on function police_ox_access.can_read_library() from public, anon, authenticated;
grant execute on function police_ox_access.can_read_library() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'police-ox-shared', 'police-ox-shared', false, 50000000,
  array['application/json', 'application/gzip', 'application/x-gzip', 'application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists ox_library_get on storage.objects;
drop policy if exists ox_library_get_guard on storage.objects;
drop policy if exists ox_library_no_anon on storage.objects;
drop policy if exists ox_library_no_insert on storage.objects;
drop policy if exists ox_library_no_update on storage.objects;
drop policy if exists ox_library_no_delete on storage.objects;
drop policy if exists ox_library_admin_bucket on storage.buckets;

-- The restrictive policy applies even if another policy grants broad access.
create policy ox_library_get on storage.objects
  for select to authenticated using (bucket_id = 'police-ox-shared');

create policy ox_library_get_guard on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'police-ox-shared'
    or (
      storage.allow_only_operation('object.get_authenticated')
      and (
        name = 'current.json'
        or name ~ '^releases/[0-9a-f]{64}/(questions|explanations)[.]json[.]gz$'
      )
      and (select police_ox_access.can_read_library())
    )
  );

create policy ox_library_no_anon on storage.objects
  as restrictive for all to anon
  using (bucket_id <> 'police-ox-shared')
  with check (bucket_id <> 'police-ox-shared');

create policy ox_library_no_insert on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'police-ox-shared');

create policy ox_library_no_update on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'police-ox-shared')
  with check (bucket_id <> 'police-ox-shared');

create policy ox_library_no_delete on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id <> 'police-ox-shared');

create policy ox_library_admin_bucket on storage.buckets
  as restrictive for all to anon, authenticated
  using (id <> 'police-ox-shared')
  with check (id <> 'police-ox-shared');

commit;
