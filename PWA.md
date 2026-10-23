# PWA

기존 배포의 아이콘·설치 주소와 `node scripts/check-pwa.mjs` 진입점을 유지하며, 정적 파일 캐시와 업데이트 흐름은 현재 원문·OX 앱에 맞게 통합했다.

`docs/WEB_DEPLOYMENT.md`에 Pages 설정·허용 산출물·개인 데이터 경계·현재 검증 결과가 있다. `docs/PC_TO_TABLET_MIGRATION.md`는 기존 PC 백업을 웹 계정에 연결하는 절차다.

새 서비스 워커는 정확한 빌드 정적 파일만 저장하며 API·인증 응답을 공용 캐시에 넣지 않는다. 업데이트는 대기 알림 후 사용자가 `앱 업데이트 적용`을 눌렀을 때 적용한다. 원문·기존 OX·계정별 저장 영역에 진행 중 풀이가 있으면 보류하며, 답안·타이머·IndexedDB·전송 대기열을 삭제하지 않는다. 자동 새로고침하지 않는다.

```sh
npm test
npm run build
npm run test:e2e
node scripts/check-pwa.mjs
```

마지막 명령은 격리된 production 빌드와 Chromium 프로필로 `/police-ox/` 하위 경로, manifest·아이콘, 오프라인 재실행, 개인 응답 캐시 제외, 진행 중 시험의 업데이트 차단, 완료 후 명시 업데이트와 기록 보존을 검사한다.

Chrome의 설치 메뉴와 일반 브라우저 실행을 함께 지원한다. 실제 Tab S11·Samsung Internet의 설치는 기기에서 별도로 확인해야 한다. 미전송 기록을 보관하려면 전체 백업을 함께 유지한다.
