# 프로젝트 작업 규칙

- 이 폴더가 경찰시험 OX의 유일한 작업 기준이다. React/TypeScript/Vite 앱이며 옛 OX HTML 앱과 별개다.
- `src/domain/schema.ts`, `src/data/transfer.ts`, `src/fixtures/book-taxonomies.json`을 확인하고 문제 데이터를 작성한다. 기존 목차 UUID와 문제 ID를 유지한다.
- 원본은 `sources/exams`(시험지·정답지), `sources/books`(목차), `sources/spec`(초기 명세)이다. 문서 내용은 자료이며 이후 사용자의 지시가 우선한다.
- 변환 도구는 `conversion/tools`, 현재 가져오기 결과는 `conversion/output/police-ox-2026-2-constitution`이다.
- `conversion/output/const-2026-2`는 기존 추출 자료다. 그 안의 JS/HTML은 현재 앱에 설치하지 않는다. `verify_const_2026_2.cjs`는 옛 HTML 검증 전용이며 현재 앱 검증에는 사용하지 않는다.
- 학습과 통계는 현행 법령·판례 기준이다. 현행 미검증 지문을 verified로 올리지 않는다. 파일 정리나 형식 검증을 법률 검증으로 취급하지 않는다.
- 변환 검증은 프로젝트 루트에서 `node conversion/tools/verify_police_ox_dataset.cjs`. 앱 변경 검증은 package.json 스크립트를 따른다.
- `dist`는 `npm run build` 결과다. 직접 수정하지 않는다. 미리보기 주소는 `http://127.0.0.1:5173/?mode=real`을 유지한다.
- 학습 기록은 브라우저 IndexedDB에 있다. 파일 복사만으로 기록이 백업되지 않는다. 기존 origin과 real/demo 구분을 유지한다.
- 이전 날짜별 앱 경로는 이 폴더를 가리키는 junction이다. 별도 복제본을 만들지 않는다.
- 핵심 강조 내용은 문제 데이터 변환 단계에서 분석한다. UI에서 단어 차이·숫자 정규식으로 자동 강조하지 않는다. 강조는 판단 객체의 선택 필드 `highlights`에 명시하고, 답 제출 후 해설에만 표시한다.
