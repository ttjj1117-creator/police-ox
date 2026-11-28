# 빈출 학습 쟁점 데이터 계약 1.1.0

이 계약은 **실제 기출·매칭된 해설 문맥의 의미 분류**와 **법원·사건·조문 인용 식별 및 법률 검증**을 분리한다. 인용 없음·미식별 인용은 의미 확인을 막지 않는다. 검사 성공은 의미 검토나 현행 법률 검증을 새로 수행했다는 뜻이 아니다. 실제 전체 분류가 완료된 것으로 해석하지 않는다.

## 확정 파일과 검증 명령

- 계약·공통 뷰·검증 함수: `src/original/frequent/contract.ts`
- 실행 가능한 검증기: `scripts/validate-frequent-issues.ts`
- 공개 가능한 합성 유효 예와 거부 예: `tests/frequent-contract.test.ts`
- 기존 원문·해설 계약은 그대로 `src/original/model.ts`, `src/original/explanations/contract.ts`, `src/original/instructor/contract.ts`를 사용한다.

프로젝트 루트 `C:/Users/INTEL/Documents/Codex/police-ox`에서 실행한다. 다음 명령은 기존 비공개 원천과 **기존 1.0.0 연결**을 검사하는 재현 예다. 신규 1.1.0 연결은 `--connections` 경로만 실제 산출물 경로로 바꾼다.

```powershell
npm run validate:frequent-issues -- --connections "C:/Users/INTEL/Desktop/경찰 모의고사/해설 데이터/handoff/frequent-issues/connections.json" --questions "C:/Users/INTEL/Desktop/경찰 모의고사/해설 데이터/inputs/questions.current.2026-10-26.json" --legacy "C:/Users/INTEL/Desktop/경찰 모의고사/해설 데이터/app/explanations.current.json" --instructor "C:/Users/INTEL/Desktop/경찰 모의고사/해설 데이터/강사해설/instructor-explanations.app-import.json" --report "C:/Users/INTEL/Desktop/경찰 모의고사/.implementation/frequent-unified/contract-validation.json"
```

스크립트를 직접 실행해도 같다.

```powershell
node node_modules/tsx/dist/cli.mjs scripts/validate-frequent-issues.ts --connections <연결.json> --questions <원문.json> --legacy <기존해설.json> --instructor <강사해설.json>
npm test -- tests/frequent-contract.test.ts
```

`--connections` 대신 첫 위치 인자도 허용한다. `--questions`, `--legacy`, `--instructor`는 각각 반복 가능하다. JSON 또는 `.json.gz`를 읽는다. 참조한 세 원천 패키지의 정확한 ID·버전·schemaVersion을 모두 제공해야 한다. 누락·동일 ID 충돌·실제/시연 혼합·틀린 원문 연결은 종료 코드 1이며 필드 경로를 출력한다. 성공 보고서는 입력 경로·바이트 해시·개수만 기록하며 원문 전문을 복사하지 않는다. 이 도구는 자료를 병합·배포하지 않는다.

## 호환 방식과 버전

`format="police-frequent-issues-handoff"`는 같다. `schemaVersion`으로 엄격히 구분한다.

| 버전 | 읽기와 작성 규칙 |
| --- | --- |
| `1.0.0` | 기존 필드·검사·인용 종속 조건을 그대로 유지한다. 새 의미 연결을 이 형식으로 위장하지 않는다. 기존 유효 파일과 ID를 계속 읽는다. |
| `1.1.0` | 기존 1.0.0 필드 전체 + 양의 정수 `handoffRevision` + `canonicalLearningTopics`를 명시한다. 알 수 없는 필드는 거부한다. |

1.1.0에서도 `questionIndex`, `legacyVerifiedLinks`, `authorityCatalog`, `legacyCatalog`, `sourceCitationOccurrences`, `reviewedLearningTopics`, `inputPackages`를 보존한다. 과거 인용·미대응 자료·기존 연결은 다음 분석의 입력이며 자동으로 새 쟁점이 되지 않는다. `reviewedLearningTopics`는 엄격한 구형 자료 보존용이다. 새 단일 학습 목록은 1.1.0의 `canonicalLearningTopics`만 사용한다. 기존 `reviewedLearningTopics`의 **모든 ID**는 새 canonical 목록에도 보존해야 하며, 목록에서 같은 ID는 한 번만 등록한다. 기존 링크는 그대로 canonical 쟁점의 `links`에 복사할 수 있다. 기존 10개 초기 ID뿐 아니라 이후 실제로 추가된 ID도 변경하지 않는다.

`inputPackages.{questions,legacy,instructor}`는 기존 `{packageId,packageVersion,schemaVersion:"1.0.0"}`다. 원천 파일이 바뀌지 않은 의미 검토·별칭·근거 보강은 원천 `packageVersion`을 올리지 않고 **handoffRevision을 증가**시킨다. 1.0.0은 내부적으로 revision 0이다. 1.1.0의 내용 변경은 handoffRevision을 단조 증가시킨다. 입력 원천 ID는 그대로여야 한다. 원천 버전 벡터와 handoffRevision이 모두 같으면 내용도 같아야 하며 다른 내용은 충돌이다. 어느 축은 높고 다른 축은 낮은 입력은 자동 선택하지 않는다. 낮은/빈 입력으로 정상 자료를 지우지 않는다. 원천 자체가 변경되면 해당 원천의 계약에 맞게 버전도 올린다.

## Canonical 학습 쟁점

`canonicalLearningTopics[]`의 정확한 필드는 다음과 같다.

| 필드 | 형식·의미 |
| --- | --- |
| `id` | 1~200자 안정 ID. 기존 의미가 같으면 기존 ID 유지. 인용 ID·사건번호·표제 유사도만으로 합치지 않는다. 새 ID는 검토한 개별 의미를 구분한다. |
| `title` | 실제 확인한 쟁점명. 출처 제목이나 미식별 인용을 새 쟁점명으로 대체하지 않는다. |
| `subjectId` | `constitution`, `criminal`, `police`, `criminology`, `civil_general` 중 하나. 연결 문항과 같아야 한다. |
| `aliases` | 중복 없는 문자열 배열. 기존 표기·동의어 검색용이며 별도 쟁점 ID나 별도 행을 만들지 않는다. 같은 판례의 다른 법적 의미를 별칭으로 합치지 않는다. |
| `classificationLevel` | **명시적** `topic`, `issue`, `subissue`. 각각 넓은 주제·학습 쟁점·세부 쟁점. 같은 수준끼리 순위를 비교한다. |
| `studyUnitCodes` | 중복 없는 기존 `study-units.json` 코드 배열. 존재하고 같은 과목이어야 한다. 의미상 단원 연결이며 기존 문항 분류·목차 UUID를 다시 쓰지 않는다. 미확인 시 `[]`. |
| `links` | 기존 엄격한 `FrequentReviewedLink` 또는 아래 새 `SemanticFrequentLink` 배열. 빈 배열도 보존할 수 있으나 빈 쟁점을 출제된 것으로 세지 않는다. |

1.0.0에는 분류 수준이 없으므로 공통 어댑터는 내부 전용 `classificationLevel="unspecified"`, `aliases=[]`, `studyUnitCodes=[]`를 반환한다. 이를 확인된 `issue` 수준으로 추정하지 않는다. **`unspecified`는 1.1.0 직렬화에 허용하지 않는다.** 새 자료의 수준을 실제 검토한 뒤 세 수준 중 하나로 기록한다. `getFrequentLearningTopics()`는 읽기용 공통 뷰이며 원본을 수정하지 않는다.

## 새 의미 연결: SemanticFrequentLink

| 필드 | 필수 값 |
| --- | --- |
| `id` | 전체 handoff 안에서 고유한 의미 연결 ID. 같은 문항을 여러 쟁점에 연결하면 쟁점별로 다른 ID. |
| `questionId` | 기존 문항 ID 그대로. |
| `sourceKey` | `[examCode,subjectId,year,round,questionNumber]` 배열. `canonicalExplanationValue(link.sourceKey) === sourceKey(q)`다. 기존 sourceKey helper는 canonical 문자열을 반환한다. |
| `subjectId`, `questionRevision`, `gradingRevision`, `questionFingerprint` | 실제 문항의 과목·revision·gradingRevision·`questionFingerprint(q,assets)` SHA-256과 일치. `questionIndex`와도 모두 일치. |
| `selector` | 지문별이면 기존 `TargetSelector` 객체, 의미를 확인한 **문항 전체면 `null`**. |
| `expectedText` | selector 객체이면 `targetText(q,selector)`의 정확한 문자열. null이면 `frequentQuestionText(q)`의 정확한 문자열. 공백·Unicode·정규화·순서를 바꾸지 않는다. |
| `evidenceLane` | 정확히 `"semantic_reviewed"`. |
| `classificationStatus` | `"confirmed"`, `"pending"`, `"hold"`. 확인된 의미만 confirmed. 미확인/보류는 보존하고 순위·분류 연결률에서 제외. |
| `semanticReason` | 확인한 의미 또는 pending/hold 이유를 실제 문맥에 근거해 기록한 비어 있지 않은 문자열. |
| `legalVerificationStatus` | 정확히 `"not_reviewed"`. 의미 분류·인용 식별로 승격하지 않는다. 기존 법률 검증은 별도 기존 해설에서 유지한다. |
| `evidence` | 아래 두 근거 형식 중 하나 이상. confirmed에는 최소 1개. pending/hold에는 `[]` 가능. 동일 근거 중복은 거부. |
| `citationIds` | **선택** 인용 ID 배열. 없거나 `[]` 가능. 있으면 실제 같은 문항의 `sourceCitationOccurrences.citationId`만 참조. 인용 식별 완료·authorityId·source_linked 여부는 의미 분류 조건이 아니다. |

`selector`의 기존 정확한 형식:

```json
{"kind":"choice","number":1}
{"kind":"block","area":"body","choiceNumber":null,"blockIndex":0}
{"kind":"entry","area":"body","choiceNumber":null,"blockIndex":1,"entryIndex":0,"label":"㉠"}
{"kind":"block","area":"choice","choiceNumber":2,"blockIndex":0}
```

choice/entry 번호·0부터 시작하는 block/entryIndex·label을 모두 정확히 맞춘다. block은 text 블록만, entry는 statements의 실제 항목만 허용한다. 질문 전체는 selector 객체를 새로 만들지 않고 null이다. `frequentQuestionText(q)`는 `canonicalExplanationValue({body:q.body,choices:q.choices})`이며 JSON 키 정렬·배열 순서를 기존 helper에 맡긴다. 정답 문자열이나 해설을 whole-question expectedText에 넣지 않는다. 정답·자산·PDF 출처 변경은 별도로 questionFingerprint가 감지한다.

## 확인 근거와 실제 위치

SHA-256은 UTF-8 바이트 기준 소문자 64자리다. `frequentContentSha256(text)`를 재사용할 수 있다. 위치는 기존 `FrequentLocation`과 같고 각 키를 생략하지 않는다.

```json
{"page":1,"printedPage":null,"bbox":null,"coordinateSystem":null}
```

PDF page는 1부터 시작한다. bbox가 있으면 `[x0,y0,x1,y1]`, 좌표계는 `"pdf-points-top-left"`다. 새 원문 근거는 구조화된 문항 위치를 사용하므로 bbox와 coordinateSystem을 null로 둔다.

**원문 의미 근거**의 정확한 필드:

```typescript
{
  kind: "question_text",
  sourceFileName: q.source.questionPdf?.fileName ?? null,
  sourceLocations: q.source.questionPdf
    ? q.source.questionPdf.pages.map(page => ({page, printedPage:null, bbox:null, coordinateSystem:null}))
    : [],
  contentSha256: await frequentContentSha256(link.expectedText)
}
```

문항 PDF가 있으면 정확한 파일명과 해당 문항의 PDF 페이지 중 하나 이상을 기록한다. PDF 없는 유효한 디지털/시연 문항은 `null`/`[]`를 명시한다. 이때도 원천 위치는 sourceKey+questionId+selector로 특정되고 버전·fingerprint·expectedText·내용 해시를 모두 확인한다. PDF 위치를 만들어 넣지 않는다.

**매칭된 강사/참고 해설 문단 의미 근거**의 정확한 필드:

```typescript
{
  kind: "instructor_block",
  recordId: record.id,
  recordRevision: record.revision,
  documentId: document.documentId,
  documentSha256: document.sha256,
  sourceType: document.sourceType ?? "instructor",
  blockIndex: 0,
  expectedText: record.blocks[0].text, // 실제 text 블록 전체
  contentSha256: await frequentContentSha256(record.blocks[0].text),
  sourceLocations: record.blocks[0].locations.length ? record.blocks[0].locations : record.locations
}
```

이미지 블록·생성한 요약·다른 문항 문단·부분만 맞는 문자열을 해당 text 블록인 것처럼 쓰지 않는다. 문단 위치는 현재 블록 위치 또는 비어 있을 때 실제 레코드 위치 전체와 정확히 일치해야 한다. confirmed는 extraction/matching 모두 checked인 실제 같은 문항의 레코드만 사용한다. 레코드의 문항·채점 버전·fingerprint·공식 정답·시험·회차·범위도 확인한다. targets 범위 해설은 그 정확한 대상에만 연결하며 문항 전체 연결 근거로 넓히지 않는다. question 범위 해설이면 실제 검토한 문항 전체 또는 지문에 연결할 수 있다. `documentSha256`과 `recordRevision`은 독립적인 변경 감지 키다.

인용 없는 문단은 `citationIds` 없이 유효하다. 미식별 인용이 든 문단도 실제 의미를 확인했으면 confirmed가 가능하다. sourceType과 sourceIdentificationStatus는 원본 메타데이터에 남지만, 사용자에게 자료 유형을 고르게 하지 않는다. 확인되지 않은 법률 상태는 계속 not_reviewed다.

## 유효 예와 검증 범위

`tests/frequent-contract.test.ts`의 합성 fixture는 완전한 1.0.0 원천 패키지 세 종류와 1.1.0 handoff를 생성해 실제 `validateFrequentIssuesPackage`를 통과한다. UTF-8 해시·questionFingerprint를 실행 중 계산하므로 가짜 해시를 복사하지 않는다. 다음 유효 조합과 거부가 같은 테스트에 포함된다.

- 인용 없음 + 원문 의미 확인, 미식별 인용 + 해설 문단 의미 확인.
- selector=null 문항 전체와 같은 문항의 복수 쟁점.
- 한 쟁점의 원문/해설 복수 근거. 집계는 문항·대상 집합 기준으로 중복 제거.
- 원문·expectedText·selector·해설 문단·내용 해시·레코드/문서 버전·출처 위치가 틀린 연결 거부.
- 구형 파일은 그대로 읽고 새 필드를 구형 schemaVersion에 섞으면 거부.

`parseFrequentIssuesPackage()`는 외부 JSON 구조·영역·내부 참조를 검사한다. `validateFrequentIssuesPackage()`는 검증된 실제 원천과 대조한다. CLI는 원문·기존 해설·강사 해설의 기존 검증기도 먼저 실행한다. 앱 집계는 현재 문항·해설로 다시 확인하며 오래된/충돌/보류 연결을 제외하고 진단에 보존한다. 한 파일의 외부 검증 실패는 파일 전체 실패다.

## 집계·누락·순위

canonical ID 하나가 학습 목록 한 행이다. 한 문항에 여러 쟁점, 한 쟁점에 여러 출처·근거를 허용한다. 출처 유형·동일 판례·같은 원천 문단이라는 이유로 서로 다른 canonical 의미를 병합하지 않는다.

1. 현재 계정/real 또는 demo 영역의 출제 가능한 원문과 현재 버전이 맞는 **confirmed** 의미 연결만 집계한다. 기존 유효 구형 reviewed 링크는 구형 검사 규칙을 적용한다.
2. 문항 수는 시험·과목·연도·회차·원문번호 sourceKey의 고유 집합이다. 같은 sourceKey의 상충 원문은 제외하고 충돌로 설명한다.
3. 등장 지문 수는 `[sourceKey,selectorKey]`의 고유 집합이다. **selector=null은 0개 지문**이며 문항 수만 센다. wholeQuestions도 문항 집합으로 센다. 지문+문항 전체가 함께 있어도 문항 수는 1이다.
4. 반복 회차는 `[examCode,year,round]`의 고유 집합이다. 최근 출제는 실제 문항 출처의 year/round다. 같은 과목·같은 classificationLevel 안에서 문항 수 내림차순→반복 회차 내림차순→최근 출제 순으로 비교한다. 임의 중요도 점수를 만들지 않는다.
5. 단원·시험·연도/회차 필터 후 같은 규칙으로 다시 집계한다. 별칭은 검색에만 사용한다. 개인 오답/미풀이·바로 풀기는 기존 계정의 원문 학습 세션과 기록을 사용한다.
6. sourceCitationOccurrences·legacyVerifiedLinks 연결률은 자료 참조 범위다. canonical 의미 분류 연결률로 표시하지 않는다. 미확인·보류·오래됨·충돌은 진단 상세에서 설명한다. 연결이 없는 문항이나 전체 의미 검토를 수행하지 않은 자료를 완료로 세지 않는다.

## 후속 정리집의 최소 연결

정리집은 빈출 집계와 독립된 선택 자료로 나중에 붙인다. 최소 연결은 `topicId`, 기존 근거 참조(문항 ID·selector·fingerprint·revision 또는 record/document/block/sha256), `summaryRevision`, `reviewStatus`다. 빈출 `classificationStatus`와 정리본 내용 검토 상태는 별개다. 정리집이 없거나 일부만 있어도 빈출·풀이·동기화가 동작해야 한다. 현재 근거의 해시/버전을 유지해 이후 원천 변경을 감지한다. 이번 작업에서 정리집 본문·새 저장소·편집기·전용 화면은 만들지 않는다.
