-- Run AFTER both 202610230001_original_sync.sql and 202610230002_ox_sync.sql.
-- Execute the entire file as the database owner in an isolated test database,
-- or in an empty hosted project's SQL Editor. All fixtures roll back.
-- pgTAP assertions fail fast even if SQL Editor shows only the last result.
-- Storage fixtures are metadata only; this does not test actual uploaded bytes.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(54);

insert into auth.users(id,email) values
 ('33333333-3333-4333-8333-333333333333','ox-sync-rls-a@example.invalid'),
 ('44444444-4444-4444-8444-444444444444','ox-sync-rls-b@example.invalid');
insert into storage.objects(bucket_id,name,owner_id) values
 ('police-ox-sync-private','33333333-3333-4333-8333-333333333333/ox/test-body.json','33333333-3333-4333-8333-333333333333'),
 ('police-ox-sync-private','44444444-4444-4444-8444-444444444444/ox/test-body.json','44444444-4444-4444-8444-444444444444'),
 ('police-sync-private','33333333-3333-4333-8333-333333333333/real/original-test-body.json','33333333-3333-4333-8333-333333333333'),
 -- Deliberately malformed namespace metadata, seeded by the owner only.
 ('police-sync-private','33333333-3333-4333-8333-333333333333/ox/only-in-original.json','33333333-3333-4333-8333-333333333333'),
 ('police-ox-sync-private','33333333-3333-4333-8333-333333333333/real/only-in-ox.json','33333333-3333-4333-8333-333333333333');

create function pg_temp.ox_test_event(event_id text, sequence integer, kind text default 'bank', base_version integer default 0, mark_version integer default null)
returns jsonb language sql as $$ select jsonb_build_object(
 'protocolVersion',1,'eventId',event_id,'deviceId','cccccccc-cccc-4ccc-8ccc-cccccccccccc','deviceSequence',sequence,'baseCursor',0,'createdAt','2026-10-23T00:00:00Z','kind',kind,
 'bodyPath','33333333-3333-4333-8333-333333333333/ox/test-body.json','bodySha256',repeat('0',64),'bodyBytes',100,
 'baseVersion',case when kind='bank' then base_version else null end,
 'markQuestionId',case when kind='mark' then '["ox_test_item","current"]' else null end,
 'baseMarkVersion',mark_version
) $$;

create function pg_temp.ox_test_object_delete_denied()
returns boolean language plpgsql as $$
declare affected integer;
begin
  delete from storage.objects where bucket_id='police-ox-sync-private' and name like '33333333-%';
  get diagnostics affected = row_count;
  return affected = 0;
exception when insufficient_privilege then
  -- Hosted Storage may reject direct DELETE through a protection trigger.
  return true;
end $$;

create function pg_temp.ox_assert(result text)
returns text language plpgsql as $$
begin
  if result is null or result !~ '^ok [0-9]+ ' then raise exception 'OX RLS assertion failed: %', result; end if;
  return result;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claim.role','authenticated',true);

-- Account ownership, immutable event identity, and both CAS streams.
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000001',1))->>'seq')::bigint,1::bigint,'OX own event accepted with server sequence'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000001',1))->>'duplicate')::boolean,true,'OX retry after lost acknowledgement is idempotent'));
select pg_temp.ox_assert(is((select count(*) from public.police_ox_sync_events),1::bigint,'OX retry did not duplicate an event'));
select pg_temp.ox_assert(is((select count(*) from public.police_ox_sync_heads),1::bigint,'OX owner can read its own head'));
select pg_temp.ox_assert(throws_ok($$insert into public.police_ox_sync_heads(user_id) values('44444444-4444-4444-8444-444444444444')$$,'42501',null,'OX forged user_id insert is denied'));
select pg_temp.ox_assert(throws_ok($$update public.police_ox_sync_heads set bank_version=999$$,'42501',null,'OX direct update cannot bypass CAS'));
select pg_temp.ox_assert(throws_ok($$delete from public.police_ox_sync_events$$,'42501',null,'OX direct log deletion is denied'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000002',2))$$,'40001','bank_version_conflict','OX stale bank revision is rejected'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000001',1)||jsonb_build_object('bodySha256',repeat('1',64)))$$,'23505','event_id_content_conflict','OX reused event ID with different content is rejected'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000003',3,'mark',null,0))->>'markVersion')::bigint,1::bigint,'OX first current-basis mark version accepted'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000004',4,'mark',null,1))->>'markVersion')::bigint,2::bigint,'OX unset retains a newer mark version'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000005',5,'mark',null,0))$$,'40001','mark_version_conflict','OX offline stale mark cannot undo an unset'));
select pg_temp.ox_assert(is((public.police_ox_sync_pull(0,1)->>'cursor')::bigint,1::bigint,'OX paged cursor advances only through returned rows'));
select pg_temp.ox_assert(is(jsonb_array_length(public.police_ox_sync_pull(0,1)->'events'),1,'OX page limit is enforced'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_pull(0,101)$$,'P0001','invalid_cursor_or_limit','OX oversize page is rejected'));
select pg_temp.ox_assert(is((select count(*) from storage.objects where bucket_id='police-ox-sync-private'),1::bigint,'OX owner sees its own correct-namespace object only'));
with changed as (update storage.objects set name=name where bucket_id='police-ox-sync-private' returning 1)
 select pg_temp.ox_assert(is((select count(*) from changed),0::bigint,'OX even owner cannot overwrite immutable objects'));

-- OX activity never creates or increments original-question sync state.
select pg_temp.ox_assert(is((select count(*) from public.police_sync_heads),0::bigint,'OX events leave original-question heads untouched'));
select pg_temp.ox_assert(is((select count(*) from public.police_sync_events),0::bigint,'OX events leave original-question log untouched'));
select pg_temp.ox_assert(is((select count(*) from public.police_sync_marks),0::bigint,'OX marks leave original-question marks untouched'));

-- Namespace validation and exact bucket lookup work in both directions.
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000010',10)||jsonb_build_object('bodyPath','33333333-3333-4333-8333-333333333333/real/original-test-body.json'))$$,'42501','invalid_private_body_reference','OX RPC rejects original real namespace'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000011',11)||jsonb_build_object('bodyPath','33333333-3333-4333-8333-333333333333/ox/only-in-original.json'))$$,'P0001','body_not_uploaded','OX RPC cannot use an object stored only in original bucket'));
select pg_temp.ox_assert(throws_ok($$select public.police_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000012',12))$$,'42501','invalid_private_body_reference','original RPC rejects OX namespace'));
select pg_temp.ox_assert(throws_ok($$select public.police_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000013',13)||jsonb_build_object('bodyPath','33333333-3333-4333-8333-333333333333/real/only-in-ox.json'))$$,'P0001','body_not_uploaded','original RPC cannot use an object stored only in OX bucket'));
select pg_temp.ox_assert(throws_ok($$insert into storage.objects(bucket_id,name) values('police-ox-sync-private','33333333-3333-4333-8333-333333333333/real/spoof.json')$$,'42501',null,'OX bucket rejects original real namespace insert'));
select pg_temp.ox_assert(throws_ok($$insert into storage.objects(bucket_id,name) values('police-sync-private','33333333-3333-4333-8333-333333333333/ox/spoof.json')$$,'42501',null,'original bucket rejects OX namespace insert'));
select pg_temp.ox_assert(throws_ok($$insert into storage.objects(bucket_id,name) values('police-ox-sync-private','44444444-4444-4444-8444-444444444444/ox/spoof.json')$$,'42501',null,'OX bucket rejects another account path insert'));
select pg_temp.ox_assert(is((select count(*) from storage.objects where bucket_id='police-ox-sync-private' and name like '%/real/%'),0::bigint,'OX wrong-namespace fixture remains hidden from its owner'));
select pg_temp.ox_assert(is((select count(*) from storage.objects where bucket_id='police-sync-private' and name like '%/ox/%'),0::bigint,'original wrong-namespace fixture remains hidden from its owner'));

-- Both answer bases and all four event kinds share one OX cursor, not a bank CAS.
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000006',6,'mark',null,0)||jsonb_build_object('markQuestionId','["ox_test_item","exam"]'))->>'markVersion')::bigint,1::bigint,'OX exam-basis mark has independent version from current basis'));
select pg_temp.ox_assert(is((select version from public.police_ox_sync_marks where question_id='["ox_test_item","current"]'),2::bigint,'OX exam mark does not change current-basis unset version'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000007',7,'session',null))->>'seq')::bigint,5::bigint,'OX completed-session envelope accepted without bank CAS'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000008',8,'resolution',null))->>'seq')::bigint,6::bigint,'OX response-resolution envelope accepted'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000009',9,'bank',1))->>'bankVersion')::bigint,2::bigint,'OX matching bank CAS advances its own version'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000001',1))->>'bankVersion')::bigint,1::bigint,'OX old duplicate acknowledgement retains original bank version'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000014',1,'session',null))$$,'23505',null,'OX same device sequence cannot name a second event'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000015',15,'session',null)||jsonb_build_object('baseCursor',999))$$,'P0001','cursor_ahead_of_server','OX future causal cursor is rejected'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000016',16,'session',null)||jsonb_build_object('bodyBytes',1048577))$$,'42501','invalid_private_body_reference','OX body larger than private bucket limit is rejected'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000017',17,'unsupported',null))$$,'P0001','invalid_event_identity','OX unsupported event kind is rejected'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000018',18,'mark',null,0)||jsonb_build_object('markQuestionId','["'||repeat('x',512)||'","current"]'))->>'markVersion')::bigint,1::bigint,'OX encoded mark key may contain an item ID longer than 300 characters'));

select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('cccccccc-0000-4000-8000-000000000019',19,'mark',null,0)||jsonb_build_object('markQuestionId',(select jsonb_build_array(string_agg(md5(n::text),'' order by n)||'한글','current')::text from generate_series(1,160) as g(n))))->>'markVersion')::bigint,1::bigint,'OX long UTF-8 mark key exceeds btree tuple size without changing its original ID'));
select pg_temp.ox_assert(is((public.police_sync_push(pg_temp.ox_test_event('eeeeeeee-0000-4000-8000-000000000001',1)||jsonb_build_object('bodyPath','33333333-3333-4333-8333-333333333333/real/original-test-body.json'))->>'bankVersion')::bigint,1::bigint,'original-question RPC remains independently usable'));
select pg_temp.ox_assert(is((select bank_version from public.police_ox_sync_heads),2::bigint,'original-question upload leaves OX bank version unchanged'));
select pg_temp.ox_assert(is((select count(*) from public.police_ox_sync_events),9::bigint,'original-question upload leaves OX event count unchanged'));

-- A second account sees and modifies only its own partition.
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select pg_temp.ox_assert(is((select count(*) from public.police_ox_sync_events),0::bigint,'OX second account cannot read first account events'));
select pg_temp.ox_assert(is(jsonb_array_length(public.police_ox_sync_pull(0,100)->'events'),0,'OX pull derives partition from authenticated caller'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_push(pg_temp.ox_test_event('dddddddd-0000-4000-8000-000000000001',1))$$,'42501','invalid_private_body_reference','OX second account cannot submit first account body path'));
select pg_temp.ox_assert(is((select count(*) from storage.objects where bucket_id='police-ox-sync-private'),1::bigint,'OX second account lists its own object only'));
select pg_temp.ox_assert(is(pg_temp.ox_test_object_delete_denied(),true,'OX second account cannot delete another account object'));
select pg_temp.ox_assert(is((public.police_ox_sync_push(pg_temp.ox_test_event('dddddddd-0000-4000-8000-000000000002',2)||jsonb_build_object('bodyPath','44444444-4444-4444-8444-444444444444/ox/test-body.json'))->>'bankVersion')::bigint,1::bigint,'OX second account has an independent initial bank version'));
select pg_temp.ox_assert(is((select count(*) from public.police_sync_heads),0::bigint,'OX second account activity does not create original-question head'));

reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','anon',true);
select pg_temp.ox_assert(throws_ok($$select * from public.police_ox_sync_events$$,'42501',null,'OX anonymous table access denied'));
select pg_temp.ox_assert(throws_ok($$select public.police_ox_sync_pull(0,100)$$,'42501',null,'OX anonymous RPC access denied'));
select pg_temp.ox_assert(throws_ok($$select public.police_sync_pull(0,100)$$,'42501',null,'original anonymous RPC restriction remains in place'));

reset role;
select pg_temp.ox_assert(result) from finish() as summary(result);
rollback;
