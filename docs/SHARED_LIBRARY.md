# 공용 문제·해설 배포

공용 자료는 Supabase의 비공개 `police-ox-shared` 버킷에 저장한다. 확인된 이메일이 허용 목록에 있는 로그인 계정은 현재 버전의 문제와 해설을 자동으로 받는다. 이 버킷에는 학습 기록, 체크, 개인 자료, 사용자 정보를 넣지 않는다. 원문과 OX의 개인 동기화 권한은 기존 계정 ID로 판단한다.

앱은 실제 학습 영역의 빈 문제은행과 빈 해설 라이브러리에 각각 자료를 처음 내려받는다. 원문 문제·해설은 이 기기에 저장되어 오프라인에서도 열 수 있다. 기존에 자료를 등록한 계정은 그 자료를 우선 사용한다. 새 배포 목록은 이후 빈 라이브러리의 초기 자료에 적용된다.

오류 신고는 원문 풀이의 ‘다시 보기’ 옆에서 문제·정답 또는 해설을 표시하는 기능이다. ‘신고 문항’에서 분류·검토 상태별로 확인하고 처리할 수 있다. 신고는 이 브라우저에 계정별로 저장되며 동기화와 전체 백업에는 포함되지 않는다.

## 초기 설정

1. 기존 동기화 프로젝트의 SQL Editor에서 [공용 자료 마이그레이션](../supabase/migrations/202611130001_shared_library.sql)을 실행한다.
2. 활성 상태인 확인된 이메일 계정이 기존 학습 계정 하나뿐이라면 [최초 계정 등록 SQL](../supabase/seed-shared-library-owner.sql)을 실행한다. 해당 조건에 맞는 계정이 없거나 여러 개면 이 SQL은 중단한다. 이때 Authentication → Users에서 본인 학습 계정의 UUID를 확인한 다음 아래 SQL의 UUID를 바꿔 실행한다. 기존 계정을 확인할 수 없으면 계정을 선택하기 전까지 등록을 보류한다.

   ```sql
   insert into police_ox_access.allowed_emails (email)
   select lower(btrim(email))
   from auth.users
   where id = '00000000-0000-0000-0000-000000000000'::uuid
     and email_confirmed_at is not null
     and nullif(btrim(email), '') is not null
     and not is_anonymous
     and (banned_until is null or banned_until <= statement_timestamp())
   on conflict (email) do nothing;
   ```

3. 신규 가입을 허용 목록으로 제한한다. Authentication → Auth Hooks → Before User Created에서 PostgreSQL 함수 `public.police_ox_check_signup`를 연결한다. 해당 설정을 열 수 없으면 SQL Editor에서 [가입 제한 트리거](../supabase/migrations/202611130002_shared_library_signup_trigger.sql)를 적용한다. 트리거는 Supabase Auth가 새 계정을 저장할 때 같은 검사 함수를 실행한다. 기존 확인 계정은 계속 로그인할 수 있다. Email 확인을 켜 두고, 훅이나 트리거가 적용된 상태에서 사용자 가입을 켜야 허용된 새 이메일이 앱에서 직접 가입할 수 있다. [대시보드 Auth Hooks](https://supabase.com/dashboard/project/_/auth/auth-hooks), [Before User Created](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook), [Auth 테이블의 트리거 지원](https://github.com/orgs/supabase/discussions/34270)
4. 허용 계정이 하나이고 학습자 이메일이 정해지지 않았을 때는 그 상태로 유지한다. 외부 이메일을 등록할 때는 프로젝트에 설정된 사용자 지정 SMTP로 로그인 메일을 수신할 수 있는지 확인한다. Supabase 기본 발송은 프로젝트 팀원 이메일에만 도달한다. [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

## 새 버전 올리기

1. 문제와 해설의 자료 전용 내보내기 JSON으로 배포 묶음을 만든다. 앱 루트에서 `node scripts/package-shared-library.mts --question <문제-파일> --instructor <강사-해설-파일>`을 실행하고 문항 수와 해설 연결 수를 확인한다. 파일이 여러 개면 옵션을 반복한다. 이전 형식 해설은 `--legacy`로 지정한다. 묶음은 Git에서 제외된 `scripts/private-release/`에 저장된다.
2. Supabase Dashboard의 Storage에서 `police-ox-shared`가 Private인지 확인한다. `releases/<releaseId>/` 폴더에 `questions.json.gz`와 `explanations.json.gz`를 올린다. 파일당 최대 50 MB다. gzip 파일은 압축된 바이트 그대로 올린다. 직접 API를 사용할 때는 MIME을 `application/gzip`으로 지정하고 `Content-Encoding`을 생략한다. 파일을 새로 만들 때만 업로드하고, 같은 ID 파일이 이미 있으면 배포 묶음과 일치하는지 확인한다. [Supabase Storage 업로드](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
3. 두 파일이 모두 업로드된 뒤 버킷 최상위에 `current.json`을 게시한다. 기존 파일이 있으면 Dashboard의 파일 교체 기능 또는 Storage API로 해당 경로를 덮어쓴다. Dashboard에서 같은 파일을 새로 업로드하면 이름에 번호가 붙을 수 있다. API로 올릴 때는 `application/json`, `cacheControl: '0'`과 `upsert: true`를 지정한다. 게시한 뒤 소유자 계정으로 다시 열어 현재 버전의 문제와 해설을 확인한다. [Supabase 파일 교체](https://supabase.com/docs/reference/javascript/file-buckets-update)
4. 배포만 되돌릴 때는 보관한 이전 `current.json`으로 교체한다. 이전 버전 파일 두 개가 Storage에 남아 있어야 한다. 허용 목록과 개인 동기화 자료에 손댈 필요가 없다.

## 이메일 추가 및 삭제

아래 예시 주소를 실제로 허용할 이메일로 바꿔 SQL Editor에서 실행한다. 해당 주소의 사용자가 앱에서 로그인 메일을 요청하고 이메일을 확인하면 가입된다. 트리거를 사용하는 경우 허용 목록 밖의 가입 시도에는 Supabase Auth가 일반 서버 오류를 반환한다. 해당 요청은 새 사용자 행을 만들거나 확인 메일을 보내는 단계로 진행하지 않는다. [Supabase Auth 가입 처리](https://github.com/supabase/auth/blob/master/internal/api/signup.go#L178-L237)

```sql
insert into police_ox_access.allowed_emails (email)
values (lower(btrim('learner@example.invalid')))
on conflict (email) do nothing;
```

접근을 취소할 때는 허용 목록의 행만 삭제한다. DB는 이후 Storage 원본 요청부터 해당 계정의 공용 파일 접근을 거부한다. Supabase Smart CDN을 쓰는 프로젝트에서는 기존 인증 응답이 CDN에 남을 수 있으므로 버킷의 CDN 캐시도 비운다. 이미 사용자 기기로 받은 사본은 서버에서 회수할 수 없다. [Supabase 인증 파일의 CDN 캐시](https://supabase.com/docs/guides/storage/cdn/smart-cdn#authenticated-urls-and-cdn-caching)

```sql
delete from police_ox_access.allowed_emails
where email = lower(btrim('learner@example.invalid'));
```

## 검증과 복구

- 테스트 프로젝트에 앱의 마이그레이션을 적용하고 [공용 자료 권한 테스트](../supabase/shared-library-rls-tests.sql)를 SQL Editor에서 통째로 실행한다. 가상 계정, 메타데이터, 테스트 정책은 마지막에 롤백한다.
- 최초 배포에서 확인된 소유자만 허용했다면 [운영 SQL 점검](../supabase/shared-library-live-check.sql)을 통째로 실행할 수 있다. 허용 목록, 함수 권한, 트리거 등록과 파일 메타데이터 접근을 확인하며 사용자나 파일을 만들지 않는다.
- 로그인 없이 `current.json`을 요청해 거부되는지 확인한다. 새 브라우저 프로필에서 소유자로 로그인한 뒤 개발자 도구의 Network에서 공용 버킷의 `current.json`과 두 파일의 응답을 확인한다. 개인 백업을 가져오기 전에 문제와 연결된 해설을 열어 본다. 학습자 이메일이 정해진 뒤에는 두 번째 프로필에서 계정 간 기록이 섞이지 않는지 확인한다.
- 가입 제한을 중지하거나 교체할 때는 Authentication → Sign In / Providers에서 먼저 `Allow new users to sign up`을 끄거나 대체 제한을 활성화한다. 트리거를 제거할 때는 [트리거 제거 SQL](../supabase/remove-shared-library-signup-trigger.sql)을 실행한다. 이 파일은 예상한 트리거만 해당 함수에 의존하는지 검사한다. [가입 설정](https://supabase.com/docs/guides/auth/general-configuration)
