import type { Attempt, Basis, Dataset, Session, State } from "../domain/schema";
export type {
  AttemptOrder,
  ClockSample,
  EventBase,
  WireEvent,
} from "../original/sync/types";
import type {
  AttemptOrder,
  ClockSample,
  EventBase,
} from "../original/sync/types";
export interface BankPayload {
  baseVersion: number;
  dataset: Dataset;
  itemTombstones: string[];
  restoredItemIds: string[];
}
export interface SessionPayload {
  session: Session;
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
export type SyncEvent = EventBase &
  (
    | { kind: "bank"; payload: BankPayload }
    | { kind: "session"; payload: SessionPayload }
    | { kind: "mark"; payload: MarkPayload }
    | { kind: "resolution"; payload: ResolutionPayload }
  );
export interface ReceivedEvent {
  event: SyncEvent;
  seq: number;
  bankVersion: number;
  markVersion?: number;
}
export interface Conflict {
  kind: "bank" | "record" | "order" | "mark";
  id: string;
  reason: string;
  itemId?: string;
  basis?: Basis;
  attemptIds?: string[];
  event?: SyncEvent;
}
export interface Projection {
  bankVersion: number;
  seenEvents: Record<string, number>;
  fingerprints: Record<string, string>;
  order: Record<string, AttemptOrder>;
  representatives: Record<string, string>;
  resolutions: Record<string, ResolutionPayload & { serverSequence: number }>;
  conflicts: Conflict[];
  responseConflicts: Conflict[];
  deferred: ReceivedEvent[];
  markVersions: Record<string, number>;
  itemTombstones: string[];
}
export interface Context {
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
  state: State;
  projection: Projection;
}
export interface Metadata {
  revision: number;
  deviceId: string;
  nextSequence: number;
  cursor: number;
  projection: Projection;
  outbox: SyncEvent[];
  failures: Record<string, string>;
  lastSuccess: string | null;
  clock: ClockSample | null;
}
export interface Snapshot {
  generation: number;
  state: State;
  meta: Metadata;
}
export interface MigrationPreview {
  state: State;
  source?: unknown;
  items: number;
  sessions: number;
  attempts: number;
  conflicts: number;
}
