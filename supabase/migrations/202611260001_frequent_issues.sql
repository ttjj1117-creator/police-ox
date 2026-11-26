-- Keep the original shared manifest and explanation payload backward compatible.
-- Only approved learners may fetch the two additional immutable sidecar paths.
begin;
drop policy if exists ox_library_get_guard on storage.objects;
create policy ox_library_get_guard on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'police-ox-shared'
    or (
      storage.allow_only_operation('object.get_authenticated')
      and (
        name = 'current.json'
        or name ~ '^releases/[0-9a-f]{64}/(questions|explanations)[.]json[.]gz$'
        or name = 'frequent-issues/current.json'
        or name ~ '^frequent-issues/releases/[0-9a-f]{64}/connections[.]json[.]gz$'
      )
      and (select police_ox_access.can_read_library())
    )
  );
commit;
