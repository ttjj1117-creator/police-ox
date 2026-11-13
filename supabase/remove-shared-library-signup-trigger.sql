-- First disable open signup or activate the Before User Created hook.
-- Run as the role that owns the app's trigger function.
begin;

do $$
declare
  function_id oid := to_regprocedure('police_ox_access.enforce_signup_allowlist()');
  trigger_id oid;
begin
  if function_id is null then
    return;
  end if;

  select oid into trigger_id from pg_trigger
  where tgrelid = 'auth.users'::regclass
    and tgname = 'police_ox_check_signup_before_insert'
    and tgfoid = function_id
    and not tgisinternal;

  if exists (
    select 1 from pg_depend
    where refclassid = 'pg_proc'::regclass and refobjid = function_id
      and not (classid = 'pg_trigger'::regclass and objid is not distinct from trigger_id)
  ) then
    raise exception 'Unexpected dependency on the shared-library signup trigger function';
  end if;

  -- Hosted postgres can own this function without owning auth.users.
  drop function police_ox_access.enforce_signup_allowlist() cascade;
end;
$$;

commit;
