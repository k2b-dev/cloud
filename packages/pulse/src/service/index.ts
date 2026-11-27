import { fail, type Result } from "@k2b/cloud/server";
import { type AccessScope, requireBaseAccess } from "./access-control";
import {
  clearBaseData,
  createBase,
  deleteBase,
  getBase,
  grantBaseAccess,
  listBaseAccess,
  listBases,
  listDeletingBases,
  revokeBaseAccess,
  updateBase,
  updateBaseAccess,
} from "./base-management";
import { sourceHour } from "./fetch-timeline";
import { ingestBatch, ingestByApiKey } from "./ingest-writer";
import { runMetricsSourceScrape } from "./metrics-scraper";
import { sourceAlerts } from "./source-alerts";
import { sourceHistory } from "./source-history";
import {
  countSources,
  createSource,
  createSourceApiKey,
  getSource,
  listSourceApiKeys,
  listSourceScrapes,
  listSources,
  removeSource,
  removeSourceApiKey,
  sourceFigures,
  updateSource,
} from "./source-management";

export const scrapeMetricsSource = async (params: {
  baseId: string;
  sourceId: string;
  slotTs?: number;
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

export const pulseService = {
  base: {
    list: listBases,
    listDeleting: listDeletingBases,
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
    count: countSources,
    figures: sourceFigures,
    get: getSource,
    scrapes: listSourceScrapes,
    hour: sourceHour,
    alerts: sourceAlerts,
    history: sourceHistory,
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
  ingest: {
    batch: ingestBatch,
    byApiKey: ingestByApiKey,
  },
};
