import { clipboard } from "@k2b/stdlib/browser";
import { AppWorkspace, Button, NoticeCard, toast } from "@k2b/ui";
import { createEffect, createSignal, on, Show } from "solid-js";
import { usePulseMessages } from "./use-messages";
import { createBaseController } from "./workspace/base-controller";
import ComingBackView from "./workspace/ComingBackView";
import { navigatePulseWorkspace } from "./workspace/navigation";
import PulseSidebar from "./workspace/PulseSidebar";
import SourcesView, { SourcesDetailPanel, type SourcesViewProps } from "./workspace/SourcesView";
import { createSourceController } from "./workspace/source-controller";
import { installSourceRefresh } from "./workspace/source-refresh";
import type { PulseWorkspaceProps } from "./workspace/types";
import { createPulseWorkspaceQueries } from "./workspace/workspace-queries";

export default function PulseWorkspace(props: PulseWorkspaceProps) {
  const t = usePulseMessages();
  const selectedSourceId = () => props.initialRouteState.sourceId;
  const [loading, setLoading] = createSignal(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const activeView = () => props.initialRouteState.view;
  const selectedBaseId = () => props.initialBaseId;
  const queries = createPulseWorkspaceQueries(props, selectedSourceId);
  const bases = () => queries.bases.data() ?? props.initialBases;
  const sources = () => queries.baseData.data() ?? props.initialSources;
  const selectedBase = () => bases().find((base) => base.id === props.initialBaseId) ?? null;
  const selectedSource = () => sources().find((source) => source.id === selectedSourceId()) ?? null;
  const navigate: Parameters<typeof createSourceController>[0]["navigate"] = (state) =>
    navigatePulseWorkspace({ baseId: props.initialBaseId, state });
  const openSources = () => navigate({ view: "sources" });
  const readQueries = () =>
    selectedSourceId() ? [queries.bases, queries.baseData, queries.sourceDetail] : [queries.bases, queries.baseData];
  const writeBlocked = () => readQueries().some((query) => query.loading() || query.stale() || query.error() !== null);
  const refresh = async () => {
    await Promise.all([
      queries.bases.refresh(),
      queries.baseData.refresh(),
      ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : []),
    ]);
    const error = readQueries()
      .find((query) => query.error())
      ?.error();
    if (error) throw error;
  };
  // Only the sources and the open source change with collection; the base list refreshes on demand.
  installSourceRefresh({
    active: () => activeView() === "sources" && !loading(),
    refresh: async () => {
      await Promise.all([queries.baseData.refresh(), ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : [])]);
      const error = [queries.baseData, queries.sourceDetail].find((query) => query.error())?.error();
      if (error) throw error;
    },
  });
  const { openSettings } = createBaseController({
    bases,
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
  const actions = createSourceController({
    selectedBaseId,
    loading,
    setLoading,
    selectedSourceId,
    navigate,
    writeBlocked,
    refreshBaseData: async () => {
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
  return (
    <AppWorkspace mobileSurface="flush" class="min-h-[760px]">
      <PulseSidebar
        title={selectedBase()?.name ?? t().appName}
        bases={bases()}
        baseId={props.initialBaseId}
        activeView={activeView()}
        sourceCount={sources().length}
        settingsDisabled={!selectedBase() || loading()}
        openSettings={openSettings}
        openSources={openSources}
        openComingBack={() => navigate({ view: "coming-back" })}
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="gap-2 p-[var(--ui-space-shell)]">
          <Show when={readError()}>
            {(error) => (
              <NoticeCard tone="danger" title={t().pulseDataRefreshFailed} detail={error().message}>
                <Button variant="secondary" onClick={() => void refresh().catch(() => {})}>
                  {t().retry}
                </Button>
              </NoticeCard>
            )}
          </Show>
          <Show when={activeView() === "sources"} fallback={<ComingBackView openSources={openSources} />}>
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
  );
}
