-- Run the three app migrations first, then run this whole file as postgres
-- on an isolated Supabase database. Fixtures and permissive test policies roll back.
-- This tests SQL authorization using metadata. Verify real downloads separately.
begin;

create function pg_temp.assert(condition boolean, description text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then
    raise exception 'Shared library assertion failed: %', description;
  end if;
end;
$$;

create function pg_temp.expect_permission_error(statement text, description text)
returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Shared library assertion failed: %', description;
exception
  when insufficient_privilege then null;
end;
$$;

insert into police_ox_access.allowed_emails (email) values
  ('ox-shared-a@example.invalid'),
  ('ox-shared-b@example.invalid'),
  ('ox-shared-c@example.invalid'),
  ('ox-shared-d@example.invalid');

insert into auth.users (id, email, email_confirmed_at, banned_until) values
  ('e4510000-0000-4000-8000-000000000001', 'Ox-Shared-A@example.invalid', now(), null),
  ('e4510000-0000-4000-8000-000000000002', 'ox-shared-b@example.invalid', now(), null),
  ('e4510000-0000-4000-8000-000000000003', 'ox-shared-c@example.invalid', null, null),
  ('e4510000-0000-4000-8000-000000000004', 'ox-shared-d@example.invalid', now(), now() + interval '1 hour');

delete from police_ox_access.allowed_emails where email = 'ox-shared-b@example.invalid';

insert into storage.objects (bucket_id, name) values
  ('police-ox-shared', 'current.json'),
  ('police-ox-shared', 'releases/' || repeat('a', 64) || '/questions.json.gz'),
  ('police-ox-shared', 'releases/' || repeat('a', 64) || '/explanations.json.gz'),
  ('police-ox-shared', 'releases/' || repeat('a', 64) || '/private-backup.json.gz'),
  ('police-ox-shared', 'releases/' || repeat('Z', 64) || '/questions.json.gz'),
  ('police-ox-sync-private', 'e4510000-0000-4000-8000-000000000001/ox/own-a.json'),
  ('police-ox-sync-private', 'e4510000-0000-4000-8000-000000000002/ox/own-b.json'),
  ('police-sync-private', 'e4510000-0000-4000-8000-000000000001/real/own-a.json'),
  ('police-sync-private', 'e4510000-0000-4000-8000-000000000002/real/own-b.json');

insert into public.police_ox_sync_heads (user_id) values
  ('e4510000-0000-4000-8000-000000000001'),
  ('e4510000-0000-4000-8000-000000000002');

create policy ox_library_test_broad_objects on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'police-ox-shared') with check (bucket_id = 'police-ox-shared');
create policy ox_library_test_broad_buckets on storage.buckets
  for all to anon, authenticated
  using (id = 'police-ox-shared') with check (id = 'police-ox-shared');

select pg_temp.assert(
  (select not public from storage.buckets where id = 'police-ox-shared'),
  'shared bucket is private'
);
select pg_temp.assert(
  has_schema_privilege('supabase_auth_admin', 'public', 'USAGE')
  and has_schema_privilege('supabase_auth_admin', 'police_ox_access', 'USAGE')
  and has_table_privilege('supabase_auth_admin', 'police_ox_access.allowed_emails', 'SELECT')
  and has_function_privilege('supabase_auth_admin', 'public.police_ox_check_signup(jsonb)', 'EXECUTE')
  and not has_table_privilege('supabase_auth_admin', 'police_ox_access.allowed_emails', 'INSERT')
  and exists (
    select 1 from pg_policies
    where schemaname = 'police_ox_access'
      and tablename = 'allowed_emails'
      and 'supabase_auth_admin' = any (roles)
      and cmd = 'SELECT'
  ),
  'Auth can read the allowlist through its restricted hook'
);

select pg_temp.assert(
  public.police_ox_check_signup('{"user":{"email":"  OX-SHARED-A@EXAMPLE.INVALID  ","is_anonymous":false}}') = '{}'::jsonb,
  'normalizes signup email before checking the allowlist'
);
select pg_temp.assert(
  public.police_ox_check_signup('{"user":{"email":"ox-shared-b@example.invalid"}}') #>> '{error,http_code}' = '403',
  'rejects an unlisted address'
);
select pg_temp.assert(
  public.police_ox_check_signup('{"user":{"email":"ox-shared-a@example.invalid","is_anonymous":true}}') #>> '{error,http_code}' = '403',
  'rejects anonymous signup'
);
select pg_temp.assert(
  public.police_ox_check_signup('{"user":{"phone":"+10000000000"}}') #>> '{error,http_code}' = '403',
  'rejects signup without an email'
);

-- Match the context set by the authenticated Storage download route.
select set_config('storage.operation', 'storage.object.get_authenticated', true);
set local role anon;
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'anonymous clients cannot read shared files even with a broad permissive policy'
);
select pg_temp.expect_permission_error(
  $$select public.police_ox_check_signup('{"user":{"email":"ox-shared-a@example.invalid"}}')$$,
  'anonymous clients cannot query membership through the hook'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e4510000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"email":"stale@example.invalid"}', true);
select pg_temp.assert(
  (select count(*) = 3 from storage.objects where bucket_id = 'police-ox-shared'),
  'allowlisted confirmed account can GET only the manifest and the two release files'
);
select pg_temp.expect_permission_error(
  $$select * from police_ox_access.allowed_emails$$,
  'confirmed readers cannot enumerate allowed addresses'
);
select pg_temp.expect_permission_error(
  $$select public.police_ox_check_signup('{"user":{"email":"ox-shared-a@example.invalid"}}')$$,
  'confirmed readers cannot call the signup hook'
);
select pg_temp.expect_permission_error(
  $$insert into police_ox_access.allowed_emails values ('unauthorized@example.invalid')$$,
  'confirmed readers cannot grant access to another address'
);
select pg_temp.expect_permission_error(
  $$insert into storage.objects (bucket_id, name) values ('police-ox-shared', 'client-upload.json')$$,
  'confirmed readers cannot upload even with a broad permissive policy'
);
with changed as (
  update storage.objects set name = 'renamed.json'
  where bucket_id = 'police-ox-shared' and name = 'current.json' returning 1
)
select pg_temp.assert((select count(*) = 0 from changed), 'confirmed readers cannot overwrite');
-- Storage itself applies this setting to API deletes. RLS must still deny them.
select set_config('storage.allow_delete_query', 'true', true);
with deleted as (
  delete from storage.objects
  where bucket_id = 'police-ox-shared' and name = 'current.json' returning 1
)
select pg_temp.assert((select count(*) = 0 from deleted), 'confirmed readers cannot delete');
with changed as (
  update storage.buckets set public = true where id = 'police-ox-shared' returning 1
)
select pg_temp.assert((select count(*) = 0 from changed), 'confirmed readers cannot make the bucket public');

select set_config('storage.operation', 'storage.object.list', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'confirmed readers cannot list files'
);
select set_config('storage.operation', 'storage.object.sign', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'confirmed readers cannot create shareable signed URLs'
);
select set_config('storage.operation', '', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'there is no SQL read access outside a Storage GET'
);

select set_config('storage.operation', 'storage.object.get_authenticated', true);
select set_config('request.jwt.claim.sub', 'e4510000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"email":"ox-shared-a@example.invalid","user_metadata":{"email":"ox-shared-a@example.invalid","email_verified":true}}', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'unlisted account cannot use token email or metadata as proof of membership'
);
select pg_temp.assert(
  (select array_agg(user_id::text) from public.police_ox_sync_heads) =
    array['e4510000-0000-4000-8000-000000000002'],
  'unlisted account keeps access to its own OX sync only'
);
select pg_temp.assert(
  (select array_agg(name) from storage.objects where bucket_id = 'police-ox-sync-private') =
    array['e4510000-0000-4000-8000-000000000002/ox/own-b.json'],
  'unlisted account keeps its original OX private object access'
);
select pg_temp.assert(
  (select array_agg(name) from storage.objects where bucket_id = 'police-sync-private') =
    array['e4510000-0000-4000-8000-000000000002/real/own-b.json'],
  'unlisted account keeps its original private object access'
);

select set_config('request.jwt.claim.sub', 'e4510000-0000-4000-8000-000000000003', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'allowlisted address must be confirmed'
);
select set_config('request.jwt.claim.sub', 'e4510000-0000-4000-8000-000000000004', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'banned account cannot fetch shared files'
);
reset role;

delete from police_ox_access.allowed_emails where email = 'ox-shared-a@example.invalid';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e4510000-0000-4000-8000-000000000001', true);
select pg_temp.assert(
  (select count(*) = 0 from storage.objects where bucket_id = 'police-ox-shared'),
  'database removes read access for an already-issued session after allowlist removal'
);
reset role;

select 'Shared library SQL assertions passed' as result;
rollback;
