import { ButtonLink } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import PulseWorkspace from "../PulseWorkspace.island";
import { loadPulseWorkspacePageData } from "./page-data";
import { pulseMessages } from "../../messages";

export default ssr<AuthContext>(async (c) => {
  const data = await loadPulseWorkspacePageData(c);
  const { t } = pulseMessages.resolve([getLocale(c)]);

  if (data.kind === "not_found") {
    return () => (
      <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/pulse" }, { title: t.notFound }]}>
        <div class="mx-auto flex max-w-4xl flex-col items-center gap-4 py-12">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <i class="ti ti-alert-circle text-sm" />
            {data.errorMessage}
          </p>
          <ButtonLink href="/app/pulse" size="sm">
            {t.backToPulse}
          </ButtonLink>
        </div>
      </Layout>
    );
  }

  const workspaceProps = data.workspaceProps;

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/pulse" }, { title: data.baseName }]}>
      <PulseWorkspace
        initialBases={workspaceProps.initialBases}
        initialCapabilities={workspaceProps.initialCapabilities}
        initialQueryCoverage={workspaceProps.initialQueryCoverage}
        initialBaseId={workspaceProps.initialBaseId}
        initialPath={workspaceProps.initialPath}
        initialSearch={workspaceProps.initialSearch}
        initialRouteState={workspaceProps.initialRouteState}
        initialActivityQuery={workspaceProps.initialActivityQuery}
        initialResourceQuery={workspaceProps.initialResourceQuery}
        initialSources={workspaceProps.initialSources}
        initialSourceScrapes={workspaceProps.initialSourceScrapes}
        initialSourceApiKeys={workspaceProps.initialSourceApiKeys}
        initialMetrics={workspaceProps.initialMetrics}
        initialInventory={workspaceProps.initialInventory}
        initialActivityMetrics={workspaceProps.initialActivityMetrics}
        initialSeries={workspaceProps.initialSeries}
        initialRecentEvents={workspaceProps.initialRecentEvents}
        initialCurrentStates={workspaceProps.initialCurrentStates}
        initialFocusedMetricSeries={workspaceProps.initialFocusedMetricSeries}
        initialFocusedEvents={workspaceProps.initialFocusedEvents}
        initialFocusedStates={workspaceProps.initialFocusedStates}
        initialFocusedHasMore={workspaceProps.initialFocusedHasMore}
        initialDashboards={workspaceProps.initialDashboards}
        initialDashboardControlValues={workspaceProps.initialDashboardControlValues}
        initialSavedQueries={workspaceProps.initialSavedQueries}
        initialMetricWidgetPoints={workspaceProps.initialMetricWidgetPoints}
        initialDashboardEvents={workspaceProps.initialDashboardEvents}
        initialDashboardStates={workspaceProps.initialDashboardStates}
        initialDashboardMaps={workspaceProps.initialDashboardMaps}
        initialExplorerPanesLayout={workspaceProps.initialExplorerPanesLayout}
        initialDashboardEditorPanesLayout={workspaceProps.initialDashboardEditorPanesLayout}
        initialDateConfig={workspaceProps.initialDateConfig}
        initialNow={workspaceProps.initialNow}
        initialOrigin={workspaceProps.initialOrigin}
      />
    </Layout>
  );
});
