/**
 * A speech-to-text stream as dictation consumes it. The library knows no server: an application passes a source, such
 * as one that relays the microphone to a speech model, and a target that places the text.
 */
export type DictationErrorCode =
  | "not_configured"
  | "no_access"
  | "daily_limit"
  | "overloaded"
  | "busy_elsewhere"
  | "provider_failed"
  | "connection_lost"
  | "microphone_blocked"
  | "microphone_unavailable";

export type DictationDevice = { id: string; label: string };

/** Why a session ended on its own; the text so far stays. */
export type DictationEndReason = "max_duration" | "silence" | "daily_limit";

export type DictationEvent =
  | { type: "state"; state: "connecting" }
  | { type: "state"; state: "live"; maxMs: number; device?: DictationDevice }
  | { type: "state"; state: "finishing" }
  | { type: "state"; state: "finished"; reason?: DictationEndReason }
  /** 0 to 1, about every 100 ms while live. */
  | { type: "level"; level: number }
  /** New text to append at the dictation mark; earlier text is never revised. */
  | { type: "text"; text: string }
  | { type: "error"; code: DictationErrorCode; retryable: boolean; resetsAt?: string };

export type DictationSession = {
  /** Ends after `finished` or `error`, or without further events once the start signal aborted. */
  events: AsyncIterable<DictationEvent>;
  /** Regular stop: resolves after `finished` or an error, so the last words arrive before it. */
  stop(): Promise<void>;
};

export type DictationSource = {
  /** Aborting `signal` closes the microphone and the connection at once, for discarding or leaving the page. */
  start(options: { deviceId?: string; signal: AbortSignal }): DictationSession;
  /** Microphones with their names; names may be empty before the first permission. */
  devices(): Promise<DictationDevice[]>;
};

/**
 * Where dictated text lands. `begin` starts each session: the first one remembers the insertion point, later ones of
 * the same dictation write on at it. `insert` appends at the mark, `discard` removes exactly the inserted text, and
 * `end` closes the dictation; the text stays.
 */
export type DictationTarget = {
  begin(): void;
  insert(text: string): void;
  discard(): void;
  end(): void;
};

/** A second way out when live dictation is busy, such as recording instead, with what it changes. */
export type DictationAlternative = { label: string; note: string; run: () => void };
