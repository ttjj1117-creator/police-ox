import { useSyncExternalStore } from "react";
import { applyPwaUpdate, getPwaSnapshot, subscribePwa } from "./runtime";
import "./pwa.css";

export function PwaStatus() {
  const status = useSyncExternalStore(subscribePwa, getPwaSnapshot);
  if (!status.waiting && !status.offline && !status.notice) return null;
  return (
    <aside className="pwa-status" aria-label="앱 설치 및 업데이트">
      <div role="status" aria-live="polite">
        {status.offline && (
          <p>
            {status.ready
              ? "오프라인입니다. 이 기기에 내려받은 문제를 풀 수 있습니다. 전송 대기 기록은 앱을 다시 연결하면 보냅니다."
              : "오프라인입니다. 이 기기에 저장된 학습 기록을 유지합니다."}
          </p>
        )}
        {status.waiting && (
          <p>
            새 앱 버전이 준비되었습니다. 진행 중인 풀이를 마친 뒤 적용해 주세요.
          </p>
        )}
        {status.notice && <p>{status.notice}</p>}
      </div>
      {status.waiting && (
        <button
          type="button"
          disabled={status.busy}
          onClick={() => void applyPwaUpdate()}
        >
          {status.busy ? "저장 상태 확인 중…" : "앱 업데이트 적용"}
        </button>
      )}
    </aside>
  );
}
