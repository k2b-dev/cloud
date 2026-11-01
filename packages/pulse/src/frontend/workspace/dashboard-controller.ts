import { createSignal, onCleanup, onMount } from "solid-js";
import type { DashboardRange } from "../../dashboard-contracts";
import { DASHBOARD_PANEL_READS, DASHBOARD_REFRESH_MS } from "../../dashboard-contracts";
import {
  DashboardClientError,
  type DashboardPanelResult,
  type DashboardTarget,
  dashboardClient,
  type PublicDashboardPanel,
} from "./dashboard-client";

/** Reads panels within the SQL budget, so a slow panel does not hold the others, and respects the server's
 * shared refresh/backoff receipt. Published links keep one read at a time, as anonymous traffic gets no second slot. */
export const createDashboardController = (input: { target: DashboardTarget; panels: PublicDashboardPanel[]; range: DashboardRange }) => {
  const [results, setResults] = createSignal<Record<string, DashboardPanelResult>>({});
  const [pending, setPending] = createSignal<string[]>([]);
  const [denied, setDenied] = createSignal(false);
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlines = new Map<string, number>();
  const reads = "token" in input.target ? 1 : DASHBOARD_PANEL_READS;
  let busy = false;
  let disposed = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
  };
  const read = async (panel: PublicDashboardPanel) => {
    try {
      const next = await dashboardClient.panel(input.target, panel.id, input.range, lifetime.signal);
      // Another reader may have lost access meanwhile; a late answer must not bring values back.
      if (!disposed && !denied())
        setResults((old) => ({
          ...old,
          // Cleared data or a new revision is a new variant: never keep showing values from before it.
          [panel.id]: {
            ...next,
            lastGood: next.lastGood ?? (old[panel.id]?.variant === next.variant ? old[panel.id]?.lastGood : null) ?? null,
          },
        }));
    } catch (error) {
      if (disposed || denied()) return;
      if (error instanceof DashboardClientError && [401, 403, 404].includes(error.status)) {
        // Access/publication loss clears even the last successful values.
        setDenied(true);
        setResults({});
        return;
      }
      setResults((old) => ({
        ...old,
        [panel.id]: {
          panelId: panel.id,
          status: "error",
          error: error instanceof DashboardClientError ? error.code : "REQUEST_FAILED",
          nextRefreshAt: new Date(Date.now() + DASHBOARD_REFRESH_MS).toISOString(),
          lastGood: old[panel.id]?.lastGood ?? null,
          variant: old[panel.id]?.variant ?? "",
        },
      }));
    } finally {
      if (!disposed) {
        const result = results()[panel.id];
        const now = Date.now();
        const receipt = Date.parse(result?.nextRefreshAt ?? "");
        const cold = result && !result.lastGood && ["waiting", "refreshing"].includes(result.status);
        // Expired/malformed receipts (including clock skew) use the public
        // cadence. A cold panel alone may recheck a future receipt sooner.
        deadlines.set(
          panel.id,
          cold && receipt > now ? receipt : Math.max(now + DASHBOARD_REFRESH_MS, Number.isFinite(receipt) ? receipt : 0),
        );
        setPending((old) => old.filter((id) => id !== panel.id));
      }
    }
  };
  const refreshPanels = async (panelIds: string[]) => {
    if (busy || denied() || disposed) return;
    clear();
    busy = true;
    const panels = input.panels.filter((panel) => panelIds.includes(panel.id));
    setPending(panels.map((panel) => panel.id));
    try {
      const queue = [...panels];
      const reader = async () => {
        for (let panel = queue.shift(); panel && !lifetime.signal.aborted && !denied(); panel = queue.shift()) await read(panel);
      };
      await Promise.all(Array.from({ length: Math.min(reads, panels.length) }, reader));
    } finally {
      busy = false;
      if (!disposed && !denied()) schedule();
    }
  };
  const schedule = () => {
    clear();
    if (document.hidden || disposed || denied() || busy || !deadlines.size) return;
    const at = Math.min(...deadlines.values());
    timer = setTimeout(
      () => {
        const due = [...deadlines].filter(([, at]) => at <= Date.now()).map(([id]) => id);
        if (!document.hidden) void refreshPanels(due);
      },
      Math.max(0, at - Date.now()),
    );
  };
  const refresh = (panelId?: string) =>
    refreshPanels(input.panels.filter((panel) => !panelId || panel.id === panelId).map((panel) => panel.id));
  onMount(() => {
    const visible = () => {
      if (!document.hidden) schedule();
      else clear();
    };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => document.removeEventListener("visibilitychange", visible));
  });
  onMount(() => void refresh());
  onCleanup(() => {
    disposed = true;
    clear();
    lifetime.abort();
  });
  return { results, pending, denied, refresh };
};
