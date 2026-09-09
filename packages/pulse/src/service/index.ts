import { fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type {
  PulseCapabilitySnapshot,
  PulseDashboardDslCompileResult,
  PulseDashboardSnapshot,
  PulseEvent,
  PulseIngestBatch,
  PulseMetric,
  PulseState,
} from "../contracts";
import { compileDashboardDsl } from "../dashboard-dsl";
import { compilePulseQueryText } from "../query-dsl";
import { type AccessScope, requireBaseAccess } from "./access-control";
import {
  clearBaseData,
  createBase,
  deleteBase,
  getBase,
  grantBaseAccess,
  listBaseAccess,
  listBases,
  revokeBaseAccess,
  updateBase,
  updateBaseAccess,
} from "./base-management";
import { normalizeDashboardConfig, validateDashboardSources } from "./dashboard-config";
import {
  createDashboard,
  deleteDashboard,
  disablePublicDashboard,
  enablePublicDashboard,
  listDashboards,
  updateDashboard,
} from "./dashboard-management";
import { queryEventMapData } from "./event-map-query";
import { ingestBatch, ingestByApiKey, recordEvent, recordMetric, setState } from "./ingest-writer";
import { runMetricsSourceScrape } from "./metrics-scraper";
import {
  getDashboardSnapshot as getDashboardSnapshotWithDeps,
  getPublicDashboardSnapshot as getPublicDashboardSnapshotWithDeps,
} from "./public-dashboard-snapshot";
import { queryEventAggregateData, queryEventsData, queryMetricData, queryStatesData } from "./query-execution";
import {
  compileQueryText,
  executeCompiledQuery,
  executeDashboardTextQueries,
  queryEventMapText,
  queryMetric,
  queryMetricText,
} from "./query-management";
import { createSavedQuery, deleteSavedQuery, getSavedQuery, listSavedQueries, readSavedQuery } from "./saved-query-management";
import {
  getResource,
  listCurrentStates,
  listInventory,
  listMetricSeries,
  listMetrics,
  listRecentEvents,
  listResourceEvents,
  listResourceMetrics,
  listResourceStates,
  listResources,
  listSignalFields,
  searchResources,
} from "./signal-catalog";
import {
  createSource,
  createSourceApiKey,
  getSource,
  listSourceApiKeys,
  listSourceScrapes,
  listSources,
  removeSource,
  removeSourceApiKey,
  updateSource,
} from "./source-management";

const programmaticPulse = {
  recordMetric: (params: { baseId: string; sourceId?: string | null; metric: PulseMetric }) => recordMetric(params),
  emitEvent: (params: { baseId: string; sourceId?: string | null; event: PulseEvent }) => recordEvent(params),
  setState: (params: { baseId: string; sourceId?: string | null; state: PulseState }) => setState(params),
  batch: (params: { baseId: string; sourceId?: string | null; batch: PulseIngestBatch }) => ingestBatch(params),
};

export const scrapeMetricsSource = async (params: {
  baseId: string;
  sourceId: string;
}): Promise<Result<{ metrics: number; events: number; states: number }>> => runMetricsSourceScrape(params, { ingestBatch });

const scrapeSource = async (params: {
  baseId: string;
  sourceId: string;
  user: AccessScope;
}): Promise<Result<{ metrics: number; events: number; states: number }>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  return scrapeMetricsSource({ baseId: params.baseId, sourceId: params.sourceId });
};

const compileDashboardDslText = async (params: {
  baseId: string;
  text: string;
  user: AccessScope;
}): Promise<Result<PulseDashboardDslCompileResult>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const compiled = compileDashboardDsl(params.text, (query) => {
    const result = compilePulseQueryText(params.baseId, query);
    return result.ok ? { ok: true, data: result.data } : { ok: false, message: result.error.message };
  });
  if (!compiled.ok) {
    return ok({ ok: false, diagnostics: compiled.diagnostics, config: null });
  }
  const config = normalizeDashboardConfig(compiled.data);
  const validated = await validateDashboardSources(params.baseId, config);
  if (!validated.ok)
    return ok({ ok: false, diagnostics: [{ severity: "error", message: validated.error.message, line: 1, column: 1 }], config: null });
  return ok({ ok: true, diagnostics: compiled.diagnostics, config: validated.data });
};

const getPublicDashboardSnapshot = async (token: string): Promise<Result<PulseDashboardSnapshot>> => {
  return getPublicDashboardSnapshotWithDeps(token, {
    queryMetricData,
    queryEventAggregateData,
    queryEventsData,
    queryStatesData,
    queryEventMapData,
  });
};

const getDashboardSnapshot = async (params: { dashboardId: string; user: AccessScope }): Promise<Result<PulseDashboardSnapshot>> =>
  getDashboardSnapshotWithDeps(params.dashboardId, params.user, {
    queryMetricData,
    queryEventAggregateData,
    queryEventsData,
    queryStatesData,
    queryEventMapData,
  });

const capabilities = async (): Promise<Result<PulseCapabilitySnapshot>> => {
  const [extension] = await sql<{ installed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
    ) AS installed
  `;
  const enabled = extension?.installed === true;
  return ok({
    timescaleEnabled: enabled,
    timeBucketAvailable: enabled,
    continuousAggregatesAvailable: enabled,
  });
};

export const pulseService = {
  base: {
    list: listBases,
    create: createBase,
    get: getBase,
    update: updateBase,
    remove: deleteBase,
    clearData: clearBaseData,
    access: {
      require: requireBaseAccess,
      list: listBaseAccess,
      grant: grantBaseAccess,
      update: updateBaseAccess,
      revoke: revokeBaseAccess,
    },
  },
  source: {
    list: listSources,
    get: getSource,
    scrapes: listSourceScrapes,
    apiKeys: {
      list: listSourceApiKeys,
      create: createSourceApiKey,
      remove: removeSourceApiKey,
    },
    create: createSource,
    update: updateSource,
    remove: removeSource,
    scrape: scrapeSource,
  },
  dashboard: {
    list: listDashboards,
    create: createDashboard,
    update: updateDashboard,
    remove: deleteDashboard,
    compileDsl: compileDashboardDslText,
    snapshot: getDashboardSnapshot,
    enablePublic: enablePublicDashboard,
    disablePublic: disablePublicDashboard,
    publicSnapshot: getPublicDashboardSnapshot,
  },
  savedQuery: {
    list: listSavedQueries,
    get: getSavedQuery,
    read: readSavedQuery,
    create: createSavedQuery,
    remove: deleteSavedQuery,
  },
  ingest: {
    batch: ingestBatch,
    byApiKey: ingestByApiKey,
    metric: recordMetric,
    event: recordEvent,
    state: setState,
  },
  programmatic: programmaticPulse,
  query: {
    metric: queryMetric,
    metricText: queryMetricText,
    eventMapText: queryEventMapText,
    compileText: compileQueryText,
    executeCompiled: executeCompiledQuery,
    dashboardTexts: executeDashboardTextQueries,
    metrics: listMetrics,
    series: listMetricSeries,
    recentEvents: listRecentEvents,
    currentStates: listCurrentStates,
    fields: listSignalFields,
    inventory: listInventory,
    resources: listResources,
    resource: getResource,
    searchResources,
    resourceMetrics: listResourceMetrics,
    resourceEvents: listResourceEvents,
    resourceStates: listResourceStates,
  },
  capabilities,
};
