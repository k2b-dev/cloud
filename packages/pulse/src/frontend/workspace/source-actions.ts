import type { PulseSource } from "../../contracts";
import { jsonFetch } from "../http";
import { formatIngestCounts, normalizeEndpointInput, parseScrapeInterval } from "./source-helpers";
import type { CreateSourceInput } from "./types";

type IngestCounts = {
  events: number;
  metrics: number;
  states: number;
};

type SourceCreateRequest =
  | {
      bearerToken: string | null;
      endpointUrl: string;
      kind: "metrics";
      name: string;
      scrapeIntervalSeconds: number;
      metricFilters?: string[];
    }
  | {
      kind: "http_ingest";
      name: string;
      expectEverySeconds?: number | null;
      expectDailyBy?: string | null;
    };

export const sourceCreateRequest = (input: CreateSourceInput): SourceCreateRequest => {
  const name = input.name.trim() || (input.kind === "http_ingest" ? "Telemetry push" : "Metrics endpoint");
  if (input.kind === "metrics") {
    return {
      kind: "metrics",
      name,
      endpointUrl: normalizeEndpointInput(String(input.endpointUrl ?? "").trim()),
      bearerToken: input.bearerToken?.trim() || null,
      metricFilters: input.metricFilters,
      scrapeIntervalSeconds: parseScrapeInterval(String(input.scrapeIntervalSeconds ?? 60)),
    };
  }
  return {
    kind: input.kind,
    name,
    ...(input.expectEverySeconds !== undefined ? { expectEverySeconds: input.expectEverySeconds } : {}),
    ...(input.expectDailyBy !== undefined ? { expectDailyBy: input.expectDailyBy } : {}),
  };
};

export const sourceCreateValidationError = (input: CreateSourceInput): string | null => {
  if (input.kind !== "metrics") return null;
  return String(input.endpointUrl ?? "").trim() ? null : "Endpoint URL is required";
};

export const sourceCreatedMessage = (kind: CreateSourceInput["kind"]): string =>
  `${kind === "http_ingest" ? "HTTP ingest" : "Metrics"} source created`;

export const sourceInitialScrapeSuccessMessage = (counts: IngestCounts): string =>
  `Metrics source added and scraped: ${formatIngestCounts(counts)}`;

export const sourceInitialScrapeFailureMessage = (error: unknown): string =>
  error instanceof Error ? `Source added, initial scrape failed: ${error.message}` : "Source added, initial scrape failed";

export class SourceCreateError extends Error {
  constructor(
    readonly kind: "rejected" | "uncertain",
    message: string,
  ) {
    super(message);
  }
}

export const createPulseSource = (baseId: string, input: CreateSourceInput, signal?: AbortSignal): Promise<PulseSource> =>
  jsonFetch<PulseSource>(
    `/api/pulse/bases/${baseId}/sources`,
    {
      method: "POST",
      body: JSON.stringify(sourceCreateRequest(input)),
      signal,
    },
    "REQUEST_FAILED",
    (status, body) =>
      new SourceCreateError(
        status >= 500 || status === 408 ? "uncertain" : "rejected",
        body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "REQUEST_FAILED",
      ),
  );

export const scrapePulseSourceOnce = (baseId: string, sourceId: string, signal?: AbortSignal): Promise<IngestCounts> =>
  jsonFetch<IngestCounts>(`/api/pulse/bases/${baseId}/sources/${sourceId}/scrape`, {
    method: "POST",
    body: "{}",
    signal,
  });
