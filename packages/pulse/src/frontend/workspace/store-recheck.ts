import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import type { PulseStoreOutage } from "../../contracts";
import { installPeriodicRefresh } from "./periodic-refresh";

/** Pulse checks a lost data store again by itself every 30 s; no button, no countdown (decided 15.11.). */
export const STORE_RECHECK_MS = 30_000;

/**
 * The data store state of the open base. `initial` is the page's server read; `failedSince` reports a base store that
 * failed after it (the base list). While `watching` (the Sources tab), the store is down and the document is visible,
 * `check` reads the base again every 30 s and only the store state and `since` follow it. Hidden documents and a store
 * that is fine start no timer and no request. When the store answers again, `recovered` loads what the page shows, so
 * the down state ends in place without a reload.
 */
export const installStoreRecheck = (deps: {
  initial: PulseStoreOutage;
  failedSince: Accessor<boolean>;
  watching: Accessor<boolean>;
  check: () => Promise<PulseStoreOutage>;
  recovered: () => Promise<void>;
}): { down: Accessor<boolean>; since: Accessor<string | null> } => {
  const [outage, setOutage] = createSignal(deps.initial);
  const [visible, setVisible] = createSignal(true);
  onMount(() => {
    const follow = () => setVisible(!document.hidden);
    follow();
    document.addEventListener("visibilitychange", follow);
    onCleanup(() => document.removeEventListener("visibilitychange", follow));
  });
  const down = () => outage().unavailable || deps.failedSince();
  installPeriodicRefresh({
    active: () => deps.watching() && down() && visible(),
    intervalMs: STORE_RECHECK_MS,
    refresh: async () => {
      const next = await deps.check();
      setOutage(next);
      if (!next.unavailable) await deps.recovered();
    },
  });
  return { down, since: () => outage().since };
};
