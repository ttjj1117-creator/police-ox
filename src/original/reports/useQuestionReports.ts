import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../domain/schema";
import type { QuestionReport } from "./repository";
import { QuestionReportRepository } from "./repository";

const repository = new QuestionReportRepository();
const channelName = "police-original-question-reports";

interface ReportList {
  scope: string;
  reports: QuestionReport[];
  error: string;
}

export function useQuestionReports(scope: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<ReportList | null>(null);
  const subscription = useRef<{
    scope: string;
    refresh: () => Promise<void>;
    channel: BroadcastChannel | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let request = 0;
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(channelName);
    async function refresh() {
      const current = ++request;
      try {
        const reports = await repository.list(scope);
        if (active && current === request)
          setLoaded({ scope, reports, error: "" });
      } catch (error) {
        if (active && current === request)
          setLoaded((prior) => ({
            scope,
            reports: prior?.scope === scope ? prior.reports : [],
            error: errorMessage(error),
          }));
      }
    }
    subscription.current = { scope, refresh, channel };
    const onMessage = (event: MessageEvent<string>) => {
      if (event.data === scope) void refresh();
    };
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    channel?.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      active = false;
      subscription.current = null;
      channel?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [scope, enabled]);
  const current = enabled && loaded?.scope === scope ? loaded : null;
  return {
    reports: current?.reports ?? [],
    loading: !current,
    error: current?.error ?? "",
    reload: () => {
      if (subscription.current?.scope === scope)
        void subscription.current.refresh();
    },
    async change(
      previous: QuestionReport | undefined,
      next: QuestionReport | null,
    ) {
      const questionId = next?.questionId ?? previous?.questionId;
      if (!questionId || !enabled) return;
      try {
        await repository.change(scope, questionId, previous?.changeId, next);
        // Announce only after the IndexedDB transaction commits.
        const active = subscription.current;
        if (active?.scope === scope) {
          try {
            active.channel?.postMessage(scope);
          } catch {
            // Visibility refresh still picks up the durable change.
          }
        }
      } finally {
        const active = subscription.current;
        if (active?.scope === scope) await active.refresh();
      }
    },
  };
}
