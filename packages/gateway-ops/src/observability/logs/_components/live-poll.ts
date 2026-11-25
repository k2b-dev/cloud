/** The wait before the next live refresh: the interval, doubled after each failure in a row, at most `maxDelay`. */
export const liveDelay = (failures: number, interval: number, maxDelay: number): number => Math.min(maxDelay, interval * 2 ** failures);

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

export type LivePollOptions = {
  /** Between refreshes that worked. */
  interval: number;
  /** The longest wait after failures. */
  maxDelay: number;
  /** Whether a refresh may run now: live is on, the page is visible and online. Otherwise the poll waits. */
  ready: () => boolean;
  /** One refresh; `true` when the list loaded. Never runs twice at once. */
  poll: () => Promise<boolean>;
  timers?: Timers;
};

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Refreshes a live list one request at a time: the next refresh is planned only after the running one answered, so a
 * slow answer still lands. Failures back off; a paused poll (hidden, offline, live off) asks nothing until it is ready
 * again, and `wake` resumes it at once.
 */
export const startLivePoll = (options: LivePollOptions): { stop: () => void; wake: () => void } => {
  const timers = options.timers ?? browserTimers;
  let handle: unknown;
  let failures = 0;
  let running = false;
  let stopped = false;
  const plan = (ms: number) => {
    timers.clear(handle);
    handle = timers.set(tick, ms);
  };
  const tick = async () => {
    handle = undefined;
    if (stopped) return;
    if (!options.ready()) return plan(options.interval);
    running = true;
    const ok = await options.poll().catch(() => false);
    running = false;
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    plan(liveDelay(failures, options.interval, options.maxDelay));
  };
  plan(options.interval);
  return {
    stop: () => {
      stopped = true;
      timers.clear(handle);
      handle = undefined;
    },
    wake: () => {
      if (!stopped && !running) plan(0);
    },
  };
};
