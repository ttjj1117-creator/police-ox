# 원문 기출 데이터 Codex 인계

계약 버전: **1.0.0**. 이 문서는 원문 객관식 자료 교환을 위한 인계이며, 원문 대조나 법률 검증 완료를 뜻하지 않는다.

## 확정 계약의 저장 위치

프로젝트의 유일한 실제 위치는 `C:/Users/INTEL/Documents/Codex/police-ox`이다. 날짜별 `outputs/police-ox` 경로는 이 위치를 가리키는 junction이다.

| 자료 | 프로젝트 안의 경로 |
|---|---|
| 공통 규격 원본 | `docs/original-contract-v1/02_공통규격.md` |
| 원문 JSON Schema | `src/original/contracts/original.schema.json` |
| 80개 학습 단원 + 형소법 임시 대분류 2개 | `src/original/contracts/study-units.json` |
| 활성 순경 100문항 시험 설정 | `src/original/contracts/exam-profiles.json` |
| 빈 실제 데이터셋 | `src/original/contracts/empty.json` |
| 완료 검증 기준 원본 | `docs/original-contract-v1/07_검증기준.md` |
| 기존 실제 기본서 목차 | `src/fixtures/book-taxonomies.json` |
| 구조·의미·병합 검증 구현 | `src/original/validation.ts` |

위 확정 JSON의 필드명·선택지 순서·단원 코드·ID 규칙을 앱 편의에 맞게 변경하지 않는다. 기존 기본서 목차와 UUID는 별도 등록부로 연결하며 대체하지 않는다. 현재 목차와 참조 스냅샷의 차이는 `docs/ORIGINAL_IMPLEMENTATION.md`의 실제 조사 결과를 따른다.

## 가져오기 파일

UTF-8 JSON, 최대 **20 MiB**. 원문 파일은 `format="police-original-questions"`, `schemaVersion="1.0.0"`, `unitRegistryVersion="1.0.0"`이다. 기존 OX Dataset의 `schemaVersion: 1`, `items`, `judgments` 형식과 혼합하지 않는다.

실제 문항은 `dataKind="real"`에만 넣는다. 순경 ID는 `const_2026_2_1`, `crim_2026_2_40`, `police_2026_2_7`처럼 과목·연도·숫자 회차·원문 번호로 고정한다. 앞자리 0을 붙이지 않는다. 재분류나 모의고사 표시 순번 변경으로 ID를 바꾸지 않는다. 경위 ID는 `lieut_` 접두사를 사용하지만 이번 활성 모의고사 대상이 아니다.

파일을 10~20문항씩 나누어도 같은 원문은 항상 같은 ID를 사용한다. `packageId`는 전달 묶음의 식별자이며, 기존과 다른 packageId도 문항 ID 기준으로 병합한다. 같은 packageId는 packageVersion을 단조 증가시킨다. `exportedAt`만 변경한 동일 내용은 동일 파일로 처리한다.

앱의 **문제 데이터만 내보내기**는 병합 후 최신 문항·현재 그림·retired 상태를 계약 형식으로 내보낸다. 이전 원본 묶음의 오래된 문항을 다시 덮어쓰지 않도록 `local_export_<영역>_<고유값>_<분할번호>`라는 새 packageId를 사용하고, 각 파일이 20 MiB 이내가 되도록 분할한다. 원본 packageId별 전달 이력·세션·응답·설정까지 보존하려면 전체 백업을 사용한다.

`revision`은 저장 내용 변경 때 증가시킨다. 발문·사례·보기·선택지·정답 kind/acceptedChoices 변경은 `gradingRevision`도 증가시킨다. 단원·메모·PDF 위치만 변경하면 gradingRevision은 유지할 수 있다. gradingRevision은 revision을 넘거나 이전 값보다 작을 수 없다. 기존 파일에서 문항을 누락해도 삭제되지 않으며, 출제 제외는 명시적인 `lifecycle="retired"`로 전달한다.

## 원문 보존과 검수

1. 먼저 실제 시험지와 공식 최종 정답을 대조해 `stage="extracted"`, `classification=null`로 전달한다.
2. 그다음 같은 ID의 revision을 올려 `stage="classified"`로 분류 자료를 전달한다. 분류가 불명확하면 null/pending을 유지한다.
3. 원문·정답 확인은 `qa.textStatus`와 `qa.answerStatus`로 각각 표시한다. `checked`는 사람이 실제 근거와 대조한 경우에만 사용한다. JSON 검사 통과가 검수 완료를 뜻하지 않는다.

실제 풀이에는 활성 상태이고 두 QA가 checked이며 공식 정답 status가 final, kind가 single 또는 multiple인 문항만 사용한다. `questionPdf`와 `answerPdf`에 실제 파일명·1부터 시작하는 PDF 페이지 배열을 기록한다. `answerPdf.subjectColumn`은 해당 과목의 실제 정답표 열 이름이어야 한다. missing/provisional, QA pending/hold, all_correct/excluded는 보관하되 일반 출제에서 제외한다.

`body`와 각 선택지 blocks에 원문 순서를 유지한다. 네 선택지는 number 1,2,3,4가 각각 한 번씩 그 순서로 있어야 한다. ㉠㉡ 보기는 statements 블록에, 조합 선택지는 원래 choices에 둔다. 공동 사례는 각 문항이 독립적으로 풀릴 수 있도록 포함한다. 새 문제·선택지·해설·개별 OX 정답을 생성하지 않는다.

그림·표는 원본 발췌 PNG/JPEG를 assets에 base64로 보존한다. assetId, 실제 MIME, SHA-256을 함께 전달하고 image 블록은 assetId를 참조한다. 외부 URL·로컬 경로·실행 HTML·SVG는 그림 자산 대신 사용하지 않는다. 같은 자산 ID로 내용이 다른 이미지를 덮지 않도록 새 assetId를 사용하고, 이미지가 바뀌는 문항의 채점 버전도 증가시킨다.

## 분류 축

- 주 학습 단원은 1개 또는 null이며, relatedStudyUnitCodes에는 주단원을 중복하지 않는다.
- confirmed인 study/blueprint 축에는 해당 과목의 유효한 코드가 있어야 한다.
- bookUnitIds는 현재 기본서 목차에 실제 존재하는 같은 과목의 ID만 사용한다. 누락된 연결은 보류하고 UUID를 만들지 않는다.
- 수사·증거 임시 묶음은 `CRIM-P-INV`, `CRIM-P-EVD`이다. 공식 출제 영역의 `CRIM-INV`, `CRIM-EVD`와 구분한다.
- 단원 미분류라도 원문·정답 검수 완료 문항은 과목 전체·회차 풀이에 쓸 수 있다. 비율형 모의고사에는 해당 공식 영역의 confirmed가 추가로 필요하다.

## 오류와 수정 예

| 오류 위치·설명 예 | 데이터 수정 |
|---|---|
| `questions.0.id`: 출처·과목과 ID 불일치 | 공식 시험 식별정보를 재확인한다. 기존 문항 ID 정정은 일반 갱신과 분리한다. |
| `questions.0.choices`: 1,2,3,4 원문 순서 필요 | 원문 선택지를 재대조한다. 앱의 자동 재정렬에 기대지 않는다. |
| `questions.0.classification.studyUnitCode`: 과목 불일치 | 같은 과목의 등록 코드를 선택하거나 pending/null로 보류한다. |
| `questions.0.source.answerPdf`: checked 근거 누락 | 실제 최종 정답표 근거를 기록하거나 검수 상태를 보류한다. |
| `assets.0.sha256`: 해시 불일치 | 실제 이미지 바이트로 SHA-256을 재계산한다. |
| 동일 revision의 다른 내용 / gradingRevision 누락 | 수정 종류에 맞춰 revision 및 필요한 채점 버전을 증가시킨다. |
| 같은 packageVersion의 다른 내용 | packageVersion을 증가시킨다. |

일부 문항이라도 실패하면 파일 전체를 적용하지 않는다. 가져오기 전 미리보기에서 추가·갱신·동일·풀이 보류 수를 확인한다. 진행 중 원문 세션이 있으면 먼저 이어 풀거나 종료한 뒤 가져온다.

## 다음 데이터 Codex의 첫 산출물

**공식 시험지와 최종 정답표가 확보된 한 회차·한 과목**을 우선한다. 실제 파일은 개발 패키지에 포함되어 있지 않으므로 개발자가 실제 기출을 만들어 채우지 않았다.

첫 전달은 권장 packageId `po_2026_2_const`, 실제 공식 자료로 대조한 10~20문항의 extracted JSON과 원본 파일명·PDF 페이지 대조 내역이다. 정답 미확인·그림 누락은 hold/pending으로 명시한다. 앱 미리보기 및 회차 풀이로 원문·정답 연결을 확인한 뒤 같은 ID의 classified 후속 버전을 전달한다. 첫 과목의 실제 공식 출처가 다른 경우 실제 자료에 맞는 연도·회차·과목 ID를 사용한다.

모의고사를 활성화하려면 총 100개의 출제 가능 원문과 11개 영역의 목표 수를 모두 충족해야 한다. 부족한 동안 일반 학습과 회차 풀이는 계속 사용한다. 부족분을 다른 영역이나 동일 문항으로 채우지 않는다.
