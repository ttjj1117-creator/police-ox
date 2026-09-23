# 문제 JSON / 백업 계약 v1

기본서 목차의 `book` 객체는 선택 필드 `page`(기본서 쪽수), `tocPage`(제공 PDF의 목차 페이지)를 지원합니다. 둘 다 1 이상의 정수입니다. 제공된 스캔 목차를 전사한 데이터와 대조 기록은 `src/fixtures/book-taxonomies.json`, `BOOK_TOC.md`에 있습니다. 영구 ID는 문구·순서를 수정하더라도 유지하세요.

정확한 실행 검증기는 `src/domain/schema.ts`입니다. 모든 객체는 정해진 필드만 허용합니다. 정수 개정 번호는 1 이상, 문자열 ID는 비어 있지 않아야 합니다. ID는 단원 이름·배열 순서와 무관하게 유지하세요. 이 문서의 명칭은 데이터 형식 설명이며 법률 자료가 아닙니다.

## 파일 루트

```json
{
  "schemaVersion": 1,
  "datasetId": "my-police-study",
  "datasetVersion": 1,
  "exportedAt": "2026-09-19T00:00:00.000Z",
  "taxonomies": [],
  "studyGroups": [],
  "coverage": [],
  "items": []
}
```

빈 파일은 정상입니다. 실제 학습 영역에서 문제 JSON 내보내기를 하면 형사소송법 임시 분류를 포함한 시작 템플릿을 얻습니다. 시연 모드의 문제 JSON은 **기능 확인용 예시**이며 실제 영역에 가져오지 마세요.

과목 ID: `constitution`(헌법), `criminal`(형사법), `police`(경찰학). 형법·형사소송법은 `criminal` 아래 분류 노드로 나타내며 `areaId`로 참조합니다.

## 분류 / 묶음 / 처리 상태

분류 노드 필수: `id`, `parentId`(루트는 null), `label`, `order`(정수), `subjectId`, `origin`(`book`/`custom`), `taxonomyVersion`(양의 정수). 선택 `book`: `title`, `edition`, `year`, `fileRef`를 선택적으로 기록합니다. 모르는 기본서 정보는 생략합니다. 부모는 같은 과목이어야 하고 순환은 허용하지 않습니다. 지문의 `primaryUnitId`는 말단 단원을 사용하고 분류 미확정은 null을 사용하세요. 상위 단원 자체에 주단원을 두는 데이터는 가져오기 검증에서 거부합니다.

학습 묶음 필수: `id`, `title`, `subjectId`, `unitIds`(ID 배열), `includeDescendants`(boolean), `optionalAnyTags`(문자열 배열, 빈 배열 허용), `order`. 단원을 먼저 일치시킨 다음 태그 중 하나 이상 일치하는 지문으로 좁힙니다. 여러 선택은 합집합입니다.

처리 상태 필수: `id`, `year`, `round`, `subjectId`, `status`(`not_started`/`partial`/`complete`), `classificationComplete`(boolean). 지문 개수와 별도로 관리합니다.

## 지문

| 필드                          | 타입 / 설명                                 |
| ----------------------------- | ------------------------------------------- |
| `id`, `originalQuestionId`    | 영구 지문 ID, 원 객관식 문항 ID             |
| `revision`                    | 콘텐츠 개정 번호                            |
| `source`                      | 아래 출처 객체                              |
| `subjectId`, `areaId`         | 과목 / 영역 노드 ID 또는 null               |
| `primaryUnitId`               | 주단원 ID 또는 null                         |
| `relatedUnitIds`, `tags`      | 문자열 배열                                 |
| `originalText`, `displayText` | 원문·표시 지문(빈 문자열 불가)              |
| `contextText`                 | 사례·공통 조건, 없으면 빈 문자열            |
| `transformation`              | `original`, `context_added`, `adapted`      |
| `transformationReason`        | 수정 이유, 없으면 빈 문자열                 |
| `trapTypes`                   | 아래 변형 유형 배열, 미확인은 빈 배열       |
| `originalVerified`            | 원문 대조 여부 boolean                      |
| `judgments`                   | `{ "exam": 판단객체, "current": 판단객체 }` |
| `lifecycle`                   | `active` / `retired`                        |

변형 유형: `conclusion_negation`, `subject_object`, `requirements_scope`, `condition_exception`, `time_procedure`, `case_application`.

`source` 필수: `year`(정수), `round`(문자열), `examName`, `track`, `subject`, `questionNumber`(양의 정수), `option`, `fileRef`, `page`(양의 정수 또는 null). `track`, `option`, `fileRef`는 빈 문자열 허용. 불명확한 출처는 꾸며 넣지 말고 확인 후 입력하세요.

## 판단 객체

미검증 판단의 형태:

```json
{
  "answer": null,
  "status": "draft",
  "judgmentRevision": 1,
  "verifiedAt": null,
  "asOfDate": null,
  "shortReason": "",
  "keyPoint": "",
  "corrections": [],
  "evidence": []
}
```

- `status`: `draft` / `verified` / `hold`. `answer`: `O` / `X` / null.
- `verifiedAt`: UTC ISO 시각 또는 null. `asOfDate`: `YYYY-MM-DD` 또는 null.
- `corrections`: `{ "wrong": "틀린 구절", "correct": "올바른 구절" }` 배열. 전체 문장 정정도 가능하고 여러 항목을 허용합니다.
- `evidence`: `type`(`law`/`case`/`other`), `title`, `caseTextCompared`(boolean)가 필수. `caseNumber`, `decisionDate`(`YYYY-MM-DD`), `article`, `url`, `excerpt`는 선택 필드입니다. URL은 빈 문자열 또는 HTTP/HTTPS만 허용합니다.
- verified는 원문 대조=true, O/X 정답, 검증일·기준일·이유·근거가 모두 있어야 합니다. X는 정정 1개 이상, O는 핵심 조건·범위가 필요합니다. 미충족 verified는 파일 전체를 거부합니다.

## 갱신 규칙

기존 데이터셋에 지문이 있다면 같은 `datasetId`만 병합합니다. 같은 ID의 높은 revision은 갱신, 완전히 동일한 내용·revision은 미변경, 낮은 revision이나 같은 revision의 다른 내용은 충돌입니다. 판단 내용 변경은 해당 `judgmentRevision`도 증가시켜야 합니다. 단원 이동·표기 수정은 판단 버전을 유지할 수 있습니다. 분류 변경은 `taxonomyVersion`을 증가시키세요. 묶음/처리 상태는 ID별로 병합합니다. 파일에 없는 항목은 유지하며 폐기 지문은 `retired`로 명시합니다. 최종 병합 결과도 다시 참조 검증합니다.

## 백업

`backupSchemaVersion:1`, `appVersion`, `exportedAt`, `namespace`(`real`/`demo`), `state`로 구성됩니다. state에는 `dataset`, `attempts`, `marks`, `sessions`, `cycles`, `allocations`, `settings`가 포함됩니다. 앱에서 내보낸 파일을 사용하세요. 전체 교체만 지원하며 다른 영역 백업은 거부합니다.

응답에는 attemptId/sessionId/itemId/itemRevision/basis/judgmentRevision/response/expectedAnswer/result/answeredAt을 저장합니다. 스냅샷은 세션 당시 지문과 판단을 보존합니다. 세션 간 같은 지문 응답은 허용하되 한 세션에서 같은 지문의 응답을 두 번 저장하지 않습니다. 다시 보기 키는 JSON 문자열 `[itemId,basis]`이며 판단 버전이 달라도 수동 표시를 유지합니다.
