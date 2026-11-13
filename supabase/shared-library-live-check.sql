-- Read-only smoke check for the initial release with one confirmed owner.
-- Run the whole file as postgres after uploading the release files.
begin read only;

do $$
declare
  owner_id uuid;
  owner_email text;
  rejected_email text := gen_random_uuid()::text || '@example.invalid';
begin
  select account.id, account.email into strict owner_id, owner_email
  from auth.users as account
  join police_ox_access.allowed_emails as entry
    on entry.email = lower(btrim(account.email))
  where account.email_confirmed_at is not null
    and not account.is_anonymous
    and (account.banned_until is null or account.banned_until <= statement_timestamp());

  if (select count(*) from police_ox_access.allowed_emails) <> 1
    or public.police_ox_check_signup(jsonb_build_object('user', jsonb_build_object('email', owner_email))) <> '{}'::jsonb
    or (public.police_ox_check_signup(jsonb_build_object('user', jsonb_build_object('email', rejected_email)))
      #>> '{error,http_code}') is distinct from '403'
  then
    raise exception 'Shared library owner bootstrap or signup function check failed';
  end if;

  if not (
    has_schema_privilege('supabase_auth_admin', 'public', 'USAGE')
    and has_schema_privilege('supabase_auth_admin', 'police_ox_access', 'USAGE')
    and has_table_privilege('supabase_auth_admin', 'police_ox_access.allowed_emails', 'SELECT')
    and has_function_privilege('supabase_auth_admin', 'public.police_ox_check_signup(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.police_ox_check_signup(jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.police_ox_check_signup(jsonb)', 'EXECUTE')
    and exists (
      select 1 from pg_policies
      where schemaname = 'police_ox_access'
        and tablename = 'allowed_emails'
        and policyname = 'ox_signup_check_emails'
        and 'supabase_auth_admin' = any (roles)
        and cmd = 'SELECT'
    )
  ) then
    raise exception 'Shared library signup hook role permissions check failed';
  end if;

  if (select public from storage.buckets where id = 'police-ox-shared') is distinct from false then
    raise exception 'Shared library bucket is missing or public';
  end if;

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('storage.operation', 'storage.object.get_authenticated', true);
end;
$$;

set local role authenticated;
do $$
begin
  if not exists (select 1 from storage.objects where bucket_id = 'police-ox-shared' and name = 'current.json')
    or not exists (
      select 1 from storage.objects as questions
      join storage.objects as explanations on explanations.bucket_id = questions.bucket_id
        and explanations.name = replace(questions.name, '/questions.json.gz', '/explanations.json.gz')
      where questions.bucket_id = 'police-ox-shared'
        and questions.name ~ '^releases/[0-9a-f]{64}/questions[.]json[.]gz$'
    )
  then
    raise exception 'Shared library manifest or paired release files are not readable by the owner';
  end if;

  perform set_config('storage.operation', 'storage.object.sign', true);
  if exists (select 1 from storage.objects where bucket_id = 'police-ox-shared') then
    raise exception 'Shared library files are visible to the signing operation';
  end if;

  perform set_config('storage.operation', 'storage.object.get_authenticated', true);
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  if exists (select 1 from storage.objects where bucket_id = 'police-ox-shared') then
    raise exception 'Shared library files are visible without an allowlisted identity';
  end if;
end;
$$;

set local role anon;
do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'police-ox-shared') then
    raise exception 'Shared library files are visible to anonymous requests';
  end if;
end;
$$;

reset role;
select 'Shared library owner, signup function, and metadata access verified' as result, exists (
  select 1
  from pg_trigger as installed
  where installed.tgrelid = 'auth.users'::regclass
    and installed.tgname = 'police_ox_check_signup_before_insert'
    and installed.tgfoid = to_regprocedure('police_ox_access.enforce_signup_allowlist()')
    and installed.tgenabled in ('O', 'A')
    and installed.tgtype = 7 -- row-level BEFORE INSERT
    and not installed.tgisinternal
) as signup_trigger_enabled;
rollback;
