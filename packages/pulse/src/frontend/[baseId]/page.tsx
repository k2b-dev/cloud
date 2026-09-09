import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import PulseWorkspace from "../PulseWorkspace.island";
import { loadPulseWorkspacePageData } from "./page-data";
import { pulseMessages } from "../../messages";

export default ssr<AuthContext>(async (c) => {
  const data = await loadPulseWorkspacePageData(c);
  const { t } = pulseMessages.resolve([getLocale(c)]);

  if (data.kind === "error") {
    return ssr.error(c, data.status, { action: { label: t.backToPulse, href: "/app/pulse" } });
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
