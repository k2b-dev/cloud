import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js";

const INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Status changes while the page stays open: source status (newest data, throttling, errors) while the sources
 * view is visible, and a base's lifecycle operation while its settings are open. Refresh every 5 s while
 * `active`; skip hidden tabs and back off after failures, up to one minute. A failed refresh keeps the last data
 * and shows the existing retry notice. At most one refresh runs at a time, even when its own updates restart the
 * chain: the chain restarts only when `active` changes, and a refresh still running delays the next one.
 */
export const installPeriodicRefresh = (deps: { active: Accessor<boolean>; refresh: () => Promise<void> }): void => {
  const active = createMemo(deps.active);
  let inFlight = false;
  createEffect(() => {
    if (!active()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;
    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(run, delay);
    };
    const run = () => {
      if (disposed) return;
      if (document.hidden || inFlight) return schedule(INTERVAL_MS);
      inFlight = true;
      deps
        .refresh()
        .then(() => {
          failures = 0;
        })
        .catch(() => {
          failures += 1;
        })
        .finally(() => {
          inFlight = false;
          schedule(Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** failures));
        });
    };
    schedule(INTERVAL_MS);
    onCleanup(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
    });
  });
};
