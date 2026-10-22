import { createSignal, onCleanup, onMount } from "solid-js";
import type { DashboardRange } from "../../dashboard-contracts";
import { DASHBOARD_REFRESH_MS } from "../../dashboard-contracts";
import {
  DashboardClientError,
  type DashboardPanelResult,
  type DashboardTarget,
  dashboardClient,
  type PublicDashboardPanel,
} from "./dashboard-client";

/** One read at a time per dashboard, respecting the server's shared refresh/backoff receipt. */
export const createDashboardController = (input: { target: DashboardTarget; panels: PublicDashboardPanel[]; range: DashboardRange }) => {
  const [results, setResults] = createSignal<Record<string, DashboardPanelResult>>({});
  const [pending, setPending] = createSignal<string[]>([]);
  const [denied, setDenied] = createSignal(false);
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let disposed = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
  };
  const refresh = async (panelId?: string) => {
    if (busy || denied() || disposed) return;
    clear();
    busy = true;
    const panels = input.panels.filter((panel) => !panelId || panel.id === panelId);
    setPending(panels.map((panel) => panel.id));
    try {
      for (const panel of panels) {
        if (lifetime.signal.aborted || denied()) break;
        try {
          const next = await dashboardClient.panel(input.target, panel.id, input.range, lifetime.signal);
          if (!disposed)
            setResults((old) => ({
              ...old,
              [panel.id]: { ...next, lastGood: next.lastGood ?? old[panel.id]?.lastGood ?? null },
            }));
        } catch (error) {
          if (disposed) break;
          if (error instanceof DashboardClientError && [401, 403, 404].includes(error.status)) {
            // Access/publication loss clears even the last successful values.
            setDenied(true);
            setResults({});
            break;
          }
          setResults((old) => ({
            ...old,
            [panel.id]: {
              panelId: panel.id,
              status: "error",
              error: error instanceof DashboardClientError ? error.code : "STORE_UNAVAILABLE",
              nextRefreshAt: new Date(Date.now() + DASHBOARD_REFRESH_MS).toISOString(),
              lastGood: old[panel.id]?.lastGood ?? null,
            },
          }));
        } finally {
          if (!disposed) setPending((old) => old.filter((id) => id !== panel.id));
        }
      }
    } finally {
      busy = false;
      if (!disposed && !denied()) {
        const next = Object.values(results())
          .map((result) => Date.parse(result.nextRefreshAt))
          .filter(Number.isFinite);
        // Refresh all panels after every panel's admission window has ended.
        const delay = Math.max(DASHBOARD_REFRESH_MS, ...next.map((at) => at - Date.now()));
        timer = setTimeout(() => {
          if (!document.hidden) void refresh();
          else schedule();
        }, delay);
      }
    }
  };
  const schedule = () => {
    clear();
    timer = setTimeout(() => void refresh(), DASHBOARD_REFRESH_MS);
  };
  onMount(() => void refresh());
  onCleanup(() => {
    disposed = true;
    clear();
    lifetime.abort();
  });
  return { results, pending, denied, refresh };
};
