# 원문 지문 해설 데이터 규약 1.0.0

이 규약은 원문 객관식 앱용 부가 자료다. 기존 OX judgment 규약과 별개이며 원문 문제·정답·분류·학습 기록을 다시 작성하지 않는다. 실행 가능한 스키마와 참조 검증기는 `src/original/explanations/contract.ts`의 Zod 객체 및 `validateExplanationPackage`다. 필드는 모두 엄격히 검사하며 알 수 없는 필드를 허용하지 않는다.

## 제작과 검증 순서

1. 앱의 **문제 데이터만 내보내기**로 최신 원문 파일을 확보한다. 실제/시연 영역을 확인한다. 원문과 개인 학습 백업을 혼동하지 않는다.
2. 프로젝트 루트에서 다음 명령으로 정확한 ID·구조 대상·지문값을 얻는다. 출력은 새 파일에만 쓴다. 여러 원문 파일이면 각각 실행한다.

```powershell
npm run export:explanation-targets -- 원문.json 대상후보.json
```

3. 후보에서 실제 판단 대상을 사람이 선정한다. 한 문자열의 복합 문장을 자동 분해하지 않는다. 일반 선택지는 선택지 전체를 사용할 수 있다. 실제 조사한 원문·발췌·출처·검증 기록으로 아래 패키지를 작성한다. 대상 후보 파일 자체는 가져오는 해설 파일이 아니다.
4. 다음 검사 후 앱 **데이터·설정 → 해설 JSON 가져오기 → 미리보기 → 해설 확인하고 적용**을 사용한다.

```powershell
npm run validate:explanations -- 해설.json --questions 원문.json
# 내보내기가 여러 파일인 경우
npm run validate:explanations -- 해설.json --questions 원문1.json --questions 원문2.json
```

Node/npm이 PATH에 없는 이 작업 환경에서는 번들 Node로 `node_modules/tsx/dist/cli.mjs scripts/validate-explanations.ts ...` 또는 `scripts/export-explanation-targets.ts ...`를 실행해 같은 검사를 했다. 원문 파일 없이 참조·문자열 검증이 완료됐다고 보고하지 않는다. CLI 성공 출력의 `legalVerification:false`는 구조 검사와 법률 검증의 구분이다.

## 패키지

필수 루트 필드:

| 필드 | 형식·의미 |
|---|---|
| format / schemaVersion | `police-original-explanations` / `1.0.0` |
| packageId / packageVersion | 비어 있지 않은 안정 ID / 양의 정수. 동일 자료의 새 버전은 같은 ID 사용 |
| exportedAt | UTC `Z`를 포함하는 ISO 시각 |
| dataKind | `real` 또는 `demo`, 현재 원문 영역과 일치 |
| scope | `{subjectIds: Subject[], questionIds: string[]}`. questionIds는 실제 수록 해설의 문항 ID 집합과 일치 |
| producer / notes | 제작자 식별 문자열 / 안내 문자열 배열 |
| bases / issues / explanations | 아래 자료 배열. 모든 자료는 `id`, 양의 정수 `revision`을 가짐 |

앱·CLI의 해설 파일 한도는 UTF-8 JSON 20 MiB다. 현재 원문 Subject는 `constitution`, `criminal`, `police`, `criminology`, `civil_general`이며 기존 문항의 과목을 그대로 사용한다. 이 패치로 미지원 시험 편성을 추가하지 않는다.

모든 확인 기록 `verification`은 `{status, checkedAt, checkedBy, note}`다. status는 `draft | verified | hold`, checkedAt은 ISO UTC 시각 또는 null, checkedBy는 비어 있지 않은 문자열 또는 null이다. `verified`에는 확인자·시각·실제 확인 내용이 있는 note가 필요하다. **AI가 법률 근거를 확인하지 않고 verified로 표시하면 안 된다.** 앱은 제작자의 확인 기록을 검증 가능한 형태로 보관할 뿐, 가져오기 성공으로 상태를 승격하지 않는다. 미검증 초안·보류는 확정 해설과 통계에서 제외한다.

## 공통 근거 bases

`{id, revision, type, title, identity, sourceUrl, originalText, archivedAt, temporalBasis, asOfDate, verification}`

- type: `case | constitutional | law | theory | demo`.
- identity: `{authority, number, date}`. authority는 법원·기관·자료 식별자, number는 사건번호·조문/자료 식별자 또는 null, date는 유효한 `YYYY-MM-DD` 또는 null. 사건·헌재 근거는 number와 date를 생략할 수 없다. 실제 파일에서 type demo는 금지한다.
- sourceUrl: http/https URL 또는 null. 실행 스킴·사용자정보가 포함된 URL은 금지한다.
- originalText: 보관 원문 문자열 또는 null. sourceUrl과 originalText 중 적어도 하나가 필요하다. HTML처럼 보이는 문자열도 텍스트로 표시하며 실행하지 않는다.
- archivedAt: 보관 시각 또는 null. temporalBasis는 `exam`(출제 당시) 또는 `current`(현행), asOfDate는 그 기준 날짜다. 날짜는 조사한 정밀도대로 쓰고 사건의 날짜를 추측하지 않는다.

같은 근거 ID를 여러 해설이 참조한다. 긴 원문은 근거 하나에 저장한다. 서로 다른 법원·선고일을 사건번호만으로 합치지 않는다. 같은 type+identity를 별도 ID로 중복 등록하면 충돌로 보고하여 제작자가 정리하게 한다. 하나의 ID에는 한 가지 활성 기준·버전을 둔다. 갱신 시 revision과 패키지 버전을 올린다.

## 쟁점별 근거 issues

`{id, revision, basisId, title, excerpt, locator, verification}`

공통 근거의 특정 쟁점과 직접 관련된 원문 발췌를 담는다. excerpt와 locator는 비어 있을 수 없다. locator는 문단·페이지·조항 등 조사자가 확인한 위치다. 하나의 판례에도 쟁점을 여러 개 둘 수 있다. 이론은 실제 제공한 이론 출처를 사용하며 임의 판례로 대체하지 않는다.

## 지문별 해설 explanations

`{id, revision, questionId, subjectId, questionRevision, gradingRevision, questionFingerprint, selector, expectedText, explanation, references, verification}`

- questionId·subjectId는 기존 문항 값을 그대로 사용한다.
- questionRevision은 제작에 사용한 원문 revision을 기록한다. 분류/검수만 바뀐 revision은 아래 콘텐츠 지문값이 같으면 연결을 유지한다.
- gradingRevision은 현재 채점 버전과 정확히 같아야 한다.
- expectedText는 선택한 원문의 **정확한 문자열**이다. 공백·CRLF·문장부호를 정규화하지 않는다.
- explanation은 지문별 간결한 설명이다. 앱은 단어·숫자 차이로 정오 판정이나 강조를 생성하지 않는다. 이 버전의 별도 해설 규약에는 자동 강조 필드를 두지 않는다.
- references는 `{basisId, issueIds: string[]}` 배열이다. 각 참조에는 직접 발췌가 있는 쟁점 하나 이상이 필요하며 해당 쟁점의 basisId와 일치해야 한다. 한 지문은 여러 근거를 참조할 수 있다. 중복 연결은 빈도 집계에서 집합으로 처리한다. 확정 해설의 연결 근거·쟁점도 verified여야 한다.

### 선택자 (모든 위치는 0부터 시작)

| 대상 | selector 예시 | expectedText |
|---|---|---|
| 선택지 전체 | `{"kind":"choice","number":1}` | 그 번호 선택지 blocks를 아래 문자열화 규칙으로 `\n` 연결 |
| 본문 text 블록 | `{"kind":"block","area":"body","choiceNumber":null,"blockIndex":0}` | 해당 text의 text 그대로 |
| 선택지 text 블록 | `{"kind":"block","area":"choice","choiceNumber":2,"blockIndex":0}` | 실제 number=2 선택지의 text |
| 본문의 개별 보기 | `{"kind":"entry","area":"body","choiceNumber":null,"blockIndex":1,"entryIndex":0,"label":"㉠"}` | 해당 entries 항목의 text (label 제외) |
| 선택지의 개별 보기 | 위 entry에서 area=`choice`, choiceNumber=실제 번호 | 동일 규칙 |

선택지 위치는 배열 순서가 아니라 number로 찾는다. entry는 statements 블록에만 사용할 수 있고 entryIndex와 label 모두 확인한다. block 선택자는 text 블록만 허용한다. 문자 오프셋으로 부분 문장을 자르는 선택자는 제공하지 않는다.

선택지 전체 문자열화: text는 text 그대로, statements는 각 항목을 `${label} ${text}`로 만들어 `\n` 연결, image는 `[[image:assetId]]`다. 마지막에 별도 개행을 붙이지 않는다. text/entry/선택지 후보를 내보내는 명령이 이 문자열을 직접 생성한다. 같은 선택지의 전체 대상과 그 내부 block/entry를 겹쳐 등록하지 않는다.

### questionFingerprint

`questionFingerprint`는 다음 객체를 로케일과 관계없는 canonical JSON으로 직렬화하고 UTF-8 바이트의 SHA-256을 소문자 64자리 hex로 만든 값이다.

```text
{
 version: "original-explanation-content-v1",
 subjectId, source, body, choices, officialAnswer, gradingRevision,
 assets: [[참조 assetId, 해당 sha256 또는 null], ...]
}
```

source/body/choices/officialAnswer는 원문 모델의 해당 객체 전체다. assets는 실제 참조 assetId를 중복 제거하고 JS 기본 문자열 정렬로 정렬한다. 객체 키는 재귀적으로 JS UTF-16 코드 단위 오름차순(`Object.keys(...).sort()`)으로 정렬하고 JSON.stringify로 키와 원시값을 인코딩한다. 배열 순서는 보존하고 공백을 추가하지 않는다. 실행 함수는 `canonicalExplanationValue`, `questionFingerprint`다. questionId·revision·classification·qa·lifecycle은 이 지문값에서 제외한다. ID/과목·채점 버전·원문 대상은 별도로 검사한다. **직접 재구현하기보다 대상 후보 내보내기 명령을 사용한다.**

원문·정답·그림·출처 또는 gradingRevision이 바뀌면 연결을 오래된 자료로 표시하고 확정 해설·통계에서 제외한다. 과거 세션에서는 그 세션의 원문/그림 스냅샷과 일치하는 자료만 표시한다. 현재 자료를 다른 과거 문제 버전에 억지로 붙이지 않는다.

## 가져오기·교체·충돌·전달

각 파일은 자체 근거/쟁점 참조를 모두 포함하는 독립 패키지다. 같은 ID·내용을 여러 파일에 재사용할 수 있지만 다른 내용의 같은 ID는 충돌이다. 공통 레코드를 수정할 때는 관련 범위를 같은 패키지로 모아 전체 새 버전을 만들거나 충돌을 먼저 정리해야 한다. 앱이 서로 다른 자료를 자동 선택·부분 병합하지 않는다.

동일 packageId/version/내용의 재가져오기는 자료를 늘리지 않는다. 다른 내용은 packageVersion을 증가시켜야 하고 바뀐 레코드도 revision을 올려야 한다. 낮은 버전, 같은 버전의 다른 내용, 깨진 참조, 잘못된 선택자·원문·날짜·URL은 기존 정상 자료를 건드리지 않고 거부한다. 새 패키지 전체와 기존 패키지 간 충돌을 확인한 뒤 독립 IndexedDB 트랜잭션으로 교체한다. 동시 변경은 generation 충돌로 거부한다.

저장소는 `police-original-explanations`의 `collections`, 키는 `[ownerKey, namespace]`의 JSON이다. 로그인한 실제 계정·로그인 전 local·demo local을 분리한다. 기존 원문/학습 백업과 클라우드 스키마에는 필드를 추가하지 않는다. **해설은 현재 기기 전용이며 기존 전체 백업·자동 기기 동기화에 포함되지 않는다.** 해설 자료 내보내기로 원본 패키지를 다른 기기에 따로 가져온다. 개인정보·실제 법률 자료를 임의로 공개 GitHub에 올리지 않는다. 새 유료 서비스나 실행 중 GPT 호출은 없다.

## 열람과 출제 빈도

일반 학습·회차별 풀이는 답 제출 후, 모의고사는 최종 종료/제출 후에만 해설을 표시한다. 미등록·검토·보류·버전 불일치를 구분한다. 해설·원문은 필기 면 바깥에서 펼쳐 획 좌표를 바꾸지 않는다. 등록된 텍스트·발췌·보관 원문은 앱이 실행된 상태에서 오프라인으로 읽을 수 있다. 외부 출처 URL은 네트워크가 필요하며 새 창으로 연다. 오프라인 앱 재실행은 기존 PWA 캐시에 앱이 준비되어 있어야 한다.

확정 집계는 현재 영역의 삭제 제외·active lifecycle·기존 isEligible 조건을 통과한 원본 기출 중 원문 버전이 맞는 verified 연결만 사용한다. 임의 모의고사 세션·재풀이·Attempt·패키지 수는 집계에 쓰지 않는다.

- 원본 문항 키: `[examCode, subjectId, year, round, questionNumber]`.
- 판단 대상 키: 원본 문항 키 + selector의 안정적 JSON.
- 시험 회차 키: `[examCode, year, round]` (같은 시험의 과목들은 한 회차).
- 근거별 등장 지문·출제 문제·회차는 각각 대상·문항·회차 집합 크기다. 여러 쟁점의 판례 합계는 합집합이다.
- 다른 내부 ID의 같은 원본 출처는 중복으로 보고하고 내용이 같으면 합집합으로 집계한다. 원문이 충돌하면 그 원본을 확정 집계에서 제외한다.
- 최근 시점은 제공된 연도·회차 정밀도로만 표시한다. 자료에 없는 시험일을 만들지 않는다.
- 연결률은 **한 개 이상 확정 근거가 있는 문항 / 집계 대상 원본 문항**이다. 모든 지문 해설 완성률이 아니다. 미연결 문항·검토/보류 연결·버전 불일치 규모를 함께 표시한다.
- demo는 실제 통계와 섞지 않고 ‘시연 집계’로 표시한다. 빈 자료·0건도 정상 상태다. 모의고사 진행 중 근거 분석은 숨기며 관련 기출 이동이 현재 세션을 종료하거나 답을 노출하지 않는다.

## 격리 예시와 반례

`tests/fixtures/explanations/`:

- `questions.demo.json`: 비법률 도형·색깔 원문 100문항.
- `valid.demo.json`: 근거 2개, 쟁점 3개, 해설 6개. 선택지/개별 보기, 공통 근거, 복수 근거, 중복 연결, draft·hold 포함. verified는 **자동화 시연 확인 상태**이며 법률 검증을 뜻하지 않는다.
- `invalid-reference.demo.json`: 없는 쟁점 참조, 거부되어야 함.
- `stale-version.demo.json`: 지문값 불일치, 거부되어야 함.
- `legacy-ink.demo.json`: 이전 배포 버전에서 직접 만든 비법률 시연 획. 기존 좌표 보존 테스트 전용이며 해설 가져오기 파일이 아님.

`npm run fixtures:explanations`로 해설 관련 4개 중립 fixture를 재생성한다. 기존 필기 fixture는 이전 버전에서 얻은 보존 회귀 증거이므로 일반 생성 명령으로 덮어쓰지 않는다. 실제 판례 조사·법적 정오·실제 해설 제작은 별도 데이터 제작 작업이며 이 구현 완료와 혼동하지 않는다.
