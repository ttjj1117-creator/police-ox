-- Execute against an isolated local Supabase database AFTER the migration.
-- supabase test db supabase/rls-tests.sql (or psql -f ... with test DB owner).
-- Fixtures roll back. These tests exercise real PostgreSQL RLS/RPC, not a mock.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(24);
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','sync-rls-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','sync-rls-b@example.invalid');
insert into storage.objects(bucket_id,name,owner_id) values
 ('police-sync-private','11111111-1111-4111-8111-111111111111/real/test-body.json','11111111-1111-4111-8111-111111111111'),
 ('police-sync-private','22222222-2222-4222-8222-222222222222/real/test-body.json','22222222-2222-4222-8222-222222222222');
create function pg_temp.sync_test_event(event_id text, sequence integer, kind text default 'bank', base_version integer default 0, mark_version integer default null)
returns jsonb language sql as $$ select jsonb_build_object(
 'protocolVersion',1,'eventId',event_id,'deviceId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','deviceSequence',sequence,'baseCursor',0,'createdAt','2026-10-23T00:00:00Z','kind',kind,
 'bodyPath','11111111-1111-4111-8111-111111111111/real/test-body.json','bodySha256',repeat('0',64),'bodyBytes',100,
 'baseVersion',case when kind='bank' then base_version else null end,'markQuestionId',case when kind='mark' then 'const_2026_1_1' else null end,'baseMarkVersion',mark_version
) $$;
-- Current hosted Storage also rejects direct DELETE via a protection trigger.
-- Accept either that refusal or zero affected rows from RLS; never disable it.
create function pg_temp.sync_test_object_delete_denied()
returns boolean language plpgsql as $$
declare affected integer;
begin
  delete from storage.objects where bucket_id='police-sync-private' and name like '11111111-%';
  get diagnostics affected = row_count;
  return affected = 0;
exception when insufficient_privilege then
  return true;
end $$;
-- SQL Editor may display only the last result. Make failed TAP assertions
-- raise, so a successful entire script cannot hide an earlier "not ok" row.
create function pg_temp.sync_assert(result text)
returns text language plpgsql as $$
begin
  if result !~ '^ok [0-9]+ ' then raise exception 'RLS assertion failed: %', result; end if;
  return result;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.sync_assert(is((public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000001',1))->>'seq')::bigint,1::bigint,'own event accepted with server sequence'));
select pg_temp.sync_assert(is((public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000001',1))->>'duplicate')::boolean,true,'lost acknowledgement retry is idempotent'));
select pg_temp.sync_assert(is((select count(*) from public.police_sync_events),1::bigint,'retry did not create another event'));
select pg_temp.sync_assert(is((select count(*) from public.police_sync_heads),1::bigint,'owner can read its own head'));
select pg_temp.sync_assert(throws_ok($$insert into public.police_sync_heads(user_id) values('22222222-2222-4222-8222-222222222222')$$,'42501',null,'forged user_id insert is denied'));
select pg_temp.sync_assert(throws_ok($$update public.police_sync_heads set bank_version=999$$,'42501',null,'direct update cannot bypass CAS'));
select pg_temp.sync_assert(throws_ok($$delete from public.police_sync_events$$,'42501',null,'direct log deletion is denied'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000002',2))$$,'40001','bank_version_conflict','stale bank cannot resurrect deleted content'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000001',1)||jsonb_build_object('bodySha256',repeat('1',64)))$$,'23505','event_id_content_conflict','same event ID with changed body is rejected'));
select pg_temp.sync_assert(is((public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000003',3,'mark',null,0))->>'markVersion')::bigint,1::bigint,'first mark version accepted'));
select pg_temp.sync_assert(is((public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000004',4,'mark',null,1))->>'markVersion')::bigint,2::bigint,'mark unset has a retained newer version'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_push(pg_temp.sync_test_event('aaaaaaaa-0000-4000-8000-000000000005',5,'mark',null,0))$$,'40001','mark_version_conflict','offline old mark cannot undo unset'));
select pg_temp.sync_assert(is((public.police_sync_pull(0,1)->>'cursor')::bigint,1::bigint,'paged cursor advances only through returned rows'));
select pg_temp.sync_assert(is(jsonb_array_length(public.police_sync_pull(0,1)->'events'),1,'page limit enforced'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_pull(0,101)$$,'P0001','invalid_cursor_or_limit','oversize page is rejected'));
select pg_temp.sync_assert(is((select count(*) from storage.objects where bucket_id='police-sync-private'),1::bigint,'owner can select its own private object only'));
with changed as (update storage.objects set name=name where bucket_id='police-sync-private' returning 1) select pg_temp.sync_assert(is((select count(*) from changed),0::bigint,'even owner cannot overwrite immutable sync objects'));
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.sync_assert(is((select count(*) from public.police_sync_events),0::bigint,'second account cannot read first account events'));
select pg_temp.sync_assert(is(jsonb_array_length(public.police_sync_pull(0,100)->'events'),0,'RPC derives user boundary from authenticated caller'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_push(pg_temp.sync_test_event('bbbbbbbb-0000-4000-8000-000000000001',1))$$,'42501','invalid_private_body_reference','second account cannot submit first account body path'));
select pg_temp.sync_assert(is((select count(*) from storage.objects where bucket_id='police-sync-private'),1::bigint,'second account lists its own object only'));
select pg_temp.sync_assert(is(pg_temp.sync_test_object_delete_denied(),true,'second account cannot delete another account object (RLS or Storage guard)'));
reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','anon',true);
select pg_temp.sync_assert(throws_ok($$select * from public.police_sync_events$$,'42501',null,'anonymous table access denied'));
select pg_temp.sync_assert(throws_ok($$select public.police_sync_pull(0,100)$$,'42501',null,'anonymous RPC access denied'));
reset role;
select pg_temp.sync_assert(result) from finish() as summary(result);
rollback;
