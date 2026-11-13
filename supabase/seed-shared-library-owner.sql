-- Run once as postgres after 202611130001_shared_library.sql.
-- Only use automatic selection on the existing single-owner project.
do $$
declare
  candidate_count bigint;
  candidate_email text;
begin
  select count(*), min(lower(btrim(email)))
    into candidate_count, candidate_email
  from auth.users
  where email_confirmed_at is not null
    and nullif(btrim(email), '') is not null
    and not is_anonymous
    and (banned_until is null or banned_until <= statement_timestamp());

  if candidate_count <> 1 then
    raise exception 'Owner bootstrap requires exactly one active, confirmed email account. Select the verified owner by UUID instead.';
  end if;

  insert into police_ox_access.allowed_emails (email)
  values (candidate_email)
  on conflict (email) do nothing;
end;
$$;

select count(*) as shared_library_allowed_count from police_ox_access.allowed_emails;
