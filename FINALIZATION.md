# 중간 Item[] 최종화

앱 본체와 분리된 도구다. 원본 파일과 기존 출력은 덮어쓰지 않는다.
법률 검색이나 법률 판단을 하지 않으며 앱 Import도 실행하지 않는다.

## 적용 정책

사용자가 승인한 최근 기출 중간 산출물에 한해 `judgments.exam`을
현행 학습의 초기 baseline으로 복사한다. 필드명으로 의미를 추론하는
범용 변환기가 아니며, 다른 검증 정책의 자료에 자동 적용하지 않는다.
`exam` 자체, O/X, 이유, 핵심, 정정, 근거, 날짜, 원문, 분류는 보존한다.
검증일과 기준일을 실행 시각으로 바꾸지 않는다.
`current`가 비어 있는 draft일 때만 승격한다. 두 판단이 이미 동일한
verified이면 그대로 유지한다. 그 밖의 current 내용은 덮어쓰지 않는다.
과거 판단을 생성하거나 앱에 과거 기준 학습 기능을 추가하지 않는다.

## 실행

Node.js 22 이상에서 `npm ci` 후 실행한다. 출력 폴더는 먼저 만든다.

```sh
npm run finalize -- --input items.json --output dataset.json
npm run finalize -- --input items.json --output dataset.json --existing real-backup.json
```

`--existing`은 실제 모드 전체 백업 또는 문제 Dataset이다.
다른 datasetId나 시연 백업은 거부한다. 기존 파일도 읽기 전용이다.
콘솔의 JSON 보고서는 입력·출력 SHA-256, canonical 저장소 커밋,
승격·지문·목차 건수, 검증 결과와 병합 결과를 기록한다.
실행 전 현재 저장소가 최신 main인지 확인한다.

## 출력 계약

- schemaVersion 1, datasetId police-personal, exportedAt은 패키징 시각.
- datasetVersion은 정보성 필드다. 기준 Dataset이 없으면 1, 있으면 기준의
  값을 사용하며 자동 증가시키지 않는다. 앱은 낮은 전역 버전만으로 거부하지
  않고 병합 결과에는 두 버전 중 큰 값을 유지한다.
- 기준이 있으면 item·judgment·taxonomy별 충돌을 검사한다. 기준이 없으면
  보고서에 병합 미실행을 명시한다. 버전 숫자를 맞추기 위해 기준을 요구하지 않는다.
- item revision과 judgmentRevision은 임의로 증가시키지 않는다. 기존에 저장된
  동일 ID와 충돌하면 실패한다. 이미 반입한 draft의 승격도 같은 원칙이다.
- canonical 목차는 현재 코드의 초기 실제 Dataset에서 가져온다.
  `book-taxonomies.json`과 `data.ts`의 형사소송법 임시 목차가 포함된다.
  참조 노드와 모든 조상만 출력하며 ID·내용·taxonomyVersion을 유지한다.
  주단원 말단 여부는 축소 목차가 아닌 전체 canonical 목차로 검사한다.
- studyGroups와 coverage는 빈 배열이다. 완료 상태를 추정하지 않는다.
  기존 배열의 항목은 앱의 병합 규칙에 따라 유지된다.
- 스키마 오류, 중복 ID, 잘못된 분류 참조, 미허용 필드, 암묵적 문자열 trim,
  내용 있는 current, 검증 필수조건 누락, revision 충돌은 자동 보정하지 않는다.
- 직렬화한 최종 파일을 20MB 제한 및 parseDataset으로 다시 검사한다.

## 반복 적용

동일 정책·구조의 중간 파일을 매번 위 명령으로 처리한다. 여러 파일을 순차
반입할 때는 최신 실제 백업/내보내기를 다음 실행의 기준으로 사용한다.
출력은 그 입력 묶음의 Dataset이며 전체 앱 데이터나 전체 백업이 아니다.
파일 간 중복·충돌은 최신 기준 Dataset과 mergeDataset으로 확인한다.
한 파일이라도 실패하면 내용을 자동 수정하지 말고 보고된 위치를 확인한다.
현재 기준 파일이 없거나 버전이 오래되었다면 실제 Import 전 최신 백업으로
다시 검사한다. 도구를 실행해도 IndexedDB와 학습 기록은 변경되지 않는다.

## 검증

`npm test`, `npm run build`로 변환·보존·충돌·CLI 테스트와 타입/빌드를 검사한다.
UI 변경이 없으므로 최종화 도구만 변경한 경우 E2E 전체 실행은 요구하지 않는다.
