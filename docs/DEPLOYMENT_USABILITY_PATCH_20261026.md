# 해설 미등록 사용성 개선·웹 배포 결과 · 2026-10-26

이 문서는 **PR5 배포 당시의 기록**이다. 현재 입력 정책은 [자동 입력 정정 기록](AUTO_PEN_TOUCH_CORRECTION.md)으로 대체한다. 기본 연필에서 손가락으로 이동하고 펜으로 쓰며, 실제 펜 접촉 중 손 입력만 자동 제외한다. 이동/읽기 전환과 길게 누르는 잠금 해제는 현재 사용 절차가 아니다.

상태: 배포 완료. PR #5 main 병합, 해당 커밋의 GitHub Pages build/deploy 성공, 실제 공개 파일 및 배포 후 18개 Chromium 검사 통과.

## 배포 추적

| 항목              | 결과                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| 실제 앱           | https://ttjj1117-creator.github.io/police-ox/                          |
| PR                | https://github.com/ttjj1117-creator/police-ox/pull/5                   |
| 검증한 소스 커밋  | `7a2014d733225b6a03734903f3649182093e71a3`                             |
| main 병합 커밋    | `8a41150bdf5f40e673e0e4c74d0058d1aa14a62e`                             |
| PR 검사           | https://github.com/ttjj1117-creator/police-ox/actions/runs/40249862612 |
| main build·deploy | https://github.com/ttjj1117-creator/police-ox/actions/runs/40249982916 |
| 실제 확인 시각    | 2026-10-26 09:36:19 KST                                                |
| 공개 JS / CSS     | `assets/main-DXKerZ_z.js` / `assets/main-CZk7ZKmL.css`                 |
| 새 SW 캐시        | `police-ox-static-ad6bbbc2ae9513b933c3`                                |

이번 사용자 지시는 이전 통합 패치의 배포 제외 조건을 대체한다. 기존 검토 브랜치를 재사용했고 main의 최신 상태를 병합 직전에 재확인했다. 기존 workflow로 배포했으며 강제 push·이력 재작성·별도 서버 설치·SQL/RLS 변경을 하지 않았다. 검증한 소스 커밋과 병합 커밋의 파일 트리는 같다.

## 실제 포함한 기능

- 본문·보기·선택지·사이 여백의 연속 종이 필기, 드래그 중 번호 선택 방지, 저장·복원·지우개·실행 취소.
- 기존 body/choice 좌표는 새 종이 좌표와 섞지 않고 보존한다. 같은 글씨·폭·줄바꿈 배치의 이전 필기는 읽기 전용 보기로 복원하며 다른 배치의 획은 보관 안내한다.
- 좌측 상단 학습 종료/시험 제출, 취소가 기본 포커스인 앱 확인창, 필기 저장 확인 후 한 번만 종료, 만료 시 자동 제출 우선.
- PR5 당시 모드 전체 손 잠금이 포함됐다. 이 정책은 후속 자동 입력 정정에서 제거하며, 현재 사용법과 검사 결과는 [자동 입력 정정 기록](AUTO_PEN_TOUCH_CORRECTION.md)을 따른다.
- 기존 큰 글씨, 22 CSS px 기본값, 배율 한 번 적용, 넓은 가로 글줄, 번호만 선택, 접힌 답안표 유지.
- 해설 규약·가져오기·검증·로컬 저장·제출 후 열람·근거/쟁점별 출제 빈도 기반을 포함한다. 정상 미등록은 ‘해설 자료 미등록’ / ‘분석 자료 미등록’으로 안내하며 0건을 낮은 중요도라고 해석하지 않는다.
- 손상된 해설 저장소는 오류·다시 불러오기를 보여주고 미등록으로 표시하지 않는다. 오류가 있어도 문제 풀이·채점·종료를 계속 사용할 수 있으며 손상 자료 원본을 덮어쓰지 않는다.

실제 법률 해설 데이터는 제작·등록하지 않았다. 앱 시작이나 빌드에 해설 파일 또는 GPT API 키가 필요하지 않으며 실시간 AI 호출·과금 기능은 없다. 나중에 데이터·설정 → 해설 JSON 가져오기에서 규약에 맞는 파일을 검사·미리보기 후 적용할 수 있다. 자세한 제작 계약은 [EXPLANATION_DATA_CONTRACT.md](EXPLANATION_DATA_CONTRACT.md)를 따른다. 해설과 필기는 이 기기 전용이며 기존 전체 백업·기기 동기화에 자동 포함되지 않는다. 해설은 전용 내보내기/가져오기로 다른 기기에 전달한다.

## 검증 범위와 결과

### 구현·로컬

- `npm test`와 같은 Vitest 진입점: 29개 파일·407개 통과.
- `npm run build`와 같은 앱/도구 TypeScript 검사 및 `VITE_BASE_PATH=/police-ox/` Vite 빌드: 104개 모듈 통과. 기존 큰 청크 경고는 남으며 실패는 아니다.
- `npm run test:e2e`와 같은 Chromium 검사: 전체 첫 실행 61개 중 59개 통과. OX 로그아웃 저장 완료 전 다음 로그인으로 이동하던 대기 경계와 실제 실행 시간에 따라 흔들리던 모의 시계 경계를 수정하고 해당 2개 재검 통과. 검사를 삭제·끄거나 실패 상태를 통과로 간주하지 않았다. 실행 코드가 같으므로 관련 없는 나머지 검사를 다시 반복하지 않았다.
- 새 빈 해설 검사: 중립 자료의 demo/real 각각 가져오기 → 오답 제출 → 필기·응답 보존 재실행 → 종료 취소·확정 → 오답 다시 풀기·정답 제출. 손상 해설 저장소에서도 오류 구분·풀이·원본 보존 확인.
- 연속 펜 획·번호 근처 드래그·손바닥 선접촉·펜을 뗀 사이 접촉·후속 click·잠금 복구·읽기 스크롤, 종료 대화상자·중복 방지·시간 만료, 기존 필기 fixture 복원, PWA 대기 업데이트·응답/마감/기록 보존, 원문/OX 계정·동기화 회귀 확인.
- CSS viewport 1280×800, 1536×960, 800×1280, 640×900을 포함한 7개 화면, 배율 100/125/150/200%, 자동/원문 줄바꿈을 검사했다. 실제 Tab S11의 고정 CSS 크기라는 뜻은 아니다.

현재 환경의 npm 실행 파일 대신 설치된 동일 Node·Vitest·tsc·Vite·Playwright script 진입점을 직접 실행했다. 개인 자료 없는 격리 사본에서 검사했고 기준 앱의 최종 타입·production 빌드도 재확인했다.

### 원격 CI·실제 웹

- PR run의 npm ci·단위 407개·production build 성공 확인. PR의 deploy skipped는 기존 workflow의 정상 조건이다.
- main run: run 40249982916의 build와 deploy 모두 success. head_sha는 8a41150bdf5f40e673e0e4c74d0058d1aa14a62e이며 과거 run을 대신 사용하지 않았다.
- 실제 웹: HTML·JS·CSS·manifest·SW·아이콘 2개가 모두 HTTP 200이고 검증한 기준 앱 dist와 바이트 일치. PR CI 빌드 로그에도 동일한 JS/CSS 파일 이름이 기록되었다. JS SHA-256 3f4be8b8351603503374fbe313cf08e1426444506ca31263c4f5c39f4603bf21, CSS SHA-256 55068bba8815096209623c576e38cf2427dc6cc0966bde9b748f2348872d8d85.
- 배포 후 격리 Chromium: 같은 pencil 10개·explanations 7개·legacy-ink 1개 검사를 실제 Pages URL에 맞춰 실행하여 18/18 통과 (29.8초). 테스트마다 독립 브라우저 저장 영역이며 앱 origin 외부 네트워크를 차단했다. 실제 계정 인증·Supabase 쓰기는 하지 않았다.
- 브라우저 화면: 기존 시연 화면에서 대기 업데이트를 명시 적용한 뒤 등록 102문항과 기존 최근 종료 기록 표시가 유지됨을 확인. 가로 1280×800에서 좌측 종료·이동/읽기·연필 손 잠금·1.2초 복구, 기본 취소 포커스의 종료창 및 자료 미등록 안내 확인. 시연 세션은 응답 없이 종료하고 viewport override를 복원했다. screenshots: published-pen-lock.png / published-exit-confirm.png / published-unregistered.png.

실제 공개 산출물은 HTML·해시 JS/CSS·manifest·SW·아이콘으로 제한한다. HTTP 200만으로 판단하지 않고 새 파일 이름과 SHA-256 및 검증한 production 파일의 바이트 일치를 기록했다. 공개 빌드의 기존 Supabase 연결값은 유지하며 관리자 키·실제 환경변수 파일은 공개하지 않는다.

### 실기기 한계

물리적인 Galaxy Tab S11/S Pen 및 Samsung Internet은 연결되지 않았다. Chromium 합성 PointerEvent/CDP 입력과 실물의 필압 느낌·지연·손바닥 접촉·회전은 구분한다. 웹앱 입력 잠금은 운영체제나 브라우저 바의 제스처를 끄지 않는다.

## 변경 파일과 공개 범위

공개 소스 커밋은 33개 파일이다. 목록은 [PR Files changed](https://github.com/ttjj1117-creator/police-ox/pull/5/files)에서 확인한다.

- 연결: `src/original/OriginalApp.tsx`, `QuizChrome.tsx`.
- 필기·입력·종료: `src/original/ink/Ink.tsx`, `InputGuard.tsx`, `ExitDialog.tsx`, `model.ts`, `ink.css`.
- 해설: `src/original/explanations/{contract,analysis,library}.ts`, `ExplanationUI.tsx`, `explanations.css`.
- 도구·계약·회귀: package scripts 3개, 제작 도구 3개, `EXPLANATION_DATA_CONTRACT.md`, 이전 구현 보고서, 단위/E2E 및 중립 demo fixture.

실제 문제은행·시험 PDF·정답/해설 원문·사용자 JSON·백업·필기·학습 기록·`.env`·비밀키는 포함하지 않았다. 기준 앱/검토본/실행 파일의 격리 검사본 일치를 확인했다. 기존 계정·real/demo·문항 ID·저장소·동기화 큐는 초기화하지 않았다.

이 문서는 배포가 끝난 뒤 작성한 로컬 최종 결과 문서다. 정확한 병합/run/공개 확인 결과는 연결된 PR 설명에도 남긴다. 결과 문서만을 위해 중복 앱 배포를 만들지 않는다.

## 기존 PWA에서 업데이트하는 방법

1. 인터넷에 연결한 상태에서 설치한 학습 앱을 연다.
2. 진행 중인 원문/OX 풀이가 있으면 먼저 마치거나 종료한다. 진행 중에는 ‘앱 업데이트 적용’이 답안·타이머를 보존하며 적용을 보류한다.
3. ‘새 버전’ 안내의 **앱 업데이트 적용**을 누른다. 안내가 바로 없으면 풀이가 없는 상태에서 앱을 한 번 다시 열어 확인한다.
4. 다시 열린 문제에서 왼쪽 종료와 기본 연필 도구를 확인한다. 모드 전환 없이 손으로 이동하고 펜으로 쓴다. 완료한 학습 기록은 기존 계정 동기화 흐름을 따르며, 별도 ‘학습 마치고 동기화’ 조작은 없다. 계정 화면의 기존 동기화 기능은 그대로 사용할 수 있다.

브라우저 데이터·사이트 저장소·앱을 삭제하지 않는다. 다른 탭은 강제 새로고침하지 않으며 서비스워커는 개인 데이터/인증/API 응답을 공용 정적 캐시에 넣지 않는다.

## 복구 기준

직전 정상 main은 `8b942e7a74fecdfe47b19a9c44623e620a7ae6fd` ([PR #4](https://github.com/ttjj1117-creator/police-ox/pull/4))이며 [이전 성공 배포 run](https://github.com/ttjj1117-creator/police-ox/actions/runs/40136417291)의 build/deploy가 성공했다. 이전 JS/CSS는 `main-JI4kHR_G.js` / `main-lglxaSt2.css`, SW 캐시는 `police-ox-static-ab747c3b3ed8b86dbb57`이다.

심각한 회귀가 있으면 현재 main에서 정상 revert 커밋과 기존 workflow 재배포를 사용한다. 기존 원문/OX 저장·동기화 형식은 변경하지 않았지만 새 `paper` 획을 PR4가 그대로 표시한다고 보장하지 않는다. 새 필기/해설 저장소는 삭제하거나 이전 좌표로 변환하지 않고 보존한 채 호환성을 검토한다. 기록 삭제·데이터 롤백·강제 push로 복구하지 않는다.
