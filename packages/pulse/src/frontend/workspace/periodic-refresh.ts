import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

const INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Status changes while the page stays open: source status (newest data, throttling, errors) while the sources
 * view is visible, and a base's lifecycle operation while its settings are open. Refresh every 5 s while
 * `active`; skip hidden tabs and back off after failures, up to one minute. A failed refresh keeps the last data;
 * `failed` stays true until a refresh succeeds or `active` ends, so the caller shows it in place, and `retry` runs
 * the next refresh at once. At most one refresh runs at a time, even when its own updates restart the chain: the
 * chain restarts only when `active` changes or on `retry`, and a refresh still running delays the next one.
 */
export const installPeriodicRefresh = (deps: {
  active: Accessor<boolean>;
  intervalMs?: number;
  refresh: () => Promise<void>;
}): { failed: Accessor<boolean>; retry: () => void } => {
  const active = createMemo(deps.active);
  const interval = deps.intervalMs ?? INTERVAL_MS;
  const [failed, setFailed] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  let inFlight = false;
  let retried = false;
  createEffect(() => {
    attempt();
    const now = retried;
    retried = false;
    if (!active()) return setFailed(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;
    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(run, delay);
    };
    const run = () => {
      if (disposed) return;
      if (document.hidden || inFlight) return schedule(interval);
      inFlight = true;
      deps
        .refresh()
        .then(() => {
          failures = 0;
          if (active()) setFailed(false);
        })
        .catch(() => {
          failures += 1;
          if (active()) setFailed(true);
        })
        .finally(() => {
          inFlight = false;
          schedule(Math.min(Math.max(MAX_BACKOFF_MS, interval), interval * 2 ** failures));
        });
    };
    schedule(now ? 0 : interval);
    onCleanup(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
    });
  });
  return {
    failed,
    retry: () => {
      retried = true;
      setAttempt((n) => n + 1);
    },
  };
};
