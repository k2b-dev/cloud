import type { PulseBase, PulseSource, PulseSourceScrape } from "../contracts";
import { compactId, formatDate, yesNo } from "./shared";
import type { PulseSourceApiKey } from "./types";

export const baseRows = (bases: PulseBase[]) =>
  bases.map((base) => ({
    id: compactId(base.id),
    name: base.name,
    rawRetentionDays: base.rawRetentionDays,
    rollupRetentionDays: base.rollupRetentionDays,
    sensitiveRetentionHours: base.sensitiveRetentionHours,
    deletion: base.deletionStartedAt ? (base.deletionFailedAt ? "failed" : "running") : "",
    updatedAt: base.updatedAt,
  }));

export const sourceRows = (sources: PulseSource[]) =>
  sources.map((source) => ({
    id: compactId(source.id),
    name: source.name,
    kind: source.kind,
    enabled: yesNo(source.enabled),
    endpoint: source.endpointUrl ?? "",
    interval: source.scrapeIntervalSeconds ?? "",
    token: yesNo(source.bearerTokenConfigured),
    lastSeenAt: formatDate(source.lastSeenAt),
  }));

export const scrapeRows = (scrapes: PulseSourceScrape[]) =>
  scrapes.map((scrape) => ({
    id: compactId(scrape.id),
    success: yesNo(scrape.success),
    finishedAt: scrape.finishedAt,
    durationMs: scrape.durationMs,
    data: `${scrape.metrics} metrics, ${scrape.events} events, ${scrape.states} states`,
    error: scrape.errorMessage ?? "",
  }));

export const keyRows = (keys: PulseSourceApiKey[]) =>
  keys.map((key) => ({
    id: compactId(key.id),
    name: key.name,
    prefix: key.tokenPrefix,
    permission: key.permission,
    expiresAt: formatDate(key.expiresAt),
    lastUsedAt: formatDate(key.lastUsedAt),
    createdAt: key.createdAt,
  }));
