import { useEffect, useRef, useState } from "react";
import type { Namespace } from "./model";
import { activeSession, type OriginalState } from "./engine";
import {
  previewPackageDeletion,
  type PackageDeletionPreview,
} from "./deletion";
import { subjectLabels } from "./validation";
import { errorMessage } from "../domain/schema";
import "./package-manager.css";

export function PackageManager({
  state,
  namespace,
  busy,
  onDelete,
  onPreview,
}: {
  state: OriginalState;
  namespace: Namespace;
  busy: boolean;
  onDelete: (
    packageIds: string[],
    includeUnassigned: boolean,
  ) => Promise<boolean>;
  onPreview: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [includeUnassigned, setIncludeUnassigned] = useState(false);
  const [preview, setPreview] = useState<PackageDeletionPreview | null>(null);
  const [error, setError] = useState("");
  const confirm = useRef<HTMLButtonElement>(null);
  const open = useRef<HTMLButtonElement>(null);
  const allBox = useRef<HTMLInputElement>(null);
  const packages = state.data.packages;
  const removed = new Set(state.removedQuestionIds ?? []);
  const assigned = new Set(
    packages.flatMap((p) => p.questions.map((q) => q.id)),
  );
  const unassigned = state.data.questions.filter(
    (q) => !assigned.has(q.id) && !removed.has(q.id),
  );
  const blocked = !!activeSession(state);
  const availableIds = selected.filter((id) =>
    packages.some((p) => p.packageId === id),
  );
  const allSelected =
    packages.length + (unassigned.length ? 1 : 0) > 0 &&
    packages.every((p) => availableIds.includes(p.packageId)) &&
    (!unassigned.length || includeUnassigned);
  const partlySelected =
    !allSelected && (availableIds.length > 0 || includeUnassigned);
  useEffect(() => {
    setSelected([]);
    setIncludeUnassigned(false);
    setPreview(null);
    setError("");
  }, [namespace, state.data.packages]);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = partlySelected;
  }, [partlySelected]);
  useEffect(() => {
    if (preview) confirm.current?.focus();
  }, [preview]);
  const resetPreview = () => {
    setPreview(null);
    setError("");
  };
  function showPreview() {
    try {
      const result = previewPackageDeletion(
        state,
        availableIds,
        includeUnassigned,
      );
      onPreview();
      setPreview(result);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <section
      className="original-package-manager"
      aria-labelledby="original-package-title"
    >
      <h2 id="original-package-title">가져온 문제 관리</h2>
      <p>
        현재 {namespace === "demo" ? "시연" : "실제 학습"} 영역의 원문 자료를
        선택해 삭제할 수 있습니다. 적용 전 삭제 범위를 확인합니다.
      </p>
      {blocked && (
        <p className="original-notice" role="status">
          진행 중인 풀이를 종료한 뒤 문제 데이터를 삭제할 수 있습니다.
        </p>
      )}
      {!packages.length && !unassigned.length ? (
        <p className="original-muted">선택해 삭제할 자료가 없습니다.</p>
      ) : (
        <>
          <label className="package-select-all">
            <input
              ref={allBox}
              type="checkbox"
              aria-label="가져온 자료 전체 선택"
              checked={allSelected}
              disabled={busy || blocked}
              onChange={() => {
                resetPreview();
                setSelected(
                  allSelected ? [] : packages.map((p) => p.packageId),
                );
                setIncludeUnassigned(!allSelected && unassigned.length > 0);
              }}
            />
            가져온 자료 전체 선택
            <span>{packages.length + (unassigned.length ? 1 : 0)}개 자료</span>
          </label>
          <ul className="package-list">
            {packages.map((pkg, index) => {
              const subjects = [
                ...new Set(
                  pkg.questions.map((q) => subjectLabels[q.subjectId]),
                ),
              ];
              const currentIds = new Set(pkg.questions.map((q) => q.id));
              const currentCount = state.data.questions.filter(
                (q) => currentIds.has(q.id) && !removed.has(q.id),
              ).length;
              return (
                <li key={pkg.packageId}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`자료 선택: ${pkg.packageId}`}
                      checked={availableIds.includes(pkg.packageId)}
                      disabled={busy || blocked}
                      onChange={() => {
                        resetPreview();
                        setSelected(
                          availableIds.includes(pkg.packageId)
                            ? availableIds.filter((id) => id !== pkg.packageId)
                            : [...availableIds, pkg.packageId],
                        );
                      }}
                    />
                    <span className="package-info">
                      <b>
                        {namespace === "demo"
                          ? "기능 확인용 시연 자료"
                          : pkg.questions[0]?.source.examName || "빈 문제 자료"}
                      </b>
                      <span>
                        {subjects.join(" · ") || "등록 문항 없음"} · 현재{" "}
                        {currentCount}문항
                      </span>
                      <small>
                        자료 {index + 1} · 버전 {pkg.packageVersion} ·{" "}
                        {new Date(pkg.exportedAt).toLocaleDateString("ko-KR")}
                      </small>
                    </span>
                  </label>
                </li>
              );
            })}
            {unassigned.length > 0 && (
              <li>
                <label>
                  <input
                    type="checkbox"
                    aria-label="파일 연결이 없는 보관 문제 선택"
                    checked={includeUnassigned}
                    disabled={busy || blocked}
                    onChange={() => {
                      resetPreview();
                      setIncludeUnassigned(!includeUnassigned);
                    }}
                  />
                  <span className="package-info">
                    <b>파일 연결이 없는 보관 문제</b>
                    <span>
                      {unassigned.length}문항 · 이전 자료 갱신에서 유지된 문제
                    </span>
                  </span>
                </label>
              </li>
            )}
          </ul>
          <div className="package-delete-actions">
            <span>
              {availableIds.length + (includeUnassigned ? 1 : 0)}개 자료 선택
            </span>
            <button
              ref={open}
              className="package-danger"
              disabled={
                busy || blocked || (!availableIds.length && !includeUnassigned)
              }
              onClick={showPreview}
            >
              선택한 데이터 삭제
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="original-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div
          className="package-delete-confirm"
          role="region"
          aria-label="삭제 전 확인"
        >
          <h3>삭제 전 확인</h3>
          <p>
            선택한 자료{" "}
            {preview.packageIds.length + (preview.includeUnassigned ? 1 : 0)}
            개를 삭제합니다.
          </p>
          <dl>
            <div>
              <dt>학습 목록에서 제거</dt>
              <dd>{preview.questionIds.length}문항</dd>
            </div>
            <div>
              <dt>완전히 삭제할 문제</dt>
              <dd>{preview.removeCount}문항</dd>
            </div>
            <div>
              <dt>과거 풀이 기록으로만 보관</dt>
              <dd>{preview.archiveCount}문항</dd>
            </div>
            <div>
              <dt>다른 자료에 포함되어 유지</dt>
              <dd>{preview.sharedCount}문항</dd>
            </div>
          </dl>
          <p>
            삭제한 자료와 기록이 없는 문제는 전체 백업 없이는 되돌릴 수
            없습니다. 이미 푼 문제의 결과와 기록은 보존하고, 새 학습에서는
            제외합니다. 다른 저장 영역과 기존 OX 자료는 유지합니다.
          </p>
          <div className="actions">
            <button
              ref={confirm}
              className="package-danger solid"
              disabled={busy || blocked}
              onClick={async () => {
                if (
                  await onDelete(preview.packageIds, preview.includeUnassigned)
                ) {
                  setSelected([]);
                  setIncludeUnassigned(false);
                  setPreview(null);
                }
              }}
            >
              삭제 확정
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPreview(null);
                open.current?.focus();
              }}
            >
              삭제 취소
            </button>
          </div>
        </div>
      )}
      {removed.size > 0 && (
        <p className="original-muted">
          삭제한 문제 중 {removed.size}문항은 과거 풀이 결과를 보존하기 위해
          보관 중이며, 새 학습과 문제 데이터 내보내기에서는 제외됩니다.
        </p>
      )}
    </section>
  );
}
