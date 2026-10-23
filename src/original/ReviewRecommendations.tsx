import type {
  LearningAnalytics,
  Metrics,
  ReviewScope,
  UnitStats,
} from "./review-analytics";
import {
  DEFAULT_REVIEW_LIMIT,
  MAX_RECOMMENDATIONS,
  MIN_GRADED_QUESTIONS,
  formatPercent,
} from "./review-analytics";
import { subjectLabels } from "./validation";
import "./review-progress.css";

export type ReviewStartAction = (
  subjectId: string,
  unitCode: string | null,
  kind: "review" | "unanswered",
  scope: ReviewScope,
) => void;
export interface ReviewRecommendationsProps {
  analytics: LearningAnalytics;
  busy: boolean;
  onStart: ReviewStartAction;
  scopeLabel?: string;
  onViewProgress?: () => void;
}
export function reviewScopeLabel(scope: ReviewScope): string {
  const subject = scope.subjectId
    ? subjectLabels[scope.subjectId]
    : "전체 과목";
  return `${subject} · ${scope.year ? `${scope.year}년` : "전체 시험 연도"} · ${scope.round ? `${scope.round}차` : "전체 회차"}`;
}
export function SampleBadge({ metrics }: { metrics: Metrics }) {
  return metrics.B < MIN_GRADED_QUESTIONS ? (
    <span className="learning-badge learning-sample">표본 부족</span>
  ) : null;
}
/** Older local analytics have no cross-device response-order holds. */
export function orderConflictCount(metrics: Metrics): number {
  return "K" in metrics && typeof metrics.K === "number" ? metrics.K : 0;
}
export function LearningBar({
  metrics,
  label,
}: {
  metrics: Metrics;
  label: string;
}) {
  const value = metrics.N ? (100 * metrics.A) / metrics.N : 0;
  const held = orderConflictCount(metrics);
  const segments: Array<[string, number]> = [
    ["C", metrics.C],
    ["W", metrics.W],
    ["U", metrics.U],
    ["M", metrics.M],
    ["K", held],
  ];
  return (
    <div
      className={`learning-bar${metrics.N ? "" : " learning-bar-empty"}`}
      role="progressbar"
      aria-label={`${label} 풀이율`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number(value.toFixed(1))}
      aria-valuetext={
        metrics.N
          ? `풀이 ${metrics.A}/${metrics.N}문항 · ${formatPercent(metrics.completionRate)}. 정답 ${metrics.C}, 오답 ${metrics.W}, 모르겠음 ${metrics.U}, 미풀이 ${metrics.M}문항${held ? `, 응답 순서 확인 필요 ${held}문항` : ""}`
          : "등록 문항 없음"
      }
    >
      {metrics.N > 0 &&
        segments.map(([key, count]) => (
          <span
            key={key}
            aria-hidden="true"
            className={`learning-segment learning-segment-${key}`}
            style={{ width: `${(100 * count) / metrics.N}%` }}
          />
        ))}
    </div>
  );
}
export function LearningLegend({
  showOrderConflicts = false,
}: {
  showOrderConflicts?: boolean;
}) {
  return (
    <div className="learning-legend" aria-label="풀이 상태 색상 범례">
      <span>
        <i className="learning-dot learning-segment-C" aria-hidden="true" />
        정답
      </span>
      <span>
        <i className="learning-dot learning-segment-W" aria-hidden="true" />
        오답
      </span>
      <span>
        <i className="learning-dot learning-segment-U" aria-hidden="true" />
        모르겠음
      </span>
      <span>
        <i className="learning-dot learning-segment-M" aria-hidden="true" />
        미풀이
      </span>
      {showOrderConflicts && (
        <span>
          <i className="learning-dot learning-segment-K" aria-hidden="true" />
          응답 순서 확인 필요
        </span>
      )}
    </div>
  );
}

export function ReviewRecommendations({
  analytics,
  busy,
  onStart,
  scopeLabel,
  onViewProgress,
}: ReviewRecommendationsProps) {
  const recommendations = analytics.recommendations.slice(
    0,
    MAX_RECOMMENDATIONS,
  );
  const pending = analytics.subjects.filter((subject) => subject.pending.N > 0);
  const pendingUnresolved = pending.reduce(
    (sum, subject) => sum + subject.pending.unresolved,
    0,
  );
  const unansweredUnits = analytics.units
    .filter(
      (unit) =>
        unit.M > 0 &&
        (!analytics.scope.subjectId ||
          unit.subjectId === analytics.scope.subjectId),
    )
    .slice(0, 3);
  const canStudyUnanswered = analytics.overall.M > 0;
  const orderConflicts = orderConflictCount(analytics.overall);
  const start = (unit: UnitStats, kind: "review" | "unanswered") =>
    onStart(unit.subjectId, unit.code, kind, analytics.scope);
  return (
    <section className="review-recommendations" aria-label="복습 단원 추천">
      <div className="learning-section-heading">
        <div>
          <div className="original-eyebrow">YOUR NEXT REVIEW</div>
          <h2>복습 단원 추천</h2>
        </div>
        {onViewProgress && (
          <button className="learning-text-button" onClick={onViewProgress}>
            학습 현황 보기 →
          </button>
        )}
      </div>
      <p className="learning-scope-caption">
        {scopeLabel ?? "조회 범위"} · {reviewScopeLabel(analytics.scope)}
      </p>
      <p className="learning-description">
        현재 등록된 출제 가능한 문항 기준입니다. 최근 확정 응답의
        오답·모르겠음만 복습합니다.
      </p>
      {onViewProgress && recommendations.length > 0 && (
        <LearningLegend showOrderConflicts={orderConflicts > 0} />
      )}
      {orderConflicts > 0 && (
        <aside
          className="learning-order-notice"
          role="status"
          aria-label="응답 순서 확인 안내"
        >
          <strong>응답 순서 확인 필요 {orderConflicts}문항</strong>
          <p>
            두 기기의 응답 중 어떤 기록을 대표로 사용할지 확인해 주세요.
            ‘계정·기기 동기화’에서 실제 응답을 선택하면 현황과 추천이 다시
            계산됩니다.
          </p>
          <p>
            등록 문항 수에는 포함하며, 확인 전에는 정답·오답·모르겠음·미풀이로
            배정하지 않습니다.
          </p>
        </aside>
      )}
      {recommendations.length > 0 ? (
        <div className="review-card-grid">
          {recommendations.map((recommendation, index) => {
            const unit = recommendation.unit;
            const label = `${subjectLabels[unit.subjectId]} ${unit.title}`;
            return (
              <article
                className="review-card"
                key={unit.code}
                data-unit-code={unit.code ?? undefined}
                data-recommendation-rank={index + 1}
                aria-label={`${index + 1}순위 ${label} 복습 추천`}
              >
                <div className="review-card-top">
                  <span className="review-rank">
                    {String(index + 1).padStart(2, "0")}
                    <small>추천</small>
                  </span>
                  <span
                    className={`learning-badge ${recommendation.tier === "priority" ? "learning-priority" : "learning-supplement"}`}
                  >
                    {recommendation.badge}
                  </span>
                </div>
                <div className="review-subject">
                  {subjectLabels[unit.subjectId]}
                  {unit.isTemporary && (
                    <span className="learning-badge">임시 대분류</span>
                  )}
                </div>
                <h3>{unit.title}</h3>
                <div className="review-wrong-rate">
                  <span>오답률</span>
                  <strong>{formatPercent(unit.wrongRate)}</strong>
                  <SampleBadge metrics={unit} />
                </div>
                <p className="review-denominator">
                  오답 {unit.W}/{unit.B} · 모르겠음 {unit.U}문항
                </p>
                <LearningBar metrics={unit} label={label} />
                <p className="review-completion">
                  풀이 {unit.A}/{unit.N}문항{" "}
                  <strong>{formatPercent(unit.completionRate)}</strong>
                </p>
                <div className="review-counts">
                  <span>
                    미해결 <b>{unit.unresolved}</b>문항
                  </span>
                  <span>
                    반복 오답 <b>{unit.repeated}</b>문항
                  </span>
                  {orderConflictCount(unit) > 0 && (
                    <span className="learning-order-text">
                      응답 순서 확인 필요 <b>{orderConflictCount(unit)}</b>문항
                    </span>
                  )}
                </div>
                <p className="review-reason">{recommendation.reason}</p>
                <button
                  className="primary review-start"
                  disabled={busy || recommendation.reviewCount === 0}
                  aria-label={`${label} 이 단원 복습 (${recommendation.reviewCount}문항)`}
                  onClick={() => start(unit, "review")}
                >
                  이 단원 복습 <span>({recommendation.reviewCount}문항)</span> →
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="review-empty" role="status">
          <span className="review-empty-symbol" aria-hidden="true">
            ✓
          </span>
          <div>
            <h3>
              {analytics.overall.unresolved === 0
                ? "현재 복습할 오답·모르겠음 문항이 없습니다."
                : "단원이 확정된 복습 대상이 없습니다."}
            </h3>
            <p>
              {analytics.overall.N === 0
                ? "문제를 등록하면 학습 기록에 맞춰 다음 복습 단원을 확인할 수 있어요."
                : analytics.overall.unresolved > 0
                  ? "분류 대기 문항은 아래에서 과목별로 따로 복습할 수 있습니다."
                  : "미풀이 문항이 있다면 아래에서 다음 학습을 시작해 보세요."}
            </p>
          </div>
        </div>
      )}
      {pendingUnresolved > 0 && (
        <div className="review-pending-guidance">
          <p>
            <strong>분류 대기 미해결 {pendingUnresolved}문항</strong>은 단원
            추천에 포함하지 않습니다.
          </p>
          <div className="learning-inline-actions">
            {pending
              .filter((subject) => subject.pending.unresolved > 0)
              .map((subject) => (
                <button
                  key={subject.subjectId}
                  disabled={busy}
                  onClick={() =>
                    onStart(subject.subjectId, null, "review", analytics.scope)
                  }
                >
                  {subject.title} 분류 대기 복습 (
                  {Math.min(DEFAULT_REVIEW_LIMIT, subject.pending.unresolved)}
                  문항)
                </button>
              ))}
          </div>
        </div>
      )}
      {!recommendations.length && canStudyUnanswered && (
        <div className="review-unanswered-guidance" aria-label="미풀이 학습">
          <div>
            <h3>미풀이 학습</h3>
            <p>
              아직 유효 응답이 없는 {analytics.overall.M}문항이 있습니다. 한
              번에 최대 {DEFAULT_REVIEW_LIMIT}문항씩 시작하세요.
            </p>
          </div>
          <div className="review-unanswered-list">
            {unansweredUnits.map((unit) => (
              <button
                key={unit.code}
                disabled={busy}
                aria-label={`${subjectLabels[unit.subjectId]} ${unit.title} 미풀이 풀기 (${Math.min(DEFAULT_REVIEW_LIMIT, unit.M)}문항)`}
                onClick={() => start(unit, "unanswered")}
              >
                <span>
                  <small>{subjectLabels[unit.subjectId]}</small>
                  {unit.title}
                </span>
                <b>{Math.min(DEFAULT_REVIEW_LIMIT, unit.M)}문항 →</b>
              </button>
            ))}
            {pending
              .filter((subject) => subject.pending.M > 0)
              .map((subject) => (
                <button
                  key={`pending-${subject.subjectId}`}
                  disabled={busy}
                  onClick={() =>
                    onStart(
                      subject.subjectId,
                      null,
                      "unanswered",
                      analytics.scope,
                    )
                  }
                >
                  <span>
                    <small>{subject.title}</small>분류 대기 미풀이
                  </span>
                  <b>
                    {Math.min(DEFAULT_REVIEW_LIMIT, subject.pending.M)}문항 →
                  </b>
                </button>
              ))}
          </div>
          {onViewProgress && (
            <button className="learning-text-button" onClick={onViewProgress}>
              전체 미풀이 단원 확인 →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
