import {
  answer,
  expire,
  finish,
  move,
  type OriginalState,
  type Response,
} from "./engine";

type Timed = { at: number };
export type LearningCommand = Timed &
  (
    | { kind: "answer"; sessionId: string; response: Response }
    | { kind: "move"; sessionId: string; index: number }
    | { kind: "finish"; sessionId: string }
    | { kind: "expire" }
    | { kind: "mark"; sessionId: string; questionId: string }
    | { kind: "review"; sessionId: string; questionId: string }
    | { kind: "font"; scale: number }
  );

/** Internal learning operations own only mutable learning fields. Large banks,
 * assets and question snapshots stay read-only; data management uses the full
 * clone/validation path instead. No command accepts question/bank replacement. */
export function applyLearningCommand(
  original: OriginalState,
  command: LearningCommand,
): OriginalState {
  if (!Number.isFinite(command.at))
    throw Error("학습 시각이 올바르지 않습니다.");
  const target = "sessionId" in command ? command.sessionId : null;
  const draft: OriginalState = {
    ...original,
    attempts: [...original.attempts],
    marks: { ...original.marks },
    settings: { ...original.settings },
    sessions: original.sessions.map((session) =>
      session.status === "active" || session.id === target
        ? {
            ...session,
            responses: { ...session.responses },
            review: { ...session.review },
          }
        : session,
    ),
  };
  switch (command.kind) {
    case "answer":
      answer(draft, command.sessionId, command.response, command.at);
      break;
    case "move":
      move(draft, command.sessionId, command.index, command.at);
      break;
    case "finish":
      finish(draft, command.sessionId, command.at);
      break;
    case "expire":
      expire(draft, command.at);
      break;
    case "mark":
    case "review": {
      const session = draft.sessions.find((s) => s.id === command.sessionId);
      if (
        !session ||
        !session.questions.some((q) => q.id === command.questionId)
      )
        throw Error("풀이 문항을 찾을 수 없습니다.");
      if (session.mode === "exam" && expire(draft, command.at)) break;
      if (command.kind === "review" && session.status !== "active") break;
      if (
        command.kind === "mark" &&
        session.mode === "exam" &&
        session.status !== "active"
      )
        break;
      if (command.kind === "mark")
        draft.marks[command.questionId] = !draft.marks[command.questionId];
      else
        session.review[command.questionId] =
          !session.review[command.questionId];
      break;
    }
    case "font":
      if (
        !Number.isFinite(command.scale) ||
        command.scale < 1 ||
        command.scale > 2
      )
        throw Error("글씨 크기가 올바르지 않습니다.");
      draft.settings.fontScale = command.scale;
      break;
    default:
      throw Error("지원하지 않는 학습 변경입니다.");
  }
  return draft;
}
