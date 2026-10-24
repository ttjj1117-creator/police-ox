import { useState } from "react";
import type { Namespace, State } from "../domain/schema";
import { errorMessage } from "../domain/schema";
import {
  removalIds,
  removeItems,
  type RemovalFilter,
} from "../data/remove-items";
import { subjects } from "../fixtures/data";

export function DeleteItems({
  state,
  namespace,
  busy,
  onDelete,
  preserveLearningRecords = false,
}: {
  state: State;
  namespace: Namespace;
  busy: boolean;
  onDelete: (ids: string[]) => void;
  preserveLearningRecords?: boolean;
}) {
  const [filter, setFilter] = useState<RemovalFilter>({
    subjectId: "",
    year: "",
    round: "",
  });
  const [preview, setPreview] = useState<{
    ids: string[];
    counts: ReturnType<typeof removeItems>["counts"];
  } | null>(null);
  const [error, setError] = useState("");
  const active = state.sessions.some((session) => session.status === "active");
  const update = (patch: Partial<RemovalFilter>) => {
    setFilter({ ...filter, ...patch });
    setPreview(null);
    setError("");
  };
  return (
    <section aria-labelledby="delete-items-title">
      <h2 id="delete-items-title">문제 데이터 삭제</h2>
      <p>
        {preserveLearningRecords
          ? "선택한 문제를 계정의 문제은행에서 제거합니다. 과거 풀이 응답과 완료·종료 세션은 보존합니다. 제거 전 전체 백업을 권장합니다."
          : `현재 ${namespace === "real" ? "실제" : "시연"} 영역에서 선택한 문제와 관련 학습 기록을 삭제합니다. 삭제 전 전체 백업을 권장합니다.`}
      </p>
      <div className="fields">
        <label className="field">
          삭제 과목
          <select
            value={filter.subjectId}
            disabled={busy}
            onChange={(e) =>
              update({
                subjectId: e.target.value as RemovalFilter["subjectId"],
              })
            }
          >
            <option value="">전체</option>
            {Object.entries(subjects).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          삭제 연도
          <select
            value={filter.year}
            disabled={busy}
            onChange={(e) => update({ year: e.target.value })}
          >
            <option value="">전체</option>
            {[...new Set(state.dataset.items.map((item) => item.source.year))]
              .sort((a, b) => b - a)
              .map((year) => (
                <option key={year} value={String(year)}>
                  {year}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          삭제 회차
          <select
            value={filter.round}
            disabled={busy}
            onChange={(e) => update({ round: e.target.value })}
          >
            <option value="">전체</option>
            {[...new Set(state.dataset.items.map((item) => item.source.round))]
              .sort()
              .map((round) => (
                <option key={round} value={round}>
                  {round}
                </option>
              ))}
          </select>
        </label>
      </div>
      {active && <p className="notice">진행 중 세션을 종료한 뒤 삭제하세요.</p>}
      {error && <p role="alert">{error}</p>}
      <button
        className="danger"
        disabled={busy || active}
        onClick={() => {
          setError("");
          setPreview(null);
          try {
            const ids = removalIds(state, filter);
            const { counts } = removeItems(state, new Set(ids), {
              preserveLearningRecords,
            });
            setPreview({ ids, counts });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        삭제 대상 확인
      </button>
      {preview && !active && (
        <div className="preview" role="region" aria-label="문제 삭제 미리보기">
          <p>삭제 예정 문제: {preview.counts.items}개</p>
          <p>
            과목: {filter.subjectId ? subjects[filter.subjectId] : "전체"} ·
            연도: {filter.year || "전체"} · 회차: {filter.round || "전체"}
          </p>
          <p>
            {preserveLearningRecords
              ? "과거 응답·완료 세션·문항 스냅샷은 보존합니다. 아래 표시·기기 순회·자료 처리 상태만 정리합니다."
              : "함께 정리될 관련 학습 기록"}
          </p>
          <ul>
            <li>응답(attempts): {preview.counts.attempts}개</li>
            <li>다시 보기(marks): {preview.counts.marks}개</li>
            <li>
              세션(sessions): {preview.counts.sessions}개 제거 · 혼합 세션{" "}
              {preview.counts.sessionsPruned}개에서 삭제 지문만 정리
            </li>
            <li>세션 지문 스냅샷: {preview.counts.snapshots}개</li>
            <li>
              순회(cycles): {preview.counts.cyclesRemoved}개 제거 ·{" "}
              {preview.counts.cyclesUpdated}개 정리
            </li>
            <li>
              균형 배정(allocations): {preview.counts.allocationAssignments}회
              차감 · {preview.counts.allocationsRemoved}개 항목 제거
            </li>
            <li>자료 처리 상태(coverage): {preview.counts.coverage}개 제거</li>
          </ul>
          <p>
            {preserveLearningRecords
              ? "문제 제거는 같은 계정의 다른 기기에도 반영됩니다. 과거 풀이 기록과 목차·학습 묶음·설정은 유지합니다. 문제를 복원하려면 검증한 문제 파일을 다시 가져오세요."
              : "비삭제 문제의 응답과 목차·학습 묶음·설정은 유지합니다. 삭제 후 되돌리려면 전체 백업이 필요합니다."}
          </p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy || !preview.counts.items}
              onClick={() => onDelete(preview.ids)}
            >
              문제 {preview.counts.items}개 삭제
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              삭제 취소
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
