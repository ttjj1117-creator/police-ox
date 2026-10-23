import type { Attempt, OriginalSession, OriginalState } from "../engine";
import type { OriginalData } from "../model";

export interface ClockSample {
  offsetMs: number;
  uncertaintyMs: number;
  sampledAt?: string;
  runtimeId?: string;
  monotonicMs?: number;
}
export interface AttemptOrder {
  deviceId: string;
  deviceSequence: number;
  baseCursor: number;
  clock: ClockSample | null;
  serverSequence?: number;
}
export interface BankPayload {
  baseVersion: number;
  data: OriginalData;
  removedQuestionIds: string[];
  questionTombstones: string[];
  packageTombstones: string[];
  restoredQuestionIds: string[];
  restoredPackageIds: string[];
}
export interface SessionPayload {
  session: OriginalSession;
  attempts: Attempt[];
  order: Record<string, AttemptOrder>;
}
export interface MarkPayload {
  questionId: string;
  value: boolean;
  baseMarkVersion: number;
}
export interface ResolutionPayload {
  questionId: string;
  gradingRevision: number;
  attemptId: string;
  candidateAttemptIds: string[];
}
export interface EventBase {
  protocolVersion: 1;
  eventId: string;
  deviceId: string;
  deviceSequence: number;
  baseCursor: number;
  createdAt: string;
}
export type SyncEvent = EventBase &
  (
    | { kind: "bank"; payload: BankPayload }
    | { kind: "session"; payload: SessionPayload }
    | { kind: "mark"; payload: MarkPayload }
    | { kind: "resolution"; payload: ResolutionPayload }
  );
/** The body manifest and assets are immutable private Storage objects. */
export interface WireEvent extends EventBase {
  kind: SyncEvent["kind"];
  bodyPath: string;
  bodySha256: string;
  bodyBytes: number;
  baseVersion: number | null;
  markQuestionId: string | null;
  baseMarkVersion: number | null;
}
export interface ReceivedEvent {
  seq: number;
  bankVersion: number;
  event: SyncEvent;
  markVersion?: number;
}
export interface ResponseConflict {
  questionId: string;
  gradingRevision: number;
  attemptIds: string[];
}
export interface ProtocolConflict {
  eventId: string;
  kind: "bank" | "session" | "mark" | "resolution";
  reason: string;
  event?: SyncEvent;
}
export interface StoredResolution extends ResolutionPayload {
  serverSequence: number;
  eventId: string;
}
export interface SyncProjection {
  bankVersion: number;
  seenEvents: Record<string, number>;
  order: Record<string, AttemptOrder>;
  resolutions: Record<string, StoredResolution>;
  responseConflicts: ResponseConflict[];
  bankConflicts: ProtocolConflict[];
  recordConflicts: ProtocolConflict[];
  deferred: ReceivedEvent[];
  markVersions: Record<string, number>;
  questionTombstones: string[];
  packageTombstones: string[];
}
export interface BuildContext {
  deviceId: string;
  nextSequence: number;
  baseCursor: number;
  bankVersion: number;
  clock?: ClockSample | null;
  order?: Record<string, AttemptOrder>;
  markVersions?: Record<string, number>;
  pendingEvents?: SyncEvent[];
}
export interface BuildResult {
  events: SyncEvent[];
  nextSequence: number;
  order: Record<string, AttemptOrder>;
}
export interface ApplyResult {
  state: OriginalState;
  projection: SyncProjection;
}
