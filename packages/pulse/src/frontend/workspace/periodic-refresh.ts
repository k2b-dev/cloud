import { type Accessor, createEffect, onCleanup } from "solid-js";

const INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Source status (newest data, throttling, errors) changes while the page stays open. While the sources view is
 * visible, refresh it every 5 s like the removed workspace controller did; skip hidden tabs and back off after
 * failures, up to one minute. A failed refresh keeps the last data and shows the existing retry notice.
 */
export const installSourceRefresh = (deps: { active: Accessor<boolean>; refresh: () => Promise<void> }): void => {
  createEffect(() => {
    if (!deps.active()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;
    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(run, delay);
    };
    const run = () => {
      if (disposed) return;
      if (document.hidden) return schedule(INTERVAL_MS);
      deps
        .refresh()
        .then(() => {
          failures = 0;
        })
        .catch(() => {
          failures += 1;
        })
        .finally(() => schedule(Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** failures)));
    };
    schedule(INTERVAL_MS);
    onCleanup(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
    });
  });
};
