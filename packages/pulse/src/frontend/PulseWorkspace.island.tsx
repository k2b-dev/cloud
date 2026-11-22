import { navigateTo } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import {
  AppWorkspace,
  appWorkspaceLayoutStyle,
  Button,
  ButtonLink,
  type DropdownItem,
  NoticeCard,
  NoticeRow,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import type { AlertRule } from "../alert-contracts";
import type { PulseBaseRead } from "../contracts";
import { jsonFetch } from "./http";
import { usePulseMessages } from "./use-messages";
import AlertDetail from "./workspace/AlertDetail";
import { createBaseController } from "./workspace/base-controller";
import DataTab from "./workspace/DataTab";
import { attentionItems, basePageState, sourcesSummary } from "./workspace/flat-state";
import NoAccessView from "./workspace/NoAccessView";
import { navigatePulseWorkspace } from "./workspace/navigation";
import PulseHead from "./workspace/PulseHead";
import PulseSidebar, { type BaseDot } from "./workspace/PulseSidebar";
import { installPeriodicRefresh } from "./workspace/periodic-refresh";
import { launchPulseOverviewAssistant, launchPulseSqlAssistant } from "./workspace/pulse-assistant-launch";
import { buildPulseWorkspaceHref } from "./workspace/routes";
import SourcesTab from "./workspace/SourcesTab";
import { SourcesDetailPanel, type SourcesViewProps } from "./workspace/SourcesView";
import SqlConsoleView from "./workspace/SqlConsoleView";
import { createSourceController } from "./workspace/source-controller";
import { installStoreRecheck } from "./workspace/store-recheck";
import type { PulseWorkspaceProps } from "./workspace/types";
import UsageTab from "./workspace/UsageTab";
import { createPulseWorkspaceQueries } from "./workspace/workspace-queries";
import { pulseWorkspaceStyles } from "./workspace/workspace-styles";

export default function PulseWorkspace(props: PulseWorkspaceProps) {
  const t = usePulseMessages();
  const locale = useLocale();
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [assistantError, setAssistantError] = createSignal<string | null>(null);
  const [switchingTo, setSwitchingTo] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  // Back from the next base restores this page from the cache: it shows the base again, not the switch.
  onMount(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setSwitchingTo(null);
    };
    window.addEventListener("pageshow", restored);
    onCleanup(() => window.removeEventListener("pageshow", restored));
  });
  const selectedSourceId = () => props.initialRouteState.sourceId;
  const selectedAlertId = () => (props.initialRouteState.view === "sources" ? (props.initialRouteState.alertId ?? "") : "");
  const [loading, setLoading] = createSignal(false);
  // An old dashboard link led here: the server read the notice, so the first render already shows it.
  const [removedNotice, setRemovedNotice] = createSignal(props.initialNotice === "dashboards-removed");
  const dismissRemovedNotice = () => {
    setRemovedNotice(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("notice");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  const activeView = () => props.initialRouteState.view;
  const deniedAtLoad = Boolean(props.initialAccess?.denied);
  const denied = () => deniedAtLoad;
  const selectedBaseId = () => props.initialBaseId;
  const [sourcesRequested, setSourcesRequested] = createSignal(false);
  const queries = createPulseWorkspaceQueries(
    props,
    selectedSourceId,
    () => !deniedAtLoad && (["sources", "usage"].includes(activeView()) || sourcesRequested()),
  );
  const bases = () => queries.bases.data() ?? props.initialBases;
  const sources = () => queries.baseData.data() ?? props.initialSources;
  const selectedBase = () => bases().find((base) => base.id === props.initialBaseId) ?? null;
  const baseName = () => selectedBase()?.name ?? t().appName;
  const launch = async (start: () => ReturnType<typeof launchPulseOverviewAssistant>) => {
    if (assistantPending() || denied()) return;
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
  const base = () => ({ id: props.initialBaseId, name: baseName() });
  const askAssistant = (goal?: "page" | "connect") => launch(() => launchPulseOverviewAssistant({ base: base(), locale: locale(), goal }));
  const adjustAlert = (alertId: string) =>
    launch(async () => {
      const rule = await jsonFetch<AlertRule>(`/api/pulse/bases/${props.initialBaseId}/alerts/${encodeURIComponent(alertId)}`);
      return launchPulseSqlAssistant({ base: base(), sql: rule.sql, params: rule.params, queryName: rule.name, locale: locale() });
    });
  const selectedSource = () => sources().find((source) => source.id === selectedSourceId()) ?? null;
  // Sources: the alerts that fired and the data store state, as the server read them for this page.
  const alerts = () => props.initialAttention?.alerts ?? [];
  const selectedAlert = () => (selectedAlertId() ? (alerts().find((item) => item.reference === selectedAlertId()) ?? null) : null);
  const navigate: Parameters<typeof createSourceController>[0]["navigate"] = (state) =>
    navigatePulseWorkspace({ baseId: props.initialBaseId, state });
  const openSources = () => navigate({ view: "sources" });
  const readQueries = () =>
    !["sources", "usage"].includes(activeView())
      ? [queries.bases]
      : selectedSourceId()
        ? [queries.bases, queries.baseData, queries.sourceDetail]
        : [queries.bases, queries.baseData];
  const writeBlocked = () => readQueries().some((query) => query.loading() || query.stale() || query.error() !== null);
  const refresh = async () => {
    await Promise.all([
      queries.bases.refresh(),
      ...(["sources", "usage"].includes(activeView()) ? [queries.baseData.refresh()] : []),
      ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : []),
    ]);
    const error = readQueries()
      .find((query) => query.error())
      ?.error();
    if (error) throw error;
  };
  // The store cannot take or answer data: the server read says so, or the base store failed since. The rows then show
  // the state at the time of that read. Pulse checks again by itself on the Sources tab while the page is visible: the
  // base read reports the store, only that state follows it, and the list loads again once the store answers.
  const store = installStoreRecheck({
    initial: props.initialAttention?.store ?? { unavailable: false, since: null },
    failedSince: () => selectedBase()?.store.state === "failed",
    watching: () => activeView() === "sources" && !denied(),
    check: async () => (await jsonFetch<PulseBaseRead>(`/api/pulse/bases/${props.initialBaseId}`)).outage,
    recovered: async () => {
      await Promise.all([queries.bases.refresh(), queries.baseData.refresh()]);
    },
  });
  const storeDown = store.down;
  const pageState = () =>
    basePageState({ denied: denied(), switching: Boolean(switchingTo()), storeDown: storeDown(), sourceCount: sources().length });
  // Only the sources and the open source change with collection; the base list refreshes on demand.
  installPeriodicRefresh({
    active: () => activeView() === "sources" && !loading() && !denied(),
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
    if (props.initialRouteState.settings && !deniedAtLoad) void openSettings();
  });
  const actions = createSourceController({
    selectedBaseName: baseName,
    selectedBaseId,
    timezone: () => selectedBase()?.timezone ?? "UTC",
    askAssistant: () => askAssistant("connect"),
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
        if (next && !deniedAtLoad && !next.some((base) => base.id === props.initialBaseId))
          navigatePulseWorkspace({ baseId: next[0]?.id ?? "", state: { view: "sources" } });
      },
      { defer: true },
    ),
  );
  const canWrite = () => props.initialPermissions?.write ?? false;
  const canManage = () => props.initialPermissions?.admin ?? false;
  const dateContext = () => ({ ...props.initialDateConfig, now: props.initialNow });
  const sourceProps: SourcesViewProps = {
    selectedBaseId,
    loading: () => loading() || writeBlocked(),
    sources,
    selectedSourceId,
    selectedSource,
    selectedSourceScrapes: () => queries.currentDetail()?.scrapes ?? [],
    selectedSourceApiKeys: () => queries.currentDetail()?.apiKeys ?? [],
    canManageKeys: canManage,
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
  const attention = () => attentionItems(sources(), alerts());
  const firedAlerts = () => alerts().filter((item) => item.state === "firing").length;
  /** The base's dot in the sidebar: a lost store marks every base; otherwise only the open base's state is known. */
  const baseDot = (item: { id: string }): BaseDot | undefined => {
    if (storeDown()) return "danger";
    if (item.id !== props.initialBaseId || !["sources", "usage"].includes(activeView())) return undefined;
    const summary = sourcesSummary(sources());
    return summary.kind === "empty" ? "neutral" : summary.kind === "attention" || firedAlerts() ? "danger" : "ok";
  };
  const menuItems = (): DropdownItem[] =>
    denied()
      ? []
      : [{ label: t().baseSettings, icon: "ti ti-settings", disabled: !selectedBase() || loading(), action: () => void openSettings() }];
  // A CSS default lets restored and resized inline geometry keep precedence.
  const renderFrame = (sqlContent?: JSX.Element, sqlAssistant?: { launch: () => void; pending: boolean }) => (
    <>
      <style>{`.pulse-workspace{${appWorkspaceLayoutStyle({ version: 2, sidebarWidth: 236 })}}${pulseWorkspaceStyles}`}</style>
      <AppWorkspace class="pulse-workspace" mobileSurface="flush">
        <PulseSidebar
          title={denied() ? t().appName : baseName()}
          bases={denied() ? bases().filter((base) => base.id !== props.initialBaseId) : bases()}
          baseId={denied() ? "" : props.initialBaseId}
          activeId={switchingTo() ?? undefined}
          dot={baseDot}
          switching={setSwitchingTo}
          menu={
            denied()
              ? []
              : [
                  { id: "assistant", label: t().askGustav, icon: "ti ti-sparkles", action: "assistant", disabled: assistantPending() },
                  { id: "settings", label: t().baseSettings, icon: "ti ti-settings", action: "settings", disabled: !selectedBase() },
                ]
          }
          onMenu={(action) =>
            action === "settings"
              ? openSettings()
              : action === "assistant"
                ? (sqlAssistant?.launch ?? (() => void askAssistant()))()
                : undefined
          }
        />
        <PulseHead
          baseId={props.initialBaseId}
          view={activeView()}
          sourceCount={switchingTo() ? null : sources().length}
          denied={denied()}
          canWrite={canWrite()}
          addSourceDisabled={loading() || writeBlocked()}
          addSource={() => void actions.addSource()}
          assistant={
            sqlAssistant ?? {
              pending: assistantPending(),
              disabled: switchingTo() !== null,
              launch: () => void askAssistant(),
            }
          }
          menu={menuItems()}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="pulse-main">
            <Show when={!denied() && !switchingTo() && readError()}>
              {(error) => (
                <div class="pulse-padded pulse-padded--notice">
                  <NoticeCard tone="danger" title={t().pulseDataRefreshFailed} detail={error().message}>
                    <Button variant="secondary" onClick={() => void refresh().catch(() => {})}>
                      {t().retry}
                    </Button>
                  </NoticeCard>
                </div>
              )}
            </Show>
            <Show when={!denied()} fallback={<NoAccessView managers={props.initialAccess?.managers ?? []} />}>
              <Show when={!switchingTo()} fallback={sourcesTab()}>
                {mainView(sqlContent)}
              </Show>
            </Show>
          </AppWorkspace.Main>
          <AppWorkspace.Detail
            id="pulse-detail-panel"
            open={!denied() && !switchingTo() && activeView() === "sources" && Boolean(selectedSource() || selectedAlert())}
            onClose={openSources}
          >
            <Show when={selectedAlert()} fallback={<SourcesDetailPanel {...sourceProps} />}>
              {(alert) => (
                <AlertDetail
                  alert={alert()}
                  sqlHref={buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: { view: "sql", alertId: alert().reference } })}
                  dateContext={dateContext()}
                  adjust={() => void adjustAlert(alert().reference)}
                  adjustPending={assistantPending()}
                  close={openSources}
                />
              )}
            </Show>
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
      </AppWorkspace>
    </>
  );
  const sourcesTab = () => {
    const state = pageState();
    return (
      <SourcesTab
        state={state === "noAccess" ? "ready" : state}
        baseName={baseName()}
        created={{ at: selectedBase()?.createdAt ?? props.initialNow, by: props.initialCreator ?? null }}
        sources={sources()}
        attention={attention()}
        firedAlerts={firedAlerts()}
        selectedSourceId={selectedSourceId()}
        selectedAlertId={selectedAlertId()}
        dateContext={dateContext()}
        canWrite={canWrite()}
        readAt={props.initialAttention?.readAt ?? props.initialNow}
        storeDownSince={store.since() ?? selectedBase()?.store.errorAt ?? null}
        notice={
          // Shown on the first render of the base an old dashboard link opened; it leaves only on request.
          <Show when={removedNotice() && !switchingTo()}>
            <NoticeRow
              tone="info"
              icon
              reserve={false}
              detail={t().dashboardsRemovedDetail}
              detailTitle={t().dashboardsRemovedDetail}
              actions={
                <>
                  <ButtonLink variant="secondary" href={buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: { view: "usage" } })}>
                    {t().dashboardsRemovedOpenUsage}
                  </ButtonLink>
                  <Button variant="secondary" onClick={dismissRemovedNotice}>
                    {t().dashboardsRemovedDismiss}
                  </Button>
                </>
              }
            >
              {t().dashboardsRemovedTitle}
            </NoticeRow>
          </Show>
        }
        openSource={(sourceId) => navigate({ view: "sources", sourceId })}
        openAlert={(alertId) => navigatePulseWorkspace({ baseId: props.initialBaseId, state: { view: "sources", alertId } })}
        addSource={(kind) => void actions.addSource(kind)}
        connectWithGustav={() => void askAssistant("connect")}
      />
    );
  };
  const mainView = (sqlContent?: JSX.Element): JSX.Element => {
    const view = activeView();
    // The console keeps its own layout: it stands on the text edge.
    if (view === "sql") return <div class="pulse-padded">{sqlContent}</div>;
    if (view === "data")
      return (
        <DataTab
          baseId={props.initialBaseId}
          initialKind={props.initialRouteState.kind}
          dateContext={dateContext()}
          href={(kind) => buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: { view: "data", kind } })}
        />
      );
    if (view === "usage")
      return (
        <UsageTab
          baseId={props.initialBaseId}
          sources={sources()}
          canManage={canManage()}
          dateContext={dateContext()}
          buildPage={() => void askAssistant("page")}
          buildPending={assistantPending()}
          manageMembers={() => void openSettings("members")}
        />
      );
    return sourcesTab();
  };
  return (
    <Show when={activeView() === "sql" && !denied()} fallback={renderFrame()}>
      <SqlConsoleView
        base={base()}
        route={props.initialRouteState}
        snapshot={props.initialSql}
        canWrite={canWrite()}
        renderFrame={renderFrame}
      />
    </Show>
  );
}
