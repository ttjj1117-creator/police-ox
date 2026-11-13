-- Alternative to registering the Before User Created hook in hosted Auth.
-- Run after 202611130001_shared_library.sql and the initial owner registration.
begin;

create or replace function police_ox_access.enforce_signup_allowlist()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if public.police_ox_check_signup(jsonb_build_object(
    'user', jsonb_build_object('email', new.email, 'is_anonymous', new.is_anonymous)
  )) is distinct from '{}'::jsonb then
    raise exception 'police_ox_signup_email_not_allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function police_ox_access.enforce_signup_allowlist() from public, anon, authenticated;
grant execute on function police_ox_access.enforce_signup_allowlist() to supabase_auth_admin;

create or replace trigger police_ox_check_signup_before_insert
  before insert on auth.users
  for each row execute function police_ox_access.enforce_signup_allowlist();

commit;
