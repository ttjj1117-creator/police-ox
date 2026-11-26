import { useState } from "react";
import type { useFrequentIssuesLibrary } from "./library";

export function FrequentIssuesManager({
  library,
  blocked,
}: {
  library: ReturnType<typeof useFrequentIssuesLibrary>;
  blocked: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section aria-label="빈출 쟁점 자료 관리">
      <h2>빈출 쟁점 연결 자료</h2>
      <p>
        문제·해설의 버전과 출처를 대조하는 연결 파일을 가져옵니다. 로그인한
        계정에서는 기기 간 자동 동기화됩니다.
      </p>
      <label>
        쟁점 연결 JSON 가져오기
        <input
          type="file"
          accept=".json,application/json"
          disabled={blocked || busy}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setBusy(true);
            setMessage("");
            try {
              await library.import(JSON.parse(await file.text()));
              setMessage("쟁점 연결 자료를 저장했습니다.");
            } catch (reason) {
              setMessage(
                reason instanceof Error
                  ? reason.message
                  : "연결 파일을 읽지 못했습니다.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {blocked && (
        <p>진행 중 풀이를 종료한 뒤 연결 자료를 변경할 수 있습니다.</p>
      )}
      {busy && <p role="status">연결 자료를 확인하고 저장하는 중…</p>}
      {(message || library.error) && (
        <p role="status">{message || library.error}</p>
      )}
    </section>
  );
}
