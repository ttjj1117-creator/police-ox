import { useState } from "react";
import type { Question } from "./model";
import type {
  LearningAnalytics,
  Metrics,
  ReviewScope,
  UnitStats,
} from "./review-analytics";
import {
  DEFAULT_REVIEW_LIMIT,
  formatPercent,
  sortUnitStats,
} from "./review-analytics";
import { subjectLabels } from "./validation";
import {
  LearningBar,
  LearningLegend,
  ReviewRecommendations,
  SampleBadge,
  orderConflictCount,
  reviewScopeLabel,
  type ReviewStartAction,
} from "./ReviewRecommendations";
import "./review-progress.css";

export interface LearningStatusProps {
  analytics: LearningAnalytics;
  scope: ReviewScope;
  onScopeChange: (scope: ReviewScope) => void;
  availableQuestions: Question[];
  busy: boolean;
  onStart: ReviewStartAction;
  active: boolean;
  onResume: () => void;
}
type RowFilter = "all" | "unanswered" | "review";
type RowSort = "registry" | "completion" | "wrong";
function statusLabel(metrics: Metrics, subject = false) {
  if (metrics.N > 0 && orderConflictCount(metrics) > 0)
    return "응답 순서 확인 필요";
  return metrics.N === 0
    ? subject
      ? "문제 등록 필요"
      : "등록 문항 없음"
    : metrics.A === 0
      ? subject
        ? "미학습 과목"
        : "미풀이 단원"
      : metrics.M > 0
        ? "학습 진행 중"
        : "전체 문항 응답 완료";
}
function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
export function LearningStatus({
  analytics,
  scope,
  onScopeChange,
  availableQuestions,
  busy,
  onStart,
  active,
  onResume,
}: LearningStatusProps) {
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  const [rowSort, setRowSort] = useState<RowSort>("registry");
  const yearValues = [
    ...new Set(
      availableQuestions.map((question) => String(question.source.year)),
    ),
  ].sort((a, b) => Number(b) - Number(a));
  const roundValues = [
    ...new Set(
      availableQuestions
        .filter(
          (question) =>
            !scope.year || String(question.source.year) === scope.year,
        )
        .map((question) => question.source.round),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const scopedUnits = analytics.units.filter(
    (unit) => !scope.subjectId || unit.subjectId === scope.subjectId,
  );
  const rows = sortUnitStats(
    scopedUnits.filter((unit) =>
      rowFilter === "unanswered"
        ? unit.M > 0
        : rowFilter === "review"
          ? unit.unresolved > 0
          : true,
    ),
    rowSort,
  );
  const subjectsInScope = analytics.subjects.filter(
    (subject) => !scope.subjectId || subject.subjectId === scope.subjectId,
  );
  const pending = subjectsInScope.filter((subject) => subject.pending.N > 0);
  return (
    <div className="learning-status">
      <div className="original-eyebrow">YOUR LEARNING PROGRESS</div>
      <h1>학습 현황</h1>
      <p className="learning-page-lead">
        푼 만큼 확인하고, 필요한 단원부터 다시 시작하세요.
      </p>
      <p className="learning-population-note">
        현재 등록된 출제 가능한 문항 기준입니다. 고유 문항별 최근 유효 응답으로
        집계하며, 모의고사 공란은 풀이로 세지 않습니다.
      </p>
      {active && (
        <section
          className="original-resume learning-active-notice"
          aria-label="진행 중 학습 안내"
        >
          <div>
            <h2>진행 중인 학습이 있습니다</h2>
            <p>
              현황을 살펴보는 동안에도 모의고사 시간은 계속 흐릅니다. 복습을
              새로 시작하려면 현재 풀이를 이어 풀거나 종료하세요.
            </p>
          </div>
          <button className="primary" disabled={busy} onClick={onResume}>
            이어 풀기 →
          </button>
        </section>
      )}
      <section className="learning-scope" aria-label="학습 현황 조회 범위">
        <div className="learning-section-heading">
          <h2>조회 범위</h2>
          <span className="learning-filter-note">시험 연도·회차 기준</span>
        </div>
        <div className="learning-query-fields">
          <label className="original-field">
            현황 과목
            <select
              disabled={busy}
              value={scope.subjectId}
              onChange={(event) =>
                onScopeChange({ ...scope, subjectId: event.target.value })
              }
            >
              <option value="">전체 과목</option>
              {analytics.subjects.map((subject) => (
                <option key={subject.subjectId} value={subject.subjectId}>
                  {subject.title}
                </option>
              ))}
            </select>
          </label>
          <label className="original-field">
            현황 시험 연도
            <select
              disabled={busy}
              value={scope.year}
              onChange={(event) =>
                onScopeChange({ ...scope, year: event.target.value, round: "" })
              }
            >
              <option value="">전체 시험 연도</option>
              {yearValues.map((year) => (
                <option key={year} value={year}>
                  {year}년
                </option>
              ))}
              {scope.year && !yearValues.includes(scope.year) && (
                <option value={scope.year}>
                  {scope.year}년 · 등록 문항 없음
                </option>
              )}
            </select>
          </label>
          <label className="original-field">
            현황 회차
            <select
              disabled={busy}
              value={scope.round}
              onChange={(event) =>
                onScopeChange({ ...scope, round: event.target.value })
              }
            >
              <option value="">전체 회차</option>
              {roundValues.map((round) => (
                <option key={round} value={round}>
                  {round}차
                </option>
              ))}
              {scope.round && !roundValues.includes(scope.round) && (
                <option value={scope.round}>
                  {scope.round}차 · 등록 문항 없음
                </option>
              )}
            </select>
          </label>
        </div>
        <p className="learning-applied-scope" role="status">
          적용 중: <strong>{reviewScopeLabel(scope)}</strong> ·{" "}
          {analytics.overall.N}문항
        </p>
      </section>
      <div className="learning-section-heading">
        <h2>과목별 학습</h2>
        <span className="learning-filter-note">
          풀이율 = 응답한 고유 문항 / 등록 문항
        </span>
      </div>
      <div className="learning-subject-grid">
        {analytics.subjects.map((subject) => {
          const outside =
            !!scope.subjectId && scope.subjectId !== subject.subjectId;
          return (
            <article
              className={`learning-subject-card${outside ? " learning-outside-scope" : ""}`}
              key={subject.subjectId}
              data-subject-id={subject.subjectId}
              aria-label={`${subject.title} 학습 현황`}
            >
              <div className="learning-card-heading">
                <h3>{subject.title}</h3>
                <span
                  className={`learning-badge${orderConflictCount(subject) > 0 ? " learning-order-badge" : subject.N > 0 && subject.A === 0 ? " learning-not-started" : ""}`}
                >
                  {outside ? "조회 범위 밖" : statusLabel(subject, true)}
                </span>
              </div>
              <div className="learning-subject-rate">
                <strong>{formatPercent(subject.completionRate)}</strong>
                <span>
                  풀이 {subject.A}/{subject.N}문항
                </span>
              </div>
              <LearningBar metrics={subject} label={subject.title} />
              <dl className="learning-subject-metrics">
                <div>
                  <dt>등록 문항</dt>
                  <dd>{subject.N}</dd>
                </div>
                <div>
                  <dt>미풀이</dt>
                  <dd>{subject.M}</dd>
                </div>
                <div>
                  <dt>미해결</dt>
                  <dd>{subject.unresolved}</dd>
                </div>
                <div>
                  <dt>모르겠음</dt>
                  <dd>{subject.U}</dd>
                </div>
              </dl>
              {orderConflictCount(subject) > 0 && (
                <p className="learning-order-count">
                  응답 순서 확인 필요{" "}
                  <strong>{orderConflictCount(subject)}문항</strong>
                </p>
              )}
              <div className="learning-subject-wrong">
                <span>
                  오답률 <b>{formatPercent(subject.wrongRate)}</b>
                </span>
                <SampleBadge metrics={subject} />
              </div>
              <p className="learning-small-counts">
                오답 {subject.W}/{subject.B} · 정답 {subject.C} · 반복 오답{" "}
                {subject.repeated}
              </p>
              <p className="learning-pending-count">
                분류 대기 {subject.pending.N}문항{" "}
                <span>
                  풀이 {subject.pending.A} · 미해결 {subject.pending.unresolved}
                  {orderConflictCount(subject.pending) > 0 &&
                    ` · 응답 순서 확인 필요 ${orderConflictCount(subject.pending)}`}
                </span>
              </p>
            </article>
          );
        })}
      </div>
      <LearningLegend
        showOrderConflicts={orderConflictCount(analytics.overall) > 0}
      />
      <ReviewRecommendations
        analytics={analytics}
        busy={busy}
        onStart={onStart}
        scopeLabel="현재 조회 범위"
      />
      <section className="learning-units" aria-label="단원별 학습 현황">
        <div className="learning-section-heading">
          <div>
            <h2>단원별 현황</h2>
            <p className="learning-description">
              주 단원이 확인된 문항을 한 단원에만 집계합니다. 관련 단원에 중복
              가산하지 않습니다.
            </p>
          </div>
        </div>
        <div className="learning-row-controls">
          <label className="original-field">
            단원 표시
            <select
              value={rowFilter}
              onChange={(event) =>
                setRowFilter(event.target.value as RowFilter)
              }
            >
              <option value="all">전체</option>
              <option value="unanswered">미풀이 있음</option>
              <option value="review">복습 필요</option>
            </select>
          </label>
          <label className="original-field">
            단원 정렬
            <select
              value={rowSort}
              onChange={(event) => setRowSort(event.target.value as RowSort)}
            >
              <option value="registry">기본 단원 순</option>
              <option value="completion">풀이율 낮은 순</option>
              <option value="wrong">오답률 높은 순</option>
            </select>
          </label>
        </div>
        <p className="learning-filter-summary" role="status">
          {scopedUnits.length}개 단원 중 {rows.length}개 표시 ·{" "}
          {rowFilter === "all"
            ? "전체 단원"
            : rowFilter === "unanswered"
              ? "미풀이 있음"
              : "복습 필요"}{" "}
          ·{" "}
          {rowSort === "registry"
            ? "기본 단원 순"
            : rowSort === "completion"
              ? "풀이율 낮은 순"
              : "오답률 높은 순"}
          <span>
            표시·정렬은 위 과목 요약과 추천의 집계 범위를 바꾸지 않습니다.
          </span>
        </p>
        {rows.length ? (
          <ul className="learning-unit-list">
            {rows.map((unit) => (
              <li key={unit.code}>
                <UnitRow
                  unit={unit}
                  scope={scope}
                  busy={busy}
                  onStart={onStart}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className="learning-row-empty">
            <p>현재 표시 조건에 맞는 단원이 없습니다.</p>
            {rowFilter !== "all" && (
              <button onClick={() => setRowFilter("all")}>
                전체 단원 보기
              </button>
            )}
          </div>
        )}
      </section>
      <section
        className="learning-pending-section"
        aria-label="분류 대기 학습 현황"
      >
        <div className="learning-section-heading">
          <h2>분류 대기</h2>
          <span className="learning-badge">과목 합계에 포함</span>
        </div>
        <p className="learning-description">
          주 단원이 확정되지 않은 문항입니다. 임의 단원에 배정하지 않으며
          과목별로 학습할 수 있습니다.
        </p>
        {pending.length ? (
          <ul className="learning-unit-list">
            {pending.map((subject) => (
              <li key={subject.subjectId}>
                <UnitRow
                  unit={subject.pending}
                  scope={scope}
                  busy={busy}
                  onStart={onStart}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="learning-filter-summary">
            현재 조회 범위에 분류 대기 문항이 없습니다.
          </p>
        )}
      </section>
    </div>
  );
}

function UnitRow({
  unit,
  scope,
  busy,
  onStart,
}: {
  unit: UnitStats;
  scope: ReviewScope;
  busy: boolean;
  onStart: ReviewStartAction;
}) {
  const label = `${subjectLabels[unit.subjectId]} ${unit.title}`;
  const pending = unit.code === null;
  return (
    <article
      className={`learning-unit-row${unit.N === 0 ? " learning-unit-empty" : ""}${pending ? " learning-unit-pending" : ""}`}
      data-unit-code={unit.code ?? `pending-${unit.subjectId}`}
      aria-label={`${label} 현황`}
    >
      <div className="learning-unit-grid">
        <div className="learning-unit-title">
          <span className="learning-unit-group">
            {subjectLabels[unit.subjectId]} · {unit.group}
          </span>
          <h3>{unit.title}</h3>
          <div className="learning-unit-badges">
            <span
              className={`learning-badge${orderConflictCount(unit) > 0 ? " learning-order-badge" : unit.N > 0 && unit.A === 0 ? " learning-not-started" : ""}`}
            >
              {statusLabel(unit)}
            </span>
            {unit.isTemporary && (
              <span className="learning-badge learning-temporary">
                임시 대분류
              </span>
            )}
          </div>
        </div>
        <div className="learning-unit-progress">
          <div>
            <span>
              풀이 {unit.A}/{unit.N}문항
            </span>
            <strong>{formatPercent(unit.completionRate)}</strong>
          </div>
          <LearningBar metrics={unit} label={label} />
          <p>
            정답 {unit.C} · 오답 {unit.W} · 모르겠음 {unit.U} · 미풀이 {unit.M}
            {orderConflictCount(unit) > 0 &&
              ` · 응답 순서 확인 필요 ${orderConflictCount(unit)}`}
          </p>
        </div>
        <div className="learning-unit-rates">
          <div>
            <span>오답률</span>
            <strong>{formatPercent(unit.wrongRate)}</strong>
            <SampleBadge metrics={unit} />
          </div>
          <p>
            오답 {unit.W}/{unit.B} · 미해결 {unit.unresolved}문항
          </p>
          <p>
            반복 오답 {unit.repeated}문항 · 미해결률{" "}
            {formatPercent(unit.unresolvedRate)}
          </p>
        </div>
      </div>
      <div className="learning-unit-footer">
        <span className="learning-last-response">
          최근 유효 응답{" "}
          <time dateTime={unit.lastAnsweredAt ?? undefined}>
            {dateLabel(unit.lastAnsweredAt)}
          </time>
        </span>
        <div className="learning-unit-actions">
          {orderConflictCount(unit) > 0 && (
            <span className="learning-order-guidance">
              계정·기기 동기화에서 응답 순서를 확인해 주세요.
            </span>
          )}
          {unit.unresolved > 0 && (
            <button
              className="primary"
              disabled={busy}
              aria-label={`${label} 복습 (${Math.min(DEFAULT_REVIEW_LIMIT, unit.unresolved)}문항)`}
              onClick={() =>
                onStart(unit.subjectId, unit.code, "review", scope)
              }
            >
              복습 ({Math.min(DEFAULT_REVIEW_LIMIT, unit.unresolved)}문항)
            </button>
          )}
          {unit.M > 0 && (
            <button
              disabled={busy}
              aria-label={`${label} 미풀이 풀기 (${Math.min(DEFAULT_REVIEW_LIMIT, unit.M)}문항)`}
              onClick={() =>
                onStart(unit.subjectId, unit.code, "unanswered", scope)
              }
            >
              미풀이 풀기 ({Math.min(DEFAULT_REVIEW_LIMIT, unit.M)}문항)
            </button>
          )}
          {unit.N === 0 && (
            <>
              <span className="learning-no-data">
                등록 문항이 없어 시작할 수 없습니다.
              </span>
              <button disabled>미풀이 풀기</button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
