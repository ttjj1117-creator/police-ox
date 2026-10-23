import { useEffect, useState } from "react";
import type { OriginalState } from "../engine";
import { download, MAX_FILE_BYTES } from "../../data/transfer";
import type { CloudController, CloudView } from "./controller";
import "./cloud.css";

export function CloudPanel({
  cloud,
  state,
  namespace,
  busy,
  onBackup,
}: {
  cloud: CloudView & { controller: CloudController };
  state: OriginalState;
  namespace: string;
  busy: boolean;
  onBackup: () => void;
}) {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [url, setUrl] = useState(""),
    [key, setKey] = useState("");
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<CloudController["importPreview"]>
  > | null>(null);
  useEffect(() => {
    setPreview(null);
    setCode("");
    setEmail("");
    setSent(false);
    setError("");
  }, [cloud.ownerId]);
  const active = state.sessions.some((s) => s.status === "active"),
    disabled = busy || working || cloud.busy;
  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="cloud-page">
      <h1>계정·기기 동기화</h1>
      <p>
        PC와 갤탭에서 같은 계정으로 로그인하면 문제은행과 완료·종료한 학습
        기록을 공유합니다.
      </p>
      <p className="cloud-note">
        진행 중 답안은 시작한 기기에 남습니다. 학습을 마치거나 종료하면 다른
        기기로 전송합니다. 글자 크기는 이 기기에만 저장합니다.
      </p>
      {namespace === "demo" ? (
        <section>
          <h2>시연 영역</h2>
          <p>
            시연 문제와 기록은 동기화하지 않습니다. 실제 학습 영역에서 계정을
            연결하세요.
          </p>
        </section>
      ) : (
        <>
          <section aria-label="동기화 상태">
            <h2>
              {cloud.auth
                ? (cloud.auth.user.email ?? "로그인한 계정")
                : "내 기기와 클라우드"}
            </h2>
            <p role="status">{cloud.message}</p>
            {cloud.lastSuccess && (
              <p>
                마지막 성공:{" "}
                {new Date(cloud.lastSuccess).toLocaleString("ko-KR")}
              </p>
            )}
            {cloud.auth && (
              <>
                <p>
                  전송 대기 {cloud.pending}건 · 응답 순서 확인 필요{" "}
                  {cloud.conflictIds.length}문항
                </p>
                <p>
                  문제 {state.data.questions.length}문항 · 그림{" "}
                  {state.data.assets.length}개를 이 기기에 저장했습니다.
                  내려받은 자료는 오프라인에서도 사용할 수 있습니다.
                </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() => run(() => cloud.controller.sync())}
                  >
                    지금 동기화
                  </button>
                  <button onClick={onBackup}>전체 백업 내보내기</button>
                  <button
                    onClick={() =>
                      run(async () => {
                        if (!cloud.ownerId) return;
                        const snapshot = await cloud.controller.store.read(
                          cloud.ownerId,
                        );
                        download(
                          {
                            format: "police-sync-recovery",
                            version: 1,
                            ownerId: cloud.ownerId,
                            state: snapshot.state,
                            meta: snapshot.meta,
                          },
                          "police-sync-private-recovery.json",
                        );
                      })
                    }
                  >
                    동기화 대기열·충돌 복구 파일
                  </button>
                  <button
                    disabled={disabled || active}
                    onClick={() =>
                      run(async () => {
                        if (
                          cloud.pending &&
                          !window.confirm(
                            `미전송 ${cloud.pending}건을 이 기기에 보관하고 로그아웃할까요? 다시 같은 계정으로 로그인하면 전송합니다.`,
                          )
                        )
                          return;
                        await cloud.controller.logout();
                      })
                    }
                  >
                    로그아웃
                  </button>
                </div>
              </>
            )}
            {active && (
              <p>
                진행 중 학습은 이 기기에서 이어 풀 수 있습니다. 계정을 바꾸려면
                먼저 학습을 종료하세요.
              </p>
            )}
          </section>
          {!cloud.auth && cloud.config && (
            <section>
              <h2>이메일로 로그인</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await cloud.controller.sendCode(email);
                    setSent(true);
                  });
                }}
              >
                <label className="original-field">
                  이메일
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={disabled || active}
                  />
                </label>
                <button disabled={disabled || active}>로그인 메일 받기</button>
              </form>
              <p>
                추가 결제 없이 기본 로그인 링크를 사용할 수 있습니다. 메일의
                로그인 링크를 PC나 갤탭에서 이 앱을 사용할 브라우저로 여세요.
              </p>
              {sent && (
                <>
                  <p role="status">
                    로그인 메일을 보냈습니다. 메일의 링크를 누르세요. 인증번호가
                    포함된 메일을 받은 경우 아래 번호 입력도 사용할 수 있습니다.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(() => cloud.controller.verify(email, code));
                    }}
                  >
                    <label className="original-field">
                      이메일 인증번호
                      <input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6,10}"
                        placeholder="메일에 번호가 있을 때만 입력"
                        required
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        disabled={disabled || active}
                      />
                    </label>
                    <button className="primary" disabled={disabled || active}>
                      로그인
                    </button>
                  </form>
                </>
              )}
              <p>
                메일이 오지 않으면 스팸함을 확인하세요. 링크나 번호가 만료되면
                잠시 후 새 로그인 메일을 요청하세요. 로그인이 되지 않아도 기존
                로컬 기록은 보관됩니다.
              </p>
            </section>
          )}
          {!cloud.auth && (
            <details className="cloud-setup" open={!cloud.config}>
              <summary>
                동기화 서버 연결 설정{!cloud.config && " · 설정 필요"}
              </summary>
              <p>
                웹 주소와 별도로 기록을 보관할 Supabase 프로젝트의 공개 연결값이
                필요합니다. 프로젝트 URL과 publishable key만 입력하세요.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => cloud.controller.configure(url, key));
                }}
              >
                <label className="original-field">
                  Supabase 프로젝트 URL
                  <input
                    type="url"
                    placeholder="https://프로젝트.supabase.co"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                    disabled={disabled || active}
                  />
                </label>
                <label className="original-field">
                  공개용 publishable key
                  <input
                    value={key}
                    placeholder="sb_publishable_…"
                    onChange={(e) => setKey(e.target.value)}
                    required
                    disabled={disabled || active}
                  />
                </label>
                <button disabled={disabled || active}>공개 연결값 저장</button>
              </form>
            </details>
          )}
          {cloud.auth && (
            <section aria-label="기존 기록 계정 연결">
              <h2>기존 PC 기록 연결</h2>
              <p>
                새 웹 주소는 이전 PC 주소의 기록을 자동으로 읽을 수 없습니다.
                PC에서 내보낸 실제 학습 전체 백업을 선택하거나, 이 주소의 로그인
                전 로컬 기록을 확인한 뒤 연결하세요.
              </p>
              <div className="actions">
                <button
                  disabled={disabled || active}
                  onClick={() =>
                    run(async () => {
                      setPreview(null);
                      setPreview(await cloud.controller.importPreview());
                    })
                  }
                >
                  로그인 전 이 기기 기록 미리보기
                </button>
              </div>
              <label className="original-field">
                기존 PC 실제 학습 백업
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={disabled || active}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    setPreview(null);
                    if (!file) return;
                    void run(async () => {
                      if (
                        file.size > Math.max(MAX_FILE_BYTES, 100 * 1024 * 1024)
                      )
                        throw new Error("백업 파일은 100 MiB 이하여야 합니다.");
                      setPreview(
                        await cloud.controller.importPreview(
                          JSON.parse(await file.text()),
                        ),
                      );
                    });
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              {preview && (
                <div
                  className="cloud-preview"
                  role="region"
                  aria-label="기록 연결 미리보기"
                >
                  <p>
                    문제 {preview.questions}문항 · 완료·종료 세션{" "}
                    {preview.sessions}개 · 공유할 응답 {preview.attempts}건 ·
                    내용 충돌 {preview.conflicts}건
                  </p>
                  {preview.state.sessions.some(
                    (s) => s.status === "active",
                  ) && (
                    <p>
                      백업의 진행 중 세션은 클라우드로 전송하지 않습니다. 이전
                      PC에서 학습을 종료한 뒤 새 백업을 연결하면 그 기록도
                      공유할 수 있습니다.
                    </p>
                  )}
                  <p>
                    기존 클라우드 기록과 합치며, 이전 PC의 원본 기록은 삭제하지
                    않습니다. OX는 원본 백업으로 별도 보관합니다.
                  </p>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() =>
                        run(async () => {
                          await cloud.controller.connectExisting(
                            preview.state,
                            preview.source,
                          );
                          setPreview(null);
                        })
                      }
                    >
                      미리보기 확인하고 계정에 연결
                    </button>
                    <button onClick={() => setPreview(null)}>취소</button>
                  </div>
                </div>
              )}
              <button
                disabled={disabled}
                onClick={() =>
                  run(async () => {
                    const source = await cloud.controller.store.getValue(
                      `sync:migration-source:${cloud.ownerId}`,
                    );
                    if (!source)
                      throw new Error("연결한 원본 백업 파일이 없습니다.");
                    download(
                      source,
                      "police-learning-migration-original-backup.json",
                    );
                  })
                }
              >
                연결한 원본 전체 백업 내보내기
              </button>
            </section>
          )}
          {cloud.meta?.projection.responseConflicts.map((conflict) => (
            <section
              key={`${conflict.questionId}:${conflict.gradingRevision}`}
              className="cloud-conflict"
            >
              <h2>응답 순서 확인 필요</h2>
              <p>
                {conflict.questionId} · 채점 버전 {conflict.gradingRevision}.
                선후 관계를 확인하기 어려운 응답입니다. 현재 대표 상태로 사용할
                실제 기록을 선택하세요. 두 원본 기록은 모두 보존합니다.
              </p>
              <div className="actions">
                {conflict.attemptIds.map((id) => {
                  const a = state.attempts.find(
                    (attempt) => attempt.attemptId === id,
                  );
                  return a ? (
                    <button
                      key={id}
                      disabled={disabled}
                      onClick={() =>
                        run(() =>
                          cloud.controller.resolve(
                            conflict.questionId,
                            conflict.gradingRevision,
                            id,
                            conflict.attemptIds,
                          ),
                        )
                      }
                    >
                      {new Date(a.answeredAt).toLocaleString("ko-KR")} ·{" "}
                      {a.result === "correct"
                        ? "정답"
                        : a.result === "incorrect"
                          ? "오답"
                          : "모르겠음"}{" "}
                      기록 선택
                    </button>
                  ) : null;
                })}
              </div>
            </section>
          ))}
          {cloud.meta &&
            Object.entries(cloud.meta.failures).map(([id, reason]) => (
              <section className="cloud-conflict" key={id}>
                <h2>변경 내용 확인 필요</h2>
                <p>{reason}</p>
                <p>
                  다른 기기의 최신 내용을 받은 뒤, 이 기기에 남은 변경을 다시
                  반영할 수 있습니다. 오래된 삭제·표시 변경이 포함되었는지 먼저
                  확인하세요.
                </p>
                <button onClick={onBackup}>먼저 전체 백업 내보내기</button>
                <button
                  disabled={disabled || active}
                  onClick={() => {
                    if (
                      window.confirm(
                        "최신 버전을 확인한 이 기기의 변경을 다시 반영할까요?",
                      )
                    )
                      void run(() => cloud.controller.retryVersionConflict(id));
                  }}
                >
                  최신 버전 확인 후 내 변경 다시 반영
                </button>
                {cloud.meta?.outbox.find((event) => event.eventId === id)
                  ?.kind === "mark" && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      run(() => cloud.controller.keepRemoteMark(id))
                    }
                  >
                    클라우드 표시 상태 유지
                  </button>
                )}
              </section>
            ))}
          {cloud.meta?.projection.bankConflicts.length ||
          cloud.meta?.projection.recordConflicts.length ? (
            <section className="cloud-conflict">
              <h2>내용 충돌 보관 중</h2>
              <p>
                같은 식별자의 내용이 달라 자동으로 덮어쓰지 않았습니다. 백업을
                보관하고 문제 파일·기록의 버전을 확인하세요.
              </p>
              {[
                ...(cloud.meta?.projection.bankConflicts ?? []),
                ...(cloud.meta?.projection.recordConflicts ?? []),
              ].map((c) => (
                <p key={c.eventId}>{c.reason}</p>
              ))}
              <button onClick={onBackup}>전체 백업 내보내기</button>
            </section>
          ) : null}
        </>
      )}
      {(error || cloud.error) && (
        <p role="alert" className="original-error">
          {error || cloud.error}
        </p>
      )}
    </div>
  );
}
