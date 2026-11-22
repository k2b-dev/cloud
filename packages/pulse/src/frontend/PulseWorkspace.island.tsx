import { navigateTo } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { AppWorkspace, appWorkspaceLayoutStyle, Button, IconButton, NoticeCard, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import type { AlertRule } from "../alert-contracts";
import type { PulseBaseRead } from "../contracts";
import { jsonFetch } from "./http";
import { usePulseMessages } from "./use-messages";
import { createBaseController } from "./workspace/base-controller";
import FiredAlerts from "./workspace/FiredAlerts";
import { compactDateWithDelta } from "./workspace/helpers";
import { navigatePulseWorkspace } from "./workspace/navigation";
import PulseSidebar, { PulseMobileFeatureHeader } from "./workspace/PulseSidebar";
import { installPeriodicRefresh } from "./workspace/periodic-refresh";
import { launchPulseOverviewAssistant, launchPulseSqlAssistant } from "./workspace/pulse-assistant-launch";
import { buildPulseWorkspaceHref } from "./workspace/routes";
import SourcesView, { SourcesDetailPanel, type SourcesViewProps } from "./workspace/SourcesView";
import SqlConsoleView from "./workspace/SqlConsoleView";
import { createSourceController } from "./workspace/source-controller";
import { installStoreRecheck } from "./workspace/store-recheck";
import type { PulseWorkspaceProps } from "./workspace/types";
import { createPulseWorkspaceQueries } from "./workspace/workspace-queries";
import { pulseWorkspaceStyles } from "./workspace/workspace-styles";

export default function PulseWorkspace(props: PulseWorkspaceProps) {
  const t = usePulseMessages();
  const locale = useLocale();
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [assistantError, setAssistantError] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const selectedSourceId = () => props.initialRouteState.sourceId;
  const [loading, setLoading] = createSignal(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const activeView = () => props.initialRouteState.view;
  // An old dashboard link led here: the server read the notice, so the first render already shows it.
  const [removedNotice, setRemovedNotice] = createSignal(props.initialNotice === "dashboards-removed");
  const dismissRemovedNotice = () => {
    setRemovedNotice(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("notice");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const selectedBaseId = () => props.initialBaseId;
  const [sourcesRequested, setSourcesRequested] = createSignal(false);
  const queries = createPulseWorkspaceQueries(props, selectedSourceId, () => activeView() === "sources" || sourcesRequested());
  const bases = () => queries.bases.data() ?? props.initialBases;
  const sources = () => queries.baseData.data() ?? props.initialSources;
  const selectedBase = () => bases().find((base) => base.id === props.initialBaseId) ?? null;
  const base = () => ({ id: props.initialBaseId, name: selectedBase()?.name ?? t().appName });
  const launch = async (start: () => ReturnType<typeof launchPulseOverviewAssistant>) => {
    if (assistantPending()) return;
    setAssistantPending(true);
    setAssistantError(null);
    try {
      const result = await start();
      if (!disposed) navigateTo(result.href);
    } catch {
      if (!disposed) {
        setAssistantError(t().sqlAssistantFailureTitle);
        toast.error(t().assistantRetry, { title: t().assistantFailedTitle });
      }
    } finally {
      if (!disposed) setAssistantPending(false);
    }
  };
  const askAssistant = () => launch(() => launchPulseOverviewAssistant({ base: base(), locale: locale() }));
  const adjustAlert = (alertId: string) =>
    launch(async () => {
      const rule = await jsonFetch<AlertRule>(`/api/pulse/bases/${props.initialBaseId}/alerts/${encodeURIComponent(alertId)}`);
      return launchPulseSqlAssistant({ base: base(), sql: rule.sql, params: rule.params, queryName: rule.name, locale: locale() });
    });
  // Sources: the alerts that fired and the data store state, as the server read them for this page.
  const alerts = () => props.initialAttention?.alerts ?? [];
  const selectedSource = () => sources().find((source) => source.id === selectedSourceId()) ?? null;
  const navigate: Parameters<typeof createSourceController>[0]["navigate"] = (state) =>
    navigatePulseWorkspace({ baseId: props.initialBaseId, state });
  const openSources = () => navigate({ view: "sources" });
  const readQueries = () =>
    activeView() !== "sources"
      ? [queries.bases]
      : selectedSourceId()
        ? [queries.bases, queries.baseData, queries.sourceDetail]
        : [queries.bases, queries.baseData];
  const writeBlocked = () => readQueries().some((query) => query.loading() || query.stale() || query.error() !== null);
  const refresh = async () => {
    await Promise.all([
      queries.bases.refresh(),
      ...(activeView() === "sources" ? [queries.baseData.refresh()] : []),
      ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : []),
    ]);
    const error = readQueries()
      .find((query) => query.error())
      ?.error();
    if (error) throw error;
  };
  // The store cannot take or answer data: the server read says so, or the base store failed since. Pulse checks again
  // by itself every 30 s on Sources while the page is visible; only that state follows, and the list loads again once
  // the store answers. Focus and scroll stay.
  const store = installStoreRecheck({
    initial: props.initialAttention?.store ?? { unavailable: false, since: null },
    failedSince: () => selectedBase()?.store.state === "failed",
    watching: () => activeView() === "sources",
    check: async () => (await jsonFetch<PulseBaseRead>(`/api/pulse/bases/${props.initialBaseId}`)).outage,
    recovered: async () => {
      await Promise.all([queries.bases.refresh(), queries.baseData.refresh()]);
    },
  });
  const storeDownSince = () => store.since() ?? selectedBase()?.store.errorAt ?? null;
  // Only the sources and the open source change with collection; the base list refreshes on demand.
  installPeriodicRefresh({
    active: () => activeView() === "sources" && !loading(),
    refresh: async () => {
      await Promise.all([queries.baseData.refresh(), ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : [])]);
      const error = [queries.baseData, queries.sourceDetail].find((query) => query.error())?.error();
      if (error) throw error;
    },
  });
  // A running provision, clear or delete ends in active or failed; open settings show that end and its Retry.
  installPeriodicRefresh({
    active: () => settingsDialogOpen() && ["provisioning", "clearing", "deleting"].includes(selectedBase()?.store.state ?? ""),
    refresh: async () => {
      await queries.bases.refresh();
      if (queries.bases.error()) throw queries.bases.error();
    },
  });
  const { openSettings } = createBaseController({
    bases,
    canAdmin: () => props.initialPermissions?.admin ?? false,
    admins: props.initialSettings?.admins,
    maxRawRetentionDays: props.initialSettings?.maxRawRetentionDays,
    initialTab: props.initialRouteState.settings,
    selectedBase,
    loading,
    settingsDialogOpen,
    setLoading,
    setSettingsDialogOpen,
    refreshBases: async () => {
      await queries.bases.invalidate();
      if (queries.bases.error()) throw queries.bases.error();
    },
    refreshWorkspace: refresh,
    writeBlocked,
    navigateToBase: (baseId) => navigatePulseWorkspace({ baseId, state: { view: "sources" } }),
  });
  onMount(() => {
    if (props.initialRouteState.settings) void openSettings();
  });
  const actions = createSourceController({
    selectedBaseName: () => selectedBase()?.name ?? t().appName,
    selectedBaseId,
    timezone: () => selectedBase()?.timezone ?? "UTC",
    askAssistant,
    assistantPending,
    assistantError,
    loading,
    setLoading,
    selectedSourceId,
    navigate,
    writeBlocked,
    refreshBaseData: async () => {
      setSourcesRequested(true);
      await queries.baseData.invalidate();
      if (queries.baseData.error()) throw queries.baseData.error();
    },
    refreshSourceDetail: async () => {
      if (!selectedSourceId()) return;
      await queries.sourceDetail.invalidate();
      if (queries.sourceDetail.error()) throw queries.sourceDetail.error();
    },
  });
  createEffect(
    on(
      queries.bases.data,
      (next) => {
        if (next && !next.some((base) => base.id === props.initialBaseId))
          navigatePulseWorkspace({ baseId: next[0]?.id ?? "", state: { view: "sources" } });
      },
      { defer: true },
    ),
  );
  const dateContext = () => ({ ...props.initialDateConfig, now: props.initialNow });
  const sourcesHeader = (
    <>
      {/* Shown on the first render of the base an old dashboard link opened; it leaves only on request. */}
      <Show when={removedNotice()}>
        <NoticeCard
          tone="info"
          icon
          title={t().dashboardsRemovedTitle}
          detail={t().dashboardsRemovedDetail}
          actions={
            <Button variant="secondary" size="sm" onClick={dismissRemovedNotice}>
              {t().dashboardsRemovedDismiss}
            </Button>
          }
        />
      </Show>
      <Show when={store.down()}>
        <NoticeCard
          role="status"
          tone="warning"
          icon
          title={t().storeDownTitle}
          meta={
            storeDownSince()
              ? `${t().storeDownSince({ time: compactDateWithDelta(storeDownSince()!, dateContext()) })} · ${t().storeDownChecks}`
              : t().storeDownChecks
          }
          detail={t().storeDownConsequence({
            time: compactDateWithDelta(props.initialAttention?.readAt ?? props.initialNow, dateContext()),
          })}
        />
      </Show>
      <Show when={alerts().length}>
        <FiredAlerts
          alerts={alerts()}
          selectedAlertId={props.initialRouteState.alertId}
          dateContext={dateContext()}
          sqlHref={(alertId) => buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: { view: "sql", alertId } })}
          adjust={(alertId) => void adjustAlert(alertId)}
          adjustPending={assistantPending()}
        />
      </Show>
    </>
  );
  const sourceProps: SourcesViewProps = {
    header: sourcesHeader,
    search,
    setSearch,
    selectedBaseId,
    loading: () => loading() || writeBlocked(),
    sources: () => sources().filter((source) => source.name.toLowerCase().includes(search().trim().toLowerCase())),
    selectedSourceId,
    selectedSource,
    selectedSourceScrapes: () => queries.currentDetail()?.scrapes ?? [],
    selectedSourceApiKeys: () => queries.currentDetail()?.apiKeys ?? [],
    origin: () => props.initialOrigin,
    dateContext,
    copySetupText: (text, label) => {
      void clipboard.copy(text).then(
        () => toast.success(label),
        () => toast.error(t().copySetupFailed),
      );
    },
    addSource: actions.addSource,
    selectSource: (source) => navigate({ view: "sources", sourceId: source.id }),
    closeSource: openSources,
    editSource: actions.editSource,
    toggleSource: actions.toggleSource,
    scrape: actions.scrape,
    removeSource: actions.removeSource,
    createApiKey: actions.createApiKey,
    revokeApiKey: actions.revokeApiKey,
  };
  const readError = () =>
    readQueries()
      .find((query) => query.error())
      ?.error();
  // A CSS default lets restored and resized inline geometry keep precedence.
  const renderFrame = (sqlContent?: JSX.Element, sqlAction?: JSX.Element) => (
    <>
      <style>{`.pulse-workspace{${appWorkspaceLayoutStyle({ version: 2, sidebarWidth: 236 })}}${pulseWorkspaceStyles}`}</style>
      <PulseMobileFeatureHeader
        title={selectedBase()?.name ?? t().appName}
        bases={bases()}
        baseId={props.initialBaseId}
        name={activeView() === "sql" ? "SQL" : t().sources}
        action={
          activeView() === "sql" ? (
            sqlAction
          ) : (
            <IconButton
              variant="ghost"
              label={t().sourcePickTitle({ base: selectedBase()?.name ?? t().appName })}
              disabled={!selectedBaseId() || loading() || writeBlocked()}
              onClick={() => void actions.addSource()}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </IconButton>
          )
        }
      />
      <AppWorkspace class="pulse-workspace" mobileSurface="flush">
        <PulseSidebar
          title={selectedBase()?.name ?? t().appName}
          bases={bases()}
          baseId={props.initialBaseId}
          activeView={activeView()}
          sourceCount={sources().length}
          settingsDisabled={!selectedBase() || loading()}
          openSettings={openSettings}
          openSources={openSources}
          openSql={() => navigate({ view: "sql" })}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="gap-2 px-4 py-[var(--ui-space-shell)] md:px-5">
            <Show when={readError()}>
              {(error) => (
                <NoticeCard tone="danger" title={t().pulseDataRefreshFailed} detail={error().message}>
                  <Button variant="secondary" onClick={() => void refresh().catch(() => {})}>
                    {t().retry}
                  </Button>
                </NoticeCard>
              )}
            </Show>
            <Show when={activeView() === "sources"} fallback={sqlContent}>
              <SourcesView {...sourceProps} />
            </Show>
          </AppWorkspace.Main>
          <AppWorkspace.Detail
            id="pulse-detail-panel"
            open={activeView() === "sources" && Boolean(selectedSource())}
            onClose={openSources}
            width="lg"
          >
            <SourcesDetailPanel {...sourceProps} />
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
      </AppWorkspace>
    </>
  );
  return (
    <Show when={activeView() === "sql"} fallback={renderFrame()}>
      <SqlConsoleView
        base={{ id: props.initialBaseId, name: selectedBase()?.name ?? t().appName }}
        route={props.initialRouteState}
        snapshot={props.initialSql}
        canWrite={props.initialPermissions?.write ?? false}
        renderFrame={renderFrame}
      />
    </Show>
  );
}
