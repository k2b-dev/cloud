/**
 * The browser half of the shared workstation. The server holds the session's last real input and ends it after the
 * administrator's idle limit; this module only reports real input, warns a minute before the end and leaves the page
 * in time for the apps to save on `pagehide` while the session still holds.
 *
 * Only trusted typing, clicking, scrolling and touching count. Requests, live updates, polling and prefetch never call
 * the activity route, so they never extend the session. Tabs of one browser share the server's single idle clock and
 * tell each other about new deadlines and the sign-out over a `BroadcastChannel`.
 */

/** A browser session with an idle limit, as the server reports it. */
export type IdleState = { remainingSeconds: number; timeoutSeconds: number };

/** The warning opens this long before the session ends. */
export const IDLE_WARNING_SECONDS = 60;
/** The page leaves this long before the server ends the session, so the apps' `pagehide` saves still authenticate. */
export const IDLE_LEAVE_MARGIN_SECONDS = 10;
/** Real input reaches the server at most this often, unless the end is near. */
export const INPUT_REPORT_INTERVAL_MS = 20_000;
/** A held-back report that fires later than this after its input is dropped. */
const STALE_REPORT_GRACE_MS = 5_000;
/** The sign-in page reads this once to finish the sign-out: revoke the session and clear the account's browser data. */
export const IDLE_SIGN_OUT_STORAGE_KEY = "cloud.idle-sign-out";
/** Window event the profile menu's switch dispatches after the server changed the mark. */
export const SHARED_WORKSTATION_EVENT = "cloud:shared-workstation";
export type SharedWorkstationEventDetail = { userId: string; idle: IdleState | null };

const CHANNEL_NAME = "cloud.shared-workstation";
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** `null`: the session has ended; `"unlimited"`: it has no idle limit any more; `"unavailable"`: the server could not be asked. */
type ServerAnswer = IdleState | null | "unlimited" | "unavailable";

/** Tabs talk about one session family (`sid`): a newer sign-in of the same account in this browser is another session. */
type ChannelMessage =
  | { type: "deadline"; sid: string; deadline: number; timeoutSeconds: number }
  | { type: "leave"; sid: string }
  | { type: "unmarked"; sid: string };

type Channel = { postMessage(message: ChannelMessage): void };

export type IdleWarning = {
  /** Seconds until the page leaves, for the countdown. */
  secondsLeft: () => number;
  /** "Weiterarbeiten" pressed by a person: counts as real input. */
  onContinue: () => void;
  /** Leave now instead of waiting. */
  onSignOut: () => void;
  /** Closed without a decision; it opens again while the end is near. */
  onClosed: () => void;
};

export type IdleSignOutDeps = {
  /** The session family this tab belongs to. */
  sid: string;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** Records real input; the only call that extends the session. */
  report: () => Promise<ServerAnswer>;
  /** Reads the session's state without extending it. */
  read: () => Promise<ServerAnswer>;
  /** Shows the warning, or closes it with `null`. */
  warn: (warning: IdleWarning | null) => void;
  /** Hides the page and opens the sign-in page. */
  leave: () => void;
  channel?: Channel;
};

export type IdleSignOut = {
  /** A trusted input event in this tab. */
  input: () => void;
  /** Re-evaluates after sleep, a restore from the back-forward cache or a visibility change. */
  wake: () => void;
  /** A message from another tab. */
  receive: (message: ChannelMessage) => void;
  stop: () => void;
  deadline: () => number;
};

/** The watcher without browser globals; `installSharedWorkstation` wires it to the page. */
export const createIdleSignOut = (initial: IdleState, deps: IdleSignOutDeps): IdleSignOut => {
  let deadline = deps.now() + initial.remainingSeconds * 1_000;
  let timeoutSeconds = initial.timeoutSeconds;
  let timer: unknown;
  let trailing: unknown;
  let lastReport = Number.NEGATIVE_INFINITY;
  let lastInput = Number.NEGATIVE_INFINITY;
  let reporting = false;
  let reportAgain = false;
  let warningOpen = false;
  let checkedDeadline: number | null = null;
  let checking = false;
  let stopped = false;
  let left = false;

  const warnAt = () => deadline - IDLE_WARNING_SECONDS * 1_000;
  const leaveAt = () => deadline - IDLE_LEAVE_MARGIN_SECONDS * 1_000;

  const closeWarning = () => {
    if (!warningOpen) return;
    warningOpen = false;
    deps.warn(null);
  };

  const leave = (announce: boolean) => {
    if (left || stopped) return;
    left = true;
    deps.clearTimer(timer);
    deps.clearTimer(trailing);
    closeWarning();
    if (announce) deps.channel?.postMessage({ type: "leave", sid: deps.sid });
    deps.leave();
  };

  const moveDeadline = (next: number, announce: boolean) => {
    deadline = next;
    if (announce) deps.channel?.postMessage({ type: "deadline", sid: deps.sid, deadline, timeoutSeconds });
    schedule();
  };

  /** Narrows to a usable answer; otherwise acts on it: the session ended, lost its limit, or the server was out of reach. */
  const usable = (answer: ServerAnswer): answer is IdleState => {
    // The server already ended the session: nothing can be saved any more, so leave at once.
    if (answer === null) leave(true);
    // Another tab unmarked the browser where no channel told this one.
    else if (answer === "unlimited") stop();
    return answer !== null && answer !== "unlimited" && answer !== "unavailable";
  };

  const report = async () => {
    if (stopped || left) return;
    if (reporting) {
      reportAgain = true;
      return;
    }
    reporting = true;
    lastReport = deps.now();
    const answer = await deps.report().catch((): ServerAnswer => "unavailable");
    reporting = false;
    if (stopped || left) return;
    if (usable(answer)) {
      timeoutSeconds = answer.timeoutSeconds;
      moveDeadline(deps.now() + answer.remainingSeconds * 1_000, true);
    }
    if (stopped || left) return;
    if (reportAgain) {
      reportAgain = false;
      void report();
    }
    schedule();
  };

  const showWarning = () => {
    if (warningOpen || stopped || left) return;
    warningOpen = true;
    deps.warn({
      secondsLeft: () => Math.max(0, Math.ceil((leaveAt() - deps.now()) / 1_000)),
      onContinue: () => {
        closeWarning();
        void report();
      },
      onSignOut: () => leave(true),
      onClosed: () => {
        warningOpen = false;
      },
    });
  };

  // Before warning, ask the server without extending: input in a tab that could not tell this one moved the deadline.
  const checkThenWarn = async () => {
    if (checking) return;
    checking = true;
    checkedDeadline = deadline;
    const answer = await deps.read().catch((): ServerAnswer => "unavailable");
    checking = false;
    if (stopped || left) return;
    if (usable(answer)) {
      timeoutSeconds = answer.timeoutSeconds;
      // The server's clock is the truth, also when an administrator shortened the limit meanwhile.
      deadline = deps.now() + answer.remainingSeconds * 1_000;
      checkedDeadline = deadline;
    }
    if (deps.now() >= warnAt()) showWarning();
    schedule();
  };

  function schedule() {
    deps.clearTimer(timer);
    if (stopped || left) return;
    const now = deps.now();
    if (now >= leaveAt()) return leave(true);
    if (now < warnAt()) {
      closeWarning();
      timer = deps.setTimer(schedule, warnAt() - now);
      return;
    }
    if (!warningOpen && !reporting) {
      if (checkedDeadline !== deadline) void checkThenWarn();
      else showWarning();
    }
    // Ticks each second during the warning: the countdown, and a machine waking from sleep, see the time at once.
    timer = deps.setTimer(schedule, Math.min(1_000, leaveAt() - now));
  }

  const input = () => {
    if (stopped || left) return;
    const now = deps.now();
    lastInput = now;
    // Near the end every input goes out at once; otherwise once per interval, with the last input sent at its end.
    if (warningOpen || now >= warnAt() - INPUT_REPORT_INTERVAL_MS || now - lastReport >= INPUT_REPORT_INTERVAL_MS) {
      deps.clearTimer(trailing);
      trailing = undefined;
      closeWarning();
      void report();
      return;
    }
    if (trailing === undefined)
      trailing = deps.setTimer(
        () => {
          trailing = undefined;
          // A report held back by a sleeping machine or a frozen tab would pass old input off as new.
          if (deps.now() - lastInput > INPUT_REPORT_INTERVAL_MS + STALE_REPORT_GRACE_MS) return;
          void report();
        },
        lastReport + INPUT_REPORT_INTERVAL_MS - now,
      );
  };

  const receive = (message: ChannelMessage) => {
    if (message.sid !== deps.sid || stopped) return;
    if (message.type === "leave") return leave(false);
    if (message.type === "unmarked") return stop();
    if (message.type === "deadline" && message.deadline > deadline) {
      timeoutSeconds = message.timeoutSeconds;
      moveDeadline(message.deadline, false);
    }
  };

  function stop() {
    stopped = true;
    deps.clearTimer(timer);
    deps.clearTimer(trailing);
    closeWarning();
  }

  schedule();
  return {
    input,
    wake: () => (left ? deps.leave() : schedule()),
    receive,
    stop,
    deadline: () => deadline,
  };
};

const answerOf = async (response: Response): Promise<ServerAnswer> => {
  if (response.status === 401) return null;
  if (!response.ok) return "unavailable";
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !("idle" in body)) return "unavailable";
  const idle = body.idle;
  if (idle === null) return "unlimited";
  if (
    !idle ||
    typeof idle !== "object" ||
    !("remainingSeconds" in idle) ||
    !("timeoutSeconds" in idle) ||
    typeof idle.remainingSeconds !== "number" ||
    typeof idle.timeoutSeconds !== "number"
  )
    return "unavailable";
  return { remainingSeconds: idle.remainingSeconds, timeoutSeconds: idle.timeoutSeconds };
};

const ask = (method: "GET" | "POST", path: string) => () =>
  fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json" } }).then(
    answerOf,
    (): ServerAnswer => "unavailable",
  );

/** What the sign-in page needs to end exactly the session this tab left, and to clear its account's data. */
export type IdleSignOutRecord = { userId: string; sid: string };

/** Hides the page at once, so nobody reads it while the browser leaves, and opens the sign-in page. */
const leavePage = (record: IdleSignOutRecord) => {
  try {
    window.sessionStorage.setItem(IDLE_SIGN_OUT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The server still ends the session; only the browser data cleanup on the sign-in page is skipped.
  }
  document.body.style.setProperty("display", "none", "important");
  window.location.replace("/auth/login?signedOut=idle");
};

/**
 * Watches a signed-in browser session. With `idle` the browser is a shared workstation and the watcher runs; the
 * profile menu's switch and other tabs start and stop it. `warn` renders the warning.
 */
export const installSharedWorkstation = (
  session: { userId: string; sid: string; idle?: IdleState },
  warn: (warning: IdleWarning | null) => void,
): (() => void) => {
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
  let watcher: IdleSignOut | null = null;

  const onInput = (event: Event) => {
    if (!event.isTrusted) return;
    // The warning's own buttons decide themselves; pressing "Abmelden" is no sign of working on.
    if (event.target instanceof Element && event.target.closest("[data-cloud-idle-warning]")) return;
    watcher?.input();
  };
  const onWake = () => watcher?.wake();

  const start = (idle: IdleState) => {
    watcher?.stop();
    watcher = createIdleSignOut(idle, {
      sid: session.sid,
      now: Date.now,
      setTimer: (run, ms) => window.setTimeout(run, Math.max(0, ms)),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      report: ask("POST", "/api/me/browser/activity"),
      read: ask("GET", "/api/me/browser"),
      warn,
      leave: () => leavePage({ userId: session.userId, sid: session.sid }),
      ...(channel ? { channel } : {}),
    });
  };
  const stop = () => {
    watcher?.stop();
    watcher = null;
  };

  const onMessage = (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    if (!message || message.sid !== session.sid) return;
    // A tab opened before another tab marked the browser starts watching now.
    if (message.type === "deadline" && !watcher)
      start({ remainingSeconds: Math.max(0, (message.deadline - Date.now()) / 1_000), timeoutSeconds: message.timeoutSeconds });
    else if (message.type === "unmarked") stop();
    else watcher?.receive(message);
  };
  const onToggle = (event: Event) => {
    const detail = (event as CustomEvent<SharedWorkstationEventDetail>).detail;
    if (!detail || detail.userId !== session.userId) return;
    if (detail.idle) {
      start(detail.idle);
      if (watcher)
        channel?.postMessage({
          type: "deadline",
          sid: session.sid,
          deadline: watcher.deadline(),
          timeoutSeconds: detail.idle.timeoutSeconds,
        });
    } else {
      stop();
      channel?.postMessage({ type: "unmarked", sid: session.sid });
    }
  };

  if (session.idle) start(session.idle);
  for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("pageshow", onWake);
  window.addEventListener("focus", onWake);
  window.addEventListener(SHARED_WORKSTATION_EVENT, onToggle);
  channel?.addEventListener("message", onMessage);
  return () => {
    stop();
    for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("pageshow", onWake);
    window.removeEventListener("focus", onWake);
    window.removeEventListener(SHARED_WORKSTATION_EVENT, onToggle);
    channel?.removeEventListener("message", onMessage);
    channel?.close();
  };
};
