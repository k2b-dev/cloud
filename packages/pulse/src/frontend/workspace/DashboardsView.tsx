import { navigateTo } from "@k2b/ssr/nav";
import { Button, ButtonLink, NoticeCard, PanelHeader, Skeleton, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { Overview } from "../../overview-contracts";
import { usePulseMessages } from "../use-messages";
import DashboardView from "./DashboardView";
import { DashboardClientError, type DashboardSnapshot, dashboardClient } from "./dashboard-client";
import { dashboardStyles } from "./dashboard-styles";
import { launchPulseOverviewAssistant } from "./pulse-assistant-launch";
import { buildPulseWorkspaceHref, type WorkspaceRouteState } from "./routes";

export default function DashboardsView(props: {
  base: { id: string; name: string };
  route: WorkspaceRouteState;
  snapshot?: DashboardSnapshot;
  canWrite: boolean;
  overview?: Overview | null;
}) {
  const t = usePulseMessages(),
    locale = useLocale();
  const [snapshot, setSnapshot] = createSignal(props.snapshot);
  const [loading, setLoading] = createSignal(!props.snapshot);
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [assistantError, setAssistantError] = createSignal(false);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const refresh = async () => {
    setLoading(true);
    try {
      const page = await dashboardClient.list(props.base.id, 0, lifetime.signal);
      const selected = props.route.dashboardId
        ? await dashboardClient.get({ baseId: props.base.id, dashboardId: props.route.dashboardId }, lifetime.signal)
        : (page.items[0] ?? null);
      if (!lifetime.signal.aborted) setSnapshot({ ...page, selected, error: null });
    } catch (error) {
      if (!lifetime.signal.aborted)
        setSnapshot({
          items: [],
          total: 0,
          nextOffset: null,
          selected: null,
          error: { code: error instanceof DashboardClientError ? error.code : "REQUEST_FAILED", message: "" },
        });
    } finally {
      if (!lifetime.signal.aborted) setLoading(false);
    }
  };
  onMount(() => {
    if (!props.snapshot) void refresh();
  });
  const ask = async () => {
    if (assistantPending()) return;
    setAssistantPending(true);
    setAssistantError(false);
    try {
      const result = await launchPulseOverviewAssistant({ base: props.base, locale: locale() });
      if (!lifetime.signal.aborted) navigateTo(result.href);
    } catch {
      if (!lifetime.signal.aborted) setAssistantError(true);
    } finally {
      if (!lifetime.signal.aborted) setAssistantPending(false);
    }
  };
  const selected = () => snapshot()?.selected;
  return (
    <Show
      when={selected()}
      keyed
      fallback={
        <div class="pulse-dashboard">
          <style>{dashboardStyles}</style>
          <PanelHeader as="h1" title={t().dashboards} size="lg" />
          <Show
            when={!loading()}
            fallback={
              <div class="pulse-dashboard__feedback" role="status" aria-label={t().dashboardLoading}>
                <Skeleton class="h-[170px] w-full" />
              </div>
            }
          >
            <Show
              when={!snapshot()?.error}
              fallback={
                <NoticeCard
                  role="alert"
                  tone="danger"
                  title={
                    ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"].includes(snapshot()?.error?.code ?? "")
                      ? t().dashboardDenied
                      : t().pulseDataRefreshFailed
                  }
                  detail={
                    ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"].includes(snapshot()?.error?.code ?? "")
                      ? t().dashboardDeniedDetail
                      : undefined
                  }
                >
                  <Button variant="secondary" onClick={() => void refresh()}>
                    {t().retry}
                  </Button>
                </NoticeCard>
              }
            >
              <div class="pulse-dashboard__empty">
                <i class="ti ti-layout-dashboard text-3xl text-secondary" aria-hidden="true" />
                <h2>{t().dashboardEmpty}</h2>
                <p>{t().dashboardEmptyDetail}</p>
                <div class="pulse-dashboard__actions">
                  <ButtonLink href={buildPulseWorkspaceHref({ baseId: props.base.id, state: { view: "sql" } })}>
                    <i class="ti ti-terminal-2" aria-hidden="true" />
                    {t().dashboardOpenSql}
                  </ButtonLink>
                  <Button variant="ai" disabled={assistantPending()} onClick={() => void ask()}>
                    <i class="ti ti-sparkles" aria-hidden="true" />
                    {t().sqlAskAssistant}
                  </Button>
                </div>
              </div>
            </Show>
          </Show>
          <Show when={assistantError()}>
            <NoticeCard role="alert" tone="danger" title={t().sqlAssistantFailureTitle}>
              <Button variant="secondary" onClick={() => void ask()} disabled={assistantPending()}>
                {t().retry}
              </Button>
            </NoticeCard>
          </Show>
        </div>
      }
    >
      {(dashboard) => (
        <DashboardView
          name={dashboard.name}
          panels={dashboard.definition.panels}
          range={props.route.dashboardRange ?? { range: "24h" }}
          path={buildPulseWorkspaceHref({ baseId: props.base.id, state: props.route })}
          target={{ baseId: props.base.id, dashboardId: dashboard.id }}
          private={{ dashboard, base: props.base, canWrite: props.canWrite, overview: props.overview }}
        />
      )}
    </Show>
  );
}
