# PC·태블릿 동기화 및 웹 배포 구현·검증

검증일: 2026-10-23 (Asia/Seoul)

## 구현과 보존

- 원문 real 계정별 문제은행·완료/종료 세션·응답·다시 보기·삭제 이력 동기화. 로컬 기록과 outbox를 같은 IndexedDB transaction으로 저장한다.
- 진행 중 일반 학습의 확정 답은 현재 기기의 통계에 반영하며, 다른 기기로는 세션 완료/종료 뒤 전달한다. 진행 중 모의고사·임시 선택·deadline은 시작한 기기에 남는다.
- 기존 localhost 기록은 자동 업로드하지 않는다. 검증된 백업 또는 로그인 전 로컬 기록을 미리본 뒤 계정에 연결한다. 기존 클라우드와 합치고 원본 백업은 별도로 보관한다.
- 응답 순서가 불확실하면 K로 분리하고 실제 기록을 선택해 해결한다. 시계 재시작·변경·보정 만료는 보수적으로 처리한다.
- Supabase Auth REST, private Storage의 256KiB 조각·해시, user_id RLS 및 멱등 RPC SQL을 제공한다. 실제 키가 없어도 기존 로컬 학습은 동작한다.
- 태블릿 풀이 화면은 접는 메뉴·답안표, 최대 50rem 읽기 열과 48px 조작 영역을 사용한다. 본문/보기/선택지의 실제 글씨는 15.2/14.4/13.92px에서 16.72/15.84/15.312px로 각각 10% 커졌다. 기존 fontScale은 유지한다.
- 원격 GitHub에만 있던 기존 OX 삭제·등록 자료 목록·최종화 도구와 부분 자료 병합 규칙도 보존했다. 기존 highlights·학습 기록·원문 계약·채점 규칙을 유지한다.
- 같은 GitHub Pages workflow와 고정 package-lock을 사용한다. PR은 검사만 하고 main의 push/수동 실행만 배포한다. 배포 산출물은 정적 앱 7개 파일만 허용하며 원본 PDF·실제 변환 자료·개인 백업·관리자 키를 포함하지 않는다.

## 실행 결과

| 검증 | 결과 |
|---|---|
| Vitest 전체 | 19개 파일, **275/275 통과** |
| 순수 동기화 프로토콜 | 위 전체 결과에 포함, **42/42 통과** |
| 동기화 저장 통합 | 위 전체 결과에 포함, **11/11 통과** |
| 앱 TypeScript | 통과 |
| 기존 최종화 도구 TypeScript | 통과 |
| Vite production build·공개 산출물 검사 | 통과 |
| Chromium 전체 | **33/33 통과** (약 1분 30초) |
| 기존 Git 작업 복제본의 `/police-ox/` production build | 통과 |

이 환경에는 npm 실행 파일이 없어 package.json과 같은 설치된 도구를 번들 Node로 실행했다. 의존성은 기존 원격의 고정 lockfile을 유지했다.

```text
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.tools.json
node node_modules/vite/bin/vite.js build
node scripts/run-e2e.cjs --output=test-results --reporter=line
```

여기서 node는 `C:/Users/INTEL/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`다. 일반 개발 환경에서는 `npm test`, `npm run build`, `npm run test:e2e`를 사용한다.

## 자동화의 실제 범위

브라우저 33개는 기존 OX 13개, 원문 회귀 7개, 현황/추천 4개, 태블릿 4개, PWA 2개, 모의 동기화 서비스 3개다. 테스트용 도형·색상 문항과 독립된 browser context를 사용하며 실제 사용자 프로필은 수정하지 않았다.

모의 동기화 서비스 검증은 UI·실제 fetch·계정별 IndexedDB·outbox를 통과한다. 두 독립 기기의 백업 이전, 완료 기록 전달, 응답 유실 재시도, 중복 백업, 미완료 기록 비전송, 로그아웃/다른 계정 경계, 오프라인 재실행, 응답 충돌 K와 해결, 원격 표시 해제·삭제, 활성 시험 보호와 종료 후 반영을 확인했다. 이는 실제 Supabase 검증을 의미하지 않는다.

태블릿 CSS viewport는 800×1280, 960×1536, 1280×800, 1536×960, 640×900, 1440×900, 360×800이다. 200% 글자, 긴 한국어/보기/넓은 그림, 마지막 선택지·피드백, 답안표 포커스·회전·시각 보존을 확인했다. 물리 해상도를 CSS viewport로 주장하지 않는다.

PWA는 격리된 `/police-ox/` production 앱에서 manifest·아이콘·기본 원문 진입·기존 OX 링크·오프라인 재실행·개인 응답 캐시 제외·시험 중 대기 업데이트 차단·종료 후 명시 업데이트를 확인했다. 기존 설치형 OX를 사용 중이면 풀이를 마친 뒤 모든 앱 창·탭을 닫았다가 다시 열어 새 서비스 워커로 전환할 수 있다. 브라우저 데이터 삭제는 필요하지 않다.

시각 확인 파일은 `test-results/tablet-short-reading-800.png`, `tablet-long-reading-800.png`, `tablet-reading-200-1280.png`다.

## 아직 실서비스에서 확인하지 않은 항목

Supabase 프로젝트 연결값과 실제 기기가 제공되지 않았다. 다음을 자동화 통과와 구분한다.

1. `supabase/migrations/202610230001_original_sync.sql` 실제 실행 및 `supabase/rls-tests.sql`의 PostgreSQL RLS 24개 검사 실행.
2. 실제 인증번호 메일 수신·로그인, 실제 서로 다른 계정의 DB/Storage 접근 차단, PC↔갤탭 실제 동기화.
3. 공개 Pages에 새 버전 반영 후 HTTPS 주소·설치·기존 데이터 이전 확인.
4. 실제 Galaxy Tab S11 및 Samsung Internet 확인.

서비스 계정 설정은 [웹 배포](WEB_DEPLOYMENT.md), 기존 기록 이전은 [PC→태블릿 이전](PC_TO_TABLET_MIGRATION.md), 정합성 계약은 [동기화 설계](CLOUD_SYNC.md), 화면 측정은 [태블릿 읽기 화면](TABLET_READING_LAYOUT.md)에 정리했다.
