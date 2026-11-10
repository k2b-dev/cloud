import { describe, expect, test } from "bun:test";
import {
  createIdleSignOut,
  IDLE_LEAVE_MARGIN_SECONDS,
  IDLE_WARNING_SECONDS,
  type IdleSignOutDeps,
  type IdleState,
  type IdleWarning,
  INPUT_REPORT_INTERVAL_MS,
} from "./idle-sign-out";

const TIMEOUT = 600;

/** A frozen clock with timers that run only when the test advances it. */
const createHarness = (options: { report?: () => IdleState | null | "unavailable"; read?: () => IdleState | null } = {}) => {
  let now = Date.UTC(2026, 10, 10, 9, 0, 0);
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const log = { reports: 0, reads: 0, left: 0, warnings: [] as Array<IdleWarning | null>, sent: [] as unknown[] };
  // The server's single clock: input resets it to the full limit.
  let serverLastInput = now;
  const serverState = (): IdleState => ({
    remainingSeconds: Math.max(0, TIMEOUT - (now - serverLastInput) / 1_000),
    timeoutSeconds: TIMEOUT,
  });
  const deps = (userId = "user-1"): IdleSignOutDeps => ({
    userId,
    now: () => now,
    setTimer: (run, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, ms), run });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    report: async () => {
      log.reports++;
      if (options.report) return options.report();
      serverLastInput = now;
      return serverState();
    },
    read: async () => {
      log.reads++;
      return options.read ? options.read() : serverState();
    },
    warn: (warning) => log.warnings.push(warning),
    leave: () => log.left++,
    channel: { postMessage: (message) => log.sent.push(message) },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
      await flush();
    }
    now = target;
    await flush();
  };
  /** The machine slept: no timer fired, the clock jumped. */
  const sleep = (ms: number) => {
    now += ms;
  };
  const otherTabInput = () => {
    serverLastInput = now;
  };
  const warning = () => log.warnings.at(-1) ?? null;
  return { deps, advance, sleep, log, warning, flush, otherTabInput, serverState, now: () => now };
};

const fresh = (): IdleState => ({ remainingSeconds: TIMEOUT, timeoutSeconds: TIMEOUT });
const warnAfterMs = (TIMEOUT - IDLE_WARNING_SECONDS) * 1_000;
const leaveAfterMs = (TIMEOUT - IDLE_LEAVE_MARGIN_SECONDS) * 1_000;

describe("shared workstation idle sign-out", () => {
  test("without input it warns a minute before the end and leaves before the server ends the session", async () => {
    const h = createHarness();
    createIdleSignOut(fresh(), h.deps());
    await h.advance(warnAfterMs - 1);
    expect(h.warning()).toBeNull();
    await h.advance(1);
    // The watcher asks the server first, without extending the session.
    expect(h.log.reads).toBe(1);
    expect(h.log.reports).toBe(0);
    expect(h.warning()?.secondsLeft()).toBe(IDLE_WARNING_SECONDS - IDLE_LEAVE_MARGIN_SECONDS);
    await h.advance(leaveAfterMs - warnAfterMs - 1);
    expect(h.log.left).toBe(0);
    await h.advance(1);
    expect(h.log.left).toBe(1);
    expect(h.log.sent).toContainEqual({ type: "leave", userId: "user-1" });
    expect(h.log.reports).toBe(0);
  });

  test("real input reaches the server at most once per interval, with the last input at its end", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    watcher.input();
    await h.flush();
    expect(h.log.reports).toBe(1);
    for (let index = 0; index < 10; index++) {
      await h.advance(1_000);
      watcher.input();
    }
    expect(h.log.reports).toBe(1);
    await h.advance(INPUT_REPORT_INTERVAL_MS);
    expect(h.log.reports).toBe(2);
    // The deadline follows the server's answer and is shared with the other tabs.
    // The trailing report left at the interval's end, 10 s before the clock now.
    expect(watcher.deadline()).toBe(h.now() - 10_000 + TIMEOUT * 1_000);
    expect(h.log.sent.filter((message) => (message as { type: string }).type === "deadline")).toHaveLength(2);
  });

  test("input keeps the session going past the limit", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    for (let minute = 0; minute < 30; minute++) {
      await h.advance(60_000);
      watcher.input();
      await h.flush();
    }
    expect(h.log.left).toBe(0);
    expect(h.log.warnings.filter(Boolean)).toHaveLength(0);
  });

  test("Weiterarbeiten in the warning extends the session and closes it", async () => {
    const h = createHarness();
    createIdleSignOut(fresh(), h.deps());
    await h.advance(warnAfterMs);
    const warning = h.warning();
    if (!warning) throw new Error("Missing warning");
    warning.onContinue();
    await h.flush();
    expect(h.log.reports).toBe(1);
    expect(h.warning()).toBeNull();
    await h.advance(warnAfterMs - 1);
    expect(h.warning()).toBeNull();
    expect(h.log.left).toBe(0);
  });

  test("Abmelden in the warning leaves at once", async () => {
    const h = createHarness();
    createIdleSignOut(fresh(), h.deps());
    await h.advance(warnAfterMs);
    h.warning()?.onSignOut();
    expect(h.log.left).toBe(1);
    expect(h.log.reports).toBe(0);
  });

  test("input in another tab moves this tab's deadline, by message or by the check before the warning", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    await h.advance(120_000);
    watcher.receive({ type: "deadline", userId: "user-1", deadline: h.now() + TIMEOUT * 1_000, timeoutSeconds: TIMEOUT });
    await h.advance(warnAfterMs - 1);
    expect(h.warning()).toBeNull();

    // Without a message: the read before the warning sees the other tab's input and postpones it.
    const quiet = createHarness();
    createIdleSignOut(fresh(), quiet.deps());
    await quiet.advance(warnAfterMs - 5_000);
    quiet.otherTabInput();
    await quiet.advance(5_000);
    expect(quiet.log.reads).toBe(1);
    expect(quiet.warning()).toBeNull();
    expect(quiet.log.left).toBe(0);
  });

  test("a sign-out in one tab takes every tab of the account along, and only that account", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    watcher.receive({ type: "leave", userId: "someone-else" });
    expect(h.log.left).toBe(0);
    watcher.receive({ type: "leave", userId: "user-1" });
    expect(h.log.left).toBe(1);
    // The follower does not announce again.
    expect(h.log.sent).not.toContainEqual({ type: "leave", userId: "user-1" });
  });

  test("after sleep past the end it leaves on wake without waiting for a timer", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    h.sleep(TIMEOUT * 1_000 + 60_000);
    watcher.wake();
    expect(h.log.left).toBe(1);
  });

  test("a session the server already ended leaves at once; a lost connection keeps the warning", async () => {
    const ended = createHarness({ report: () => null });
    const watcher = createIdleSignOut(fresh(), ended.deps());
    watcher.input();
    await ended.flush();
    expect(ended.log.left).toBe(1);

    const offline = createHarness({ report: () => "unavailable" });
    createIdleSignOut(fresh(), offline.deps());
    await offline.advance(warnAfterMs);
    offline.warning()?.onContinue();
    await offline.advance(1_000);
    expect(offline.warning()).not.toBeNull();
    await offline.advance(leaveAfterMs - warnAfterMs);
    expect(offline.log.left).toBe(1);
  });

  test("unmarking in another tab stops the watcher", async () => {
    const h = createHarness();
    const watcher = createIdleSignOut(fresh(), h.deps());
    watcher.receive({ type: "unmarked", userId: "user-1" });
    await h.advance(TIMEOUT * 2_000);
    expect(h.log.left).toBe(0);
    expect(h.log.reads).toBe(0);
  });
});
