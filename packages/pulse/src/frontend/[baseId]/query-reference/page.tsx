import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { getRuntimeContext } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../config";
import { pulseService } from "../../../service";
import { projectPublicRelations, projectSources, resolvePublicId } from "../../../service/public-resources";
import PulseQueryReferenceWindow from "../../PulseQueryReferenceWindow.island";
import { readReferenceTab } from "../../query-reference-tabs";
import { pulseMessages } from "../../../messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = pulseMessages.resolve([getLocale(c)]);
  c.get("page").title = t.pulseQueryReference;
  const user = expectUserBackedActor(c);
  const publicBaseId = c.req.param("baseId") ?? "";
  const baseId = await resolvePublicId("bases", publicBaseId);
  const includeDashboardDsl = c.req.query("dashboardDsl") === "1";
  const initialTab = readReferenceTab(c.req.query("tab") ?? null, includeDashboardDsl);
  const baseResult = baseId ? await pulseService.base.get(baseId, user) : null;

  if (!baseResult?.ok) return ssr.error(c, baseResult && !baseResult.ok ? baseResult.error.status : 404, { layout: "minimal" });

  const [metricsResult, eventsResult, statesResult, sourcesResult, fieldsResult] = await Promise.all([
    pulseService.query.metrics(baseResult.data.id, user, {}),
    pulseService.query.recentEvents(baseResult.data.id, user, {}),
    pulseService.query.currentStates(baseResult.data.id, user, {}),
    pulseService.source.list(baseResult.data.id, user),
    pulseService.query.fields(baseResult.data.id, user, { limit: 500 }),
  ]);
  const metrics = metricsResult.ok ? metricsResult.data : [];
  const seriesResults = await Promise.all(
    metrics.map((metric) => pulseService.query.series(baseResult.data.id, user, { metric: metric.name })),
  );
  const series = seriesResults.flatMap((result) => (result.ok ? result.data : []));
  const [sources, publicEvents, publicStates, publicSeries, publicFields] = await Promise.all([
    projectSources(sourcesResult.ok ? sourcesResult.data : []),
    projectPublicRelations(eventsResult.ok ? eventsResult.data : []),
    projectPublicRelations(statesResult.ok ? statesResult.data : []),
    projectPublicRelations(series),
    projectPublicRelations(fieldsResult.ok ? fieldsResult.data : []),
  ]);
  const helpDocuments = getRuntimeContext(c).apps.find((registeredApp) => registeredApp.id === "pulse")?.help?.documents ?? [];

  return () => (
    <PulseQueryReferenceWindow
      baseName={baseResult.data.name}
      includeDashboardDsl={includeDashboardDsl}
      initialTab={initialTab}
      metrics={metrics}
      events={publicEvents}
      states={publicStates}
      sources={sources}
      series={publicSeries}
      fields={publicFields}
      documents={helpDocuments}
    />
  );
});
