import { navigateTo } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { AppWorkspace, appWorkspaceLayoutStyle, Button, IconButton, NoticeCard, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { usePulseMessages } from "./use-messages";
import { createBaseController } from "./workspace/base-controller";
import { navigatePulseWorkspace } from "./workspace/navigation";
import PulseSidebar, { PulseMobileFeatureHeader } from "./workspace/PulseSidebar";
import { installPeriodicRefresh } from "./workspace/periodic-refresh";
import { launchPulseOverviewAssistant } from "./workspace/pulse-assistant-launch";
import SourcesView, { SourcesDetailPanel, type SourcesViewProps } from "./workspace/SourcesView";
import SqlConsoleView from "./workspace/SqlConsoleView";
import { createSourceController } from "./workspace/source-controller";
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
  const selectedBaseId = () => props.initialBaseId;
  const [sourcesRequested, setSourcesRequested] = createSignal(false);
  const queries = createPulseWorkspaceQueries(props, selectedSourceId, () => activeView() === "sources" || sourcesRequested());
  const bases = () => queries.bases.data() ?? props.initialBases;
  const sources = () => queries.baseData.data() ?? props.initialSources;
  const selectedBase = () => bases().find((base) => base.id === props.initialBaseId) ?? null;
  const askAssistant = async () => {
    if (assistantPending()) return;
    setAssistantPending(true);
    setAssistantError(null);
    try {
      const launch = await launchPulseOverviewAssistant({
        base: { id: props.initialBaseId, name: selectedBase()?.name ?? t().appName },
        locale: locale(),
      });
      if (!disposed) navigateTo(launch.href);
    } catch {
      if (!disposed) setAssistantError(t().sqlAssistantFailureTitle);
    } finally {
      if (!disposed) setAssistantPending(false);
    }
  };
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
  const sourceProps: SourcesViewProps = {
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
    dateContext: () => ({ ...props.initialDateConfig, now: props.initialNow }),
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
