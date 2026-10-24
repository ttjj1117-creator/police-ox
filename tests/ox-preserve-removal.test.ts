import { describe, expect, it } from "vitest";
import { initialState } from "../src/fixtures/data";
import { defaultSelection, canonical } from "../src/domain/schema";
import { startSession, submit, next, markKey } from "../src/domain/engine";
import { removeItems } from "../src/data/remove-items";
import { backup, validateBackup } from "../src/data/transfer";
import { buildEvents } from "../src/ox-sync/protocol";

describe("OX 계정 문제 제거 시 학습 기록 보존", () => {
  it.each([false, true])(
    "전체 제거 %s: 종료 스냅샷·ID·시각과 순회 참조를 보존하고 문제은행 변경만 전송한다",
    (all) => {
      const state = initialState(true);
      startSession(state, defaultSelection);
      const session = state.sessions[0];
      submit(state, session.id, "unknown");
      next(state, session.id);
      session.status = "ended";
      state.marks[markKey(session.items[0].id, "current")] = true;
      const original = canonical(state);
      const ids = new Set(
        all ? state.dataset.items.map((v) => v.id) : [session.items[0].id],
      );
      const result = removeItems(state, ids, { preserveLearningRecords: true });
      expect(canonical(state)).toBe(original);
      expect(result.state.attempts).toEqual(state.attempts);
      expect(result.state.sessions).toEqual(state.sessions);
      expect(result.state.dataset.items).toHaveLength(
        state.dataset.items.length - ids.size,
      );
      expect(result.state.marks).toEqual({});
      expect(result.counts).toMatchObject({
        items: ids.size,
        attempts: 0,
        sessions: 0,
        sessionsPruned: 0,
        snapshots: 0,
      });
      expect(result.state.cycles[session.cycleKey!]).toBeDefined();
      expect(() =>
        validateBackup(backup(result.state, "real"), "real"),
      ).not.toThrow();
      const built = buildEvents(state, result.state, {
        deviceId: "TEST_ONLY",
        nextSequence: 1,
        baseCursor: 0,
        bankVersion: 0,
      });
      expect(built.events).toHaveLength(1);
      expect(built.events[0].kind).toBe("bank");
    },
  );
});
