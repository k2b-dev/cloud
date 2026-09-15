import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js";
import type { PulseDashboard } from "../../contracts";
import type { WorkspaceView } from "./types";

type NearRealtimeControllerDeps = {
  selectedBaseId: Accessor<string>;
  activeView: Accessor<WorkspaceView>;
  selectedDashboard: Accessor<PulseDashboard | null>;
  refreshSources: (baseId: string) => Promise<void>;
  refreshActivity: (baseId: string) => Promise<void>;
  refreshDashboard: (baseId: string) => Promise<void>;
  refreshResources: (baseId: string) => Promise<void>;
};

const refreshInterval = (view: WorkspaceView, dashboard: PulseDashboard | null): number | null => {
  if (view === "dashboard") {
    const interval = dashboard?.config.refreshIntervalSeconds;
    return interval === null ? null : (interval ?? 5);
  }
  return view === "sources" ||
    view === "resources" ||
    view === "resource-detail" ||
    view === "activity-events" ||
    view === "activity-states" ||
    view === "activity-metrics"
    ? 5
    : null;
};

export const installNearRealtimeController = (deps: NearRealtimeControllerDeps): void => {
  const scheduleKey = createMemo(
    () => ({
      baseId: deps.selectedBaseId(),
      view: deps.activeView(),
      dashboardId: deps.selectedDashboard()?.id,
      intervalSeconds: refreshInterval(deps.activeView(), deps.selectedDashboard()),
    }),
    undefined,
    {
      equals: (left, right) =>
        left.baseId === right.baseId &&
        left.view === right.view &&
        left.dashboardId === right.dashboardId &&
        left.intervalSeconds === right.intervalSeconds,
    },
  );
  createEffect(() => {
    const { baseId, view, intervalSeconds } = scheduleKey();
    if (!baseId) return;
    if (intervalSeconds === null) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const schedule = (delayMs: number) => {
      if (disposed) return;
      timer = setTimeout(run, delayMs + Math.floor(Math.random() * 350));
    };

    const run = () => {
      if (disposed) return;
      if (document.hidden) {
        schedule(intervalSeconds * 1000);
        return;
      }
      const task =
        view === "dashboard"
          ? deps.refreshDashboard(baseId)
          : view === "sources"
            ? deps.refreshSources(baseId)
            : view === "resources" || view === "resource-detail"
              ? deps.refreshResources(baseId)
              : deps.refreshActivity(baseId);

      task
        .then(() => {
          failures = 0;
        })
        .catch((error) => {
          failures += 1;
          console.warn("Pulse workspace refresh failed", error);
        })
        .finally(() => {
          schedule(Math.min(60_000, intervalSeconds * 1000 * Math.max(1, 2 ** failures)));
        });
    };

    schedule(intervalSeconds * 1000);
    onCleanup(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
    });
  });
};
