# 웹 배포·PWA 연결 안내

작성·검증일: 2026-10-23. 기준 앱은 `C:\Users\INTEL\Documents\Codex\police-ox`다.

실제 연결 현황은 [실서비스 검증](LIVE_CONNECTION_VERIFICATION.md)을 따른다. 개인 Free 프로젝트를 생성하고 SQL/RLS 24개 검증, Site URL과 GitHub 공개 변수 등록을 마쳤다. 현재 Free 기본 메일의 로그인 링크도 앱에서 지원한다. 아래 절차는 재설정·다른 프로젝트 연결 시 참고한다.

기존 GitHub 웹 주소를 그대로 사용한다. GitHub Pages는 앱 화면을 제공하고, Supabase는 로그인과 개인 기록을 보관한다. PC 서버를 켜 두어야 하는 구성은 아니다. Supabase 연결값이 없을 때도 로컬 학습·가져오기·전체 백업은 계속 작동한다.

## 확인한 기존 배포

| 항목 | 확인 내용 |
|---|---|
| 기존 공개 저장소 | `ttjj1117-creator/police-ox`, 기본 브랜치 `main` |
| 기존 작업 복제본 | `C:\Users\INTEL\Documents\Codex\police-ox-github` |
| 비교 시점 커밋 | `d8c06299d836f2a08d106d5caf80628ef609e6aa` |
| 기존 workflow | `.github/workflows/deploy-pages.yml` 재사용 |
| 정식 URL 후보 | `https://ttjj1117-creator.github.io/police-ox/` |
| 현재 기준 앱 | Git 저장소가 아닌 기존 폴더. 이 폴더에 `git init`하거나 강제 push하지 않음 |

연결된 GitHub 읽기 도구로 공개 저장소와 기존 workflow·Vite 설정을 확인했고, 위 작업 복제본의 파일과 일치했다. 복제본은 비교 당시 깨끗했으며 추적 파일 46개에 `sources/`, `conversion/`, PDF, 개인 백업, `.env`가 없었다. 기준 앱과 기존 복제본의 package/lockfile은 다르므로 기존 파일을 통째로 덮어쓰지 말고 작업 브랜치에서 차이를 검토하여 통합한다. 기존 원격에는 `vite-plugin-pwa`의 자동 업데이트 설정과 별도 도구 스크립트가 있었고, 이번 기준 앱은 현재 고정된 의존성으로 정적 PWA를 구현했다.

통합 전 파일 내용 비교에서는 동일 4개·변경 29개·원격에만 존재 13개를 확인했다. 통합 작업 시 기존 복제본의 `codex/tablet-cloud-sync` 작업 브랜치에 허용한 앱 소스를 반영했다. 원격 전용 OX 삭제 UI/도메인, 등록 문제 목록, 최종화 CLI·테스트·문서를 보존하고 기준 PC 앱에도 선택 병합했다. 원격의 낮은 정보성 datasetVersion 부분 병합 규칙과 기준 앱의 해설 highlights 검증을 함께 유지한다. 기존 등록 경로 `src/register-pwa.ts`는 새 native PWA 등록으로 대체했다. 최종 검증·게시·배포 진행은 `IMPLEMENTATION_VERIFICATION.md`와 해당 PR에서 확인한다.

기존 원격 package-lock과 고정 개발 도구 버전을 유지하고 `test:e2e` 스크립트만 현재 호환 runner로 연결했다. 프레임워크를 업그레이드하지 않았다. 소스·계약·테스트·문서·SQL·설정만 통합했으며 시험 원본, 변환 결과, 개인 백업, 실제 환경변수, 출력 디렉터리는 포함하지 않았다. 비공개 변환 JSON을 읽던 강조 테스트는 같은 구조의 중립 합성 자료로 바꾸어 공개 CI에서 실제 시험 파일을 요구하지 않는다. OX 부분 반입·삭제·최종화·강조·목차 관련 39/39 테스트와 앱/도구 TypeScript 검사를 통과했고, 최종 허용 목록을 작업 복제본에 다시 동기화했다. 전체 검증 수는 최종 검증 문서를 따른다.

이 문서를 작성한 환경에서는 외부 사이트 HTTP 요청이 로컬 프록시 연결 오류로 막혔다. 후보 주소의 현재 응답이나 새 버전 공개 배포 완료를 확인한 것으로 해석하지 않는다. 배포 후 GitHub Actions의 `Deploy to GitHub Pages` 결과와 저장소 Settings → Pages에 표시되는 실제 URL을 확인한다.

## 설정과 재현 절차

1. Supabase에 로그인해 개인 기록을 보관할 프로젝트 하나를 만든다. 이미 사용하는 프로젝트가 있다면 먼저 재사용 가능 여부를 확인한다. 데이터베이스 암호는 앱이나 GitHub에 넣지 않는다.
2. 그 프로젝트의 SQL Editor에서 `supabase/migrations/202610230001_original_sync.sql`을 실행한다. 사용자별 RLS, 동기화 RPC와 비공개 `police-sync-private` Storage 정책이 함께 설치된다. 실제 프로젝트에 적용하기 전 격리된 테스트 프로젝트에서 `supabase/rls-tests.sql`을 실행해 확인한다.
3. Authentication → Sign In / Providers에서 Email 로그인과 이메일 확인을 유지한다. 현재 Free 기본 메일은 로그인 링크를 보내므로 앱의 `로그인 메일 받기`를 사용하고, 메일 링크를 앱을 사용할 브라우저에서 연다. 링크의 인증 정보는 주소에서 즉시 제거하고 서버로 계정을 검증한 뒤 로그인한다. 인증번호 템플릿을 사용할 수 있는 프로젝트에서는 `{{ .Token }}`을 넣고 기존 6~10자리 번호 입력도 사용할 수 있다. 이번 연결은 결제·추가 메일 서비스 가입 없이 기본 링크를 사용한다. [Supabase passwordless 문서](https://supabase.com/docs/guides/auth/auth-email-passwordless)
4. Authentication → URL Configuration의 Site URL을 실제 Pages 주소로 설정한다. 기본 메일은 조직 팀원 이메일에만 발송되며 현재 공식 문서상 시간당 2통, best effort로 제한된다. 본인 Supabase 계정 이메일로 로그인하고, 제한에 걸리면 기다린 뒤 재시도한다. 이 제약을 피하려고 이메일 확인을 끄지 않는다. 별도 SMTP를 사용하기로 한 경우에만 해당 관리 화면에서 설정하며 SMTP 비밀번호는 공개 코드에 넣지 않는다. [Supabase SMTP 문서](https://supabase.com/docs/guides/auth/auth-smtp)
5. 프로젝트의 Connect/API 설정에서 **Project URL**과 `sb_publishable_`로 시작하는 **publishable key** 두 값만 가져온다. 앱의 `계정·기기 동기화` → `동기화 서버 연결 설정`에 입력하고 `공개 연결값 저장`을 누르면 해당 브라우저에서 바로 사용할 수 있다. 같은 두 값은 아래 GitHub Repository variables에 등록하면 모든 기기에 기본 제공된다. secret key·service_role·DB 암호·관리 토큰을 입력하지 않는다. 공개용 키의 권한 경계는 서버 RLS가 담당한다. [Supabase API 키 문서](https://supabase.com/docs/guides/getting-started/api-keys)

서비스 요금, 저장 용량과 메일 발송 조건은 계정에 실제 표시되는 조건을 확인한다. 영구 무료를 전제로 하지 않는다.

## GitHub Actions 설정과 통합

저장소 Settings → Secrets and variables → Actions → **Variables**에 다음 두 Repository variables를 등록한다.

| 이름 | 값 |
|---|---|
| `VITE_SUPABASE_URL` | `https://프로젝트식별자.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 해당 프로젝트의 `sb_publishable_…` 공개용 키 |

`.env.example`은 빈 공개 설정 예시다. 로컬 개발에는 무시되는 `.env.local`을 사용할 수 있고, 설정 없는 로컬 앱도 유지된다. Vite의 `VITE_` 값은 공개 번들에 포함될 수 있으므로 관리자 값을 넣지 않는다.

기존 저장소 작업 복제본에서 최신 `main`과 사용자 변경을 확인하고 검토용 브랜치에 앱 소스·계약·테스트·SQL·문서·설정만 통합한다. `sources/`, `conversion/`, 개인 JSON/백업, `.env*` 실제 값, `node_modules`, 빌드·테스트 출력은 공개 커밋 대상이 아니다. 기존 원격의 별도 도구 파일과 package/lockfile 차이를 확인해 보존 여부를 결정한다. 기존 PWA 등록 파일을 함께 실행하지 않도록 `src/main.tsx`의 새 등록 경로 하나만 사용한다.

Settings → Pages의 Source가 GitHub Actions인지 확인한다. 검토된 변경을 기존 `main`에 반영하면 같은 이름의 workflow가 `npm ci` → `npm test` → `npm run build` → `dist` 업로드 → Pages 배포 순서로 실행된다. 배포 job만 `pages: write`, `id-token: write` 권한을 가지며 환경은 `github-pages`다. [GitHub Pages workflow 문서](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

workflow는 `VITE_BASE_PATH=/police-ox/`를 전달한다. 로컬 기본값 `/`와 Pages 하위 경로를 함께 지원하며, Vite가 HTML·JS·CSS 경로를 맞춘다. `vite preview`는 개발 환경의 빌드 확인용이다. [Vite 정적 배포 문서](https://vite.dev/guide/static-deploy)

배포 주소의 기본 화면은 원문 실제 학습이다. 명시적인 원문 주소는 `/police-ox/?view=original&mode=real`, 기존 OX는 `/police-ox/?view=ox&mode=real`이다. 기존 로컬 `http://127.0.0.1:5173/?mode=real` 진입은 유지한다.

## 공개 산출물 검사

`build/pwa.mjs`의 빌드 플러그인이 매 production build에서 다음을 검사한다.

- `public/`에는 manifest와 기존 192/512 PNG 아이콘 두 개만 허용한다.
- 번들 모듈 그래프에서 `sources/`, `conversion/`, `ExplanationPreview` 유입을 거부한다. 실제 80문항 변환 JSON을 읽는 로컬 설명 미리보기 HTML은 production entry에서 제외했다.
- `dist`에는 `index.html`, 해시가 붙은 `assets/*.js`·`*.css`, manifest·아이콘·생성된 `sw.js`만 허용한다. PDF·백업·예상 밖 파일은 실패시킨다.
- 텍스트 산출물에 Supabase secret key 또는 service-role JWT가 보이면 빌드를 실패시킨다. 원본 법률 자료를 공개 디렉터리에 복사하는 우회 경로를 만들지 않는다.

출력에는 분류·목차 같은 공개 앱 메타데이터와 명확한 중립 시연 자료가 들어간다. 실제 문제은행·그림·학습 기록은 사용자가 가져오거나 자신의 비공개 동기화 저장소에서 내려받는다.

## PWA 동작

manifest는 이름, 언어, 기존 아이콘, `start_url=./?view=original&mode=real`, `scope=./`, standalone을 설정한다. 배포 후 Chrome 메뉴의 설치/홈 화면 추가 기능을 사용할 수 있다. 브라우저별 설치 표시는 다를 수 있으며 일반 브라우저 실행도 지원한다. [MDN PWA 설치 조건](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)

production에서만 `sw.js`를 등록한다. 현재 빌드의 정확한 정적 파일 목록을 SHA-256 기반 캐시 이름으로 저장하고, 오프라인의 같은 앱 경로에는 미리 저장한 HTML을 반환한다. API·인증 응답·Authorization 요청·개인 백업·그림 원본 동기화 응답은 service worker 공용 캐시에 저장하지 않는다. 개인 데이터와 내려받은 문항 자산은 기존 계정별 IndexedDB 저장 계층이 보관한다.

새 버전은 대기 상태로 알리고 자동 교체·새로고침하지 않는다. `앱 업데이트 적용`을 누르면 화면의 진행 상태와 같은 브라우저의 OX·원문·계정별 저장 영역의 활성 세션을 확인한다. 진행 중 풀이가 있으면 답안·타이머를 유지하고 보류한다. 풀이가 없을 때 명시적으로 적용한 탭만 안전 상태를 다시 확인한 뒤 재실행한다. 다른 탭은 강제로 새로고침하지 않는다. 기존 버전의 해시 파일 캐시는 보수적으로 유지하며 IndexedDB·대기열을 지우는 캐시 정리를 수행하지 않는다.

브라우저를 완전히 닫은 뒤 백그라운드 전송을 보장하지 않는다. 다시 앱을 열고 연결하면 미전송 기록을 재시도한다. 브라우저 데이터 삭제나 앱 삭제를 기록 보존 방법으로 사용하지 말고 전체 백업을 함께 보관한다.

## 재현한 검증과 남은 실서비스 확인

이 환경에는 `npm` 실행 파일이 없어 같은 package script 진입점을 번들 Node로 직접 실행했다. `node node_modules/vitest/vitest.mjs run tests/pwa.test.ts tests/pwa-runtime.test.ts`는 **15/15 통과**, 추가 후 `tsc -b` 통과, 격리된 `/police-ox/` production 빌드와 `node scripts/run-e2e.cjs --grep PWA --reporter=line`의 Chromium **2/2 통과(8.8초)**를 확인했다. 브라우저 테스트는 `.pwa-test-dist`와 로컬 5184 포트를 사용하여 실제 저장소와 canonical `dist`를 건드리지 않는다.

하위 경로 manifest·아이콘, 오프라인 재실행, 개인 응답 캐시 제외, 진행 중 시연 모의고사의 대기 업데이트 거부, 오프라인 답안·deadline 보존, 제출 후 명시 업데이트와 완료 기록 보존을 검증했다. 전체 프로젝트 최종 테스트 결과는 별도 최종 보고에서 확인한다.

아직 확인해야 하는 항목은 실제 프로젝트 SQL/RLS 실행, 실제 인증 메일 수신·로그인, 실제 두 계정 접근 차단, 같은 계정 PC↔갤탭 동기화, 공개 Pages 새 배포와 실제 기기 설치다. 모의 서버·Chromium 자동화 통과를 이 실서비스 검증의 대체 결과로 표시하지 않는다. 실제 Tab S11과 Samsung Internet은 연결되지 않았으므로 해당 실기기 확인이 필요하다.
