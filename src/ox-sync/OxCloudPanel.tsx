import { useEffect, useRef, useState } from "react";
import type { Namespace, State } from "../domain/schema";
import { download } from "../data/transfer";
import { appUrl } from "../pwa/base";
import type { useOxSync } from "./controller";
import "./ox-cloud.css";

export type OxCloudView = ReturnType<typeof useOxSync>;
export type OxCloudPreview = Awaited<
  ReturnType<OxCloudView["controller"]["importPreview"]>
>;
export interface OxCloudPanelProps {
  cloud: OxCloudView;
  state: State;
  busy: boolean;
  onBackup: () => void;
  namespace?: Namespace;
  compact?: boolean;
}

export function OxCloudPanel({
  cloud,
  state,
  busy,
  onBackup,
  namespace = "real",
  compact = false,
}: OxCloudPanelProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<OxCloudPreview | null>(null);
  const scope = namespace + ":" + (cloud.ownerId ?? "legacy");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const active = state.sessions.some((session) => session.status === "active");
  const disabled = busy || working || cloud.busy || !cloud.ready;
  useEffect(() => {
    setPreview(null);
    setError("");
    setNotice("");
    setWorking(false);
  }, [scope]);
  async function run(action: () => Promise<void>) {
    if (disabled) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (scopeRef.current === scope)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (scopeRef.current === scope) setWorking(false);
    }
  }
  async function showPreview(action: () => Promise<OxCloudPreview>) {
    const next = await action();
    if (scopeRef.current === scope) setPreview(next);
  }
  const Heading = compact ? "h2" : "h1";
  const loginHref = appUrl("view=original&mode=real&panel=cloud&return=ox");
  return (
    <div className="ox-cloud-panel" aria-label="OX 계정·기기 동기화">
      <Heading>OX 계정·기기 동기화</Heading>
      <p>
        같은 계정의 PC와 갤탭에서 OX 문제은행·완료한 학습 기록·다시 보기를
        공유합니다. 원문 객관식 기록은 별도로 보관합니다.
      </p>
      <p className="ox-cloud-note">
        진행 중 답안은 시작한 기기에 남습니다. 학습을 마치거나 종료하면 다른
        기기로 전송합니다. 글자 크기·순회·균형 배정은 이 기기에 보관합니다.
      </p>
      {namespace === "demo" ? (
        <section>
          <h2>시연 영역</h2>
          <p>
            시연 문제와 기록은 클라우드에 보내지 않습니다. 실제 학습 영역에서
            계정을 연결하세요.
          </p>
        </section>
      ) : (
        <>
          <section aria-label="OX 동기화 상태">
            <h2>
              {cloud.auth?.user.email ??
                (cloud.auth ? "로그인한 계정" : "내 OX 기록과 계정")}
            </h2>
            <p role="status">{cloud.message}</p>
            {cloud.legacyMode && (
              <p className="ox-cloud-note">
                진행하던 기존 OX 학습을 이 기기에서 마무리하세요. 종료 후 아래
                ‘기존 OX 기록 연결’에서 미리보고 계정에 합칠 수 있습니다. 연결
                전까지 로그인 전 기록을 그대로 사용합니다.
              </p>
            )}
            {cloud.lastSuccess && (
              <p>
                마지막 성공:{" "}
                {new Date(cloud.lastSuccess).toLocaleString("ko-KR")}
              </p>
            )}
            {cloud.auth ? (
              <>
                <p>
                  전송 대기 {cloud.pending}건 · 확인 필요{" "}
                  {cloud.conflicts.length}건
                </p>
                <p>
                  이 기기에 지문 {state.dataset.items.length}개 · 완료·종료 세션{" "}
                  {
                    state.sessions.filter(
                      (session) => session.status !== "active",
                    ).length
                  }
                  개 · 응답 {state.attempts.length}개를 보관합니다.
                </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() => void run(() => cloud.controller.sync())}
                  >
                    지금 동기화
                  </button>
                  <button disabled={busy || working} onClick={onBackup}>
                    OX 전체 백업 내보내기
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run(async () => {
                        const value = await cloud.controller.exportRecovery();
                        if (scopeRef.current === scope)
                          download(
                            value,
                            "police-ox-sync-private-recovery.json",
                          );
                      })
                    }
                  >
                    OX 대기열·충돌 복구 파일
                  </button>
                </div>
              </>
            ) : (
              <p>
                {cloud.config
                  ? "원문 앱과 같은 로그인 계정을 사용합니다. 로그인한 뒤 기존 OX 기록을 미리보고 연결하세요."
                  : "동기화 서버 연결 설정이 필요합니다. 로컬 OX 학습과 백업은 계속 사용할 수 있습니다. 공통 계정 화면에서 서버 주소와 공개 연결값을 설정하세요."}
              </p>
            )}
            <p>
              <a
                className={active ? "ox-cloud-disabled-link" : ""}
                href={loginHref}
                aria-disabled={active}
                onClick={(event) => {
                  if (active) event.preventDefault();
                }}
              >
                {cloud.auth ? "공통 로그인 계정 관리" : "로그인·서버 설정 열기"}{" "}
                ↗
              </a>
            </p>
            {active && (
              <p className="ox-cloud-note">
                이 기기의 OX 세션을 완료하거나 종료한 뒤 계정 로그인·변경과 기존
                기록 연결을 진행하세요. 현재 답안과 문항 위치는 유지합니다.
              </p>
            )}
          </section>
          {cloud.auth && (
            <section aria-label="기존 OX 기록 계정 연결">
              <h2>기존 OX 기록 연결</h2>
              <p>
                이전 웹 주소나 PC에서 내보낸 OX 전체 백업을 선택하세요. 같은
                주소의 로그인 전 OX 기록도 직접 확인한 뒤 연결할 수 있습니다.
              </p>
              <button
                disabled={disabled || active}
                onClick={() =>
                  void run(() =>
                    showPreview(() => cloud.controller.previewLegacy()),
                  )
                }
              >
                로그인 전 OX 기록 미리보기
              </button>
              <label className="field">
                기존 OX 전체 백업
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={disabled || active}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    void run(async () => {
                      const value = JSON.parse(await file.text());
                      if (scopeRef.current === scope)
                        await showPreview(() =>
                          cloud.controller.importPreview(value),
                        );
                    });
                  }}
                />
              </label>
              {preview && (
                <div
                  className="ox-cloud-preview"
                  role="region"
                  aria-label="OX 기록 연결 미리보기"
                >
                  <p>
                    지문 {preview.items}개 · 완료·종료 세션 {preview.sessions}개
                    · 응답 {preview.attempts}개 · 내용 충돌 {preview.conflicts}
                    건
                  </p>
                  <p>
                    로그인한 OX 계정의 기존 기록과 합치고 ID·시각을 보존합니다.
                    원본 백업을 함께 보관하며, 같은 백업의 같은 기록을 반복해서
                    새로 만들지 않습니다.
                  </p>
                  <p>
                    진행 중 OX 세션은 옮기지 않습니다. 이전 기기에서 학습을
                    종료한 뒤 다시 연결하세요.
                  </p>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={disabled || active}
                      onClick={() =>
                        void run(async () => {
                          await cloud.controller.connectExisting(
                            preview.state,
                            preview.source,
                          );
                          if (scopeRef.current === scope) {
                            setPreview(null);
                            setNotice(
                              "기존 OX 기록을 계정의 기록과 합쳤습니다. 동기화 상태를 확인하세요.",
                            );
                          }
                        })
                      }
                    >
                      미리보기 확인하고 OX 계정에 연결
                    </button>
                    <button disabled={working} onClick={() => setPreview(null)}>
                      연결 취소
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {cloud.conflicts.map((conflict) => (
            <section
              key={conflict.id}
              className="ox-cloud-conflict"
              aria-label={
                conflict.kind === "order"
                  ? "OX 응답 순서 확인"
                  : "OX 동기화 충돌"
              }
            >
              <h2>
                {conflict.kind === "order"
                  ? "OX 응답 순서 확인 필요"
                  : "OX 변경 내용 확인 필요"}
              </h2>
              <p>{conflict.reason}</p>
              {conflict.kind === "order" ? (
                <>
                  <p>
                    실제 확정한 기록 중 현재 대표 상태로 사용할 기록을
                    선택하세요. 원래 응답은 함께 보관합니다.
                  </p>
                  <div className="actions">
                    {conflict.attemptIds?.map((id) => {
                      const attempt = state.attempts.find(
                        (item) => item.attemptId === id,
                      );
                      return attempt && conflict.itemId && conflict.basis ? (
                        <button
                          key={id}
                          disabled={disabled || active}
                          onClick={() =>
                            void run(() =>
                              cloud.controller.resolveOrder(
                                conflict.itemId!,
                                conflict.basis!,
                                id,
                                conflict.attemptIds!,
                              ),
                            )
                          }
                        >
                          {new Date(attempt.answeredAt).toLocaleString("ko-KR")}{" "}
                          ·{" "}
                          {attempt.response === "unknown"
                            ? "모르겠음"
                            : attempt.response}{" "}
                          기록 선택
                        </button>
                      ) : null;
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p>
                    먼저 전체 백업과 대기열 복구 파일을 보관하세요. 같은
                    식별자의 내용이 다른 경우 원본을 비교한 뒤 올바른 파일로
                    다시 등록하세요.
                  </p>
                  <div className="actions">
                    <button onClick={onBackup}>
                      먼저 OX 전체 백업 내보내기
                    </button>
                    {conflict.kind === "mark" && (
                      <button
                        disabled={disabled || active}
                        onClick={() =>
                          void run(() =>
                            cloud.controller.keepRemoteMark(conflict.id),
                          )
                        }
                      >
                        다른 기기의 최신 표시 유지
                      </button>
                    )}
                    {(conflict.kind === "bank" || conflict.kind === "mark") && (
                      <button
                        disabled={disabled || active}
                        onClick={() => {
                          if (
                            window.confirm(
                              "다른 기기의 최신 내용을 확인한 뒤, 보관된 이 기기 변경을 다시 반영할까요?",
                            )
                          )
                            void run(() =>
                              cloud.controller.retryVersionConflict(
                                conflict.id,
                              ),
                            );
                        }}
                      >
                        최신 버전 확인 후 내 변경 다시 반영
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          ))}
        </>
      )}
      {notice && (
        <p role="status" className="ox-cloud-note">
          {notice}
        </p>
      )}
      {(error || cloud.error) && (
        <p role="alert" className="ox-cloud-error">
          {error || cloud.error}
        </p>
      )}
    </div>
  );
}
