# 실제 Supabase 연결 검증

2026-10-23. 모의 서버 자동화와 구분한 실제 서비스 설정 결과다.

## 완료한 서버 설정

- 사용자가 Supabase에 GitHub 계정으로 로그인했다.
- 개인 조직 `경찰 기출 학습`의 현재 Free 요금제에서 `police-ox-sync` 프로젝트를 생성했다. 지역은 Seoul이다.
- 프로젝트 주소: `https://sawcuuptzycrvjqzkhya.supabase.co`.
- Data API 활성화, 새 테이블 자동 노출 비활성화, 자동 RLS 활성화 상태로 생성했다.
- 사용자 승인 뒤 동기화 migration 전체를 실제 SQL Editor에서 실행했다. 본인 데이터만 허용하는 세 테이블과 두 RPC, 비공개 `police-sync-private` 버킷·정책을 설치했다.
- 실제 PostgreSQL pgTAP **24/24**를 두 격리 사용자 역할로 실행했다. 각 실패 결과가 예외를 발생시키도록 하여 SQL Editor의 마지막 결과만 보고 이전 실패를 놓치지 않게 했다.
- 확인 범위: 소유권 분리, 위조 user_id/비로그인 차단, 중복 전송, 은행·표시 CAS, 커서 페이지, 비공개 객체 조회·수정·삭제 거부.
- 검사는 BEGIN~ROLLBACK 안에서 실행했고, 종료 뒤 테스트 사용자 0명·동기화 이벤트 0건을 확인했다. 세 테이블 RLS는 활성화, 버킷 public은 false, 비로그인 SELECT와 직접 로그 INSERT 권한은 false였다.
- Site URL은 `https://ttjj1117-creator.github.io/police-ox/`로 저장했다. Email provider와 이메일 확인은 기본 활성화를 유지했다. 현재 OTP 기본값은 8자리·3600초다.
- 기존 GitHub 저장소의 Actions Repository variables에 `VITE_SUPABASE_URL`과 `VITE_SUPABASE_PUBLISHABLE_KEY`를 등록하고 화면에서 값을 확인했다. 관리자 키는 사용하지 않았다. 로컬 앱의 ignored `.env.local`도 같은 공개 연결값을 사용한다.
- 실제 HTTP에서 Auth settings 응답은 200·Email 활성화였고, 비로그인 동기화 RPC는 401/42501로 거부됐다.
- GitHub Settings → Pages에서 기존 웹 주소가 활성 상태이고 Source가 GitHub Actions이며 HTTPS가 강제되는 것을 확인했다. 아직 새 앱 배포 완료를 의미하지 않는다.

실제 검사에서 PL/pgSQL 지역 변수를 함수 이름으로 한정한 오류를 발견해 명시적인 `sync_request` 블록 이름으로 수정했다. RLS 검사의 데이터 변경 CTE도 최상위로 고쳤다. 현재 hosted Storage의 직접 DELETE 보호 trigger를 끄지 않고, RLS의 0행 변경 또는 보호 장치의 권한 거부를 검사한다.

## 메일 방식과 제약

현재 Free 화면은 기본 메일 템플릿 변경에 별도 SMTP 또는 Pro 요금제를 요구하며 기본 메일은 로그인 링크만 보낸다. 사용자는 결제·추가 서비스 가입 없이 진행하기를 원했다. 기본 로그인 링크도 앱에서 지원하고, 인증번호 템플릿을 사용할 수 있는 프로젝트에서는 기존 OTP 입력을 유지하는 경로를 준비한다.

Supabase 기본 메일 발송은 조직 팀원 이메일에 한정되며 현재 문서상 시간당 2통, best effort다. 이 제한을 피하기 위해 이메일 확인을 끄지 않는다. 영구 무료나 메일 수신을 보장하지 않는다. [공식 SMTP 문서](https://supabase.com/docs/guides/auth/auth-smtp), [공식 passwordless 문서](https://supabase.com/docs/guides/auth/auth-email-passwordless).

## 다음 확인

이메일 링크 수신·계정 경계 검사 26개를 포함해 전체 단위·통합 **301/301**, 브라우저 **35개 항목**, 앱·도구 TypeScript와 production build가 통과했다. 브라우저는 전체 실행 32개와 설정 패널을 여는 시험 준비 보완 후 모의 동기화 3개 재실행으로 확인했다. Pages 반영·실제 이메일 로그인·PC↔갤탭 사용 확인은 이어서 진행한다. 이 문서는 완료한 실제 SQL 검사를 실제 메일·기기 동기화 성공으로 확대하지 않는다.

검토 화면과 실제 결과 PNG는 로컬 작업 보조 폴더에 보관했다. DB 비밀번호는 코드·GitHub에 포함하지 않고 Windows DPAPI CurrentUser로 암호화해 별도 로컬 보관했다.
