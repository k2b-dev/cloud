import { describe, expect, test } from "bun:test";
import {
  sourceCreatedMessage,
  sourceCreateRequest,
  sourceCreateValidationError,
  sourceInitialScrapeFailureMessage,
  sourceInitialScrapeSuccessMessage,
} from "./helpers";

describe("Pulse source helpers", () => {
  test("builds source create request payloads", () => {
    expect(sourceCreateRequest({ kind: "http_ingest", name: "" })).toEqual({ kind: "http_ingest", name: "Telemetry push" });
    expect(
      sourceCreateRequest({
        kind: "metrics",
        name: " API ",
        endpointUrl: "api.example.test/metrics",
        bearerToken: " secret ",
        scrapeIntervalSeconds: 5,
      }),
    ).toEqual({
      kind: "metrics",
      name: "API",
      endpointUrl: "https://api.example.test/metrics",
      bearerToken: "secret",
      scrapeIntervalSeconds: 60,
    });
    expect(
      sourceCreateRequest({
        kind: "metrics",
        name: "",
        endpointUrl: "http://localhost:9100/metrics",
        scrapeIntervalSeconds: 999_999,
      }),
    ).toEqual({
      kind: "metrics",
      name: "Metrics endpoint",
      endpointUrl: "http://localhost:9100/metrics",
      bearerToken: null,
      scrapeIntervalSeconds: 86_400,
    });
  });

  test("normalizes source creation validation and messages", () => {
    expect(sourceCreateValidationError({ kind: "http_ingest", name: "" })).toBeNull();
    expect(sourceCreateValidationError({ kind: "metrics", name: "API", endpointUrl: "" })).toBe("Endpoint URL is required");
    expect(sourceCreatedMessage("http_ingest")).toBe("HTTP ingest source created");
    expect(sourceCreatedMessage("metrics")).toBe("Metrics source created");
    expect(sourceInitialScrapeSuccessMessage({ metrics: 2, events: 1, states: 0 })).toBe(
      "Metrics source added and scraped: 2 metrics, 1 event, 0 states",
    );
    expect(sourceInitialScrapeFailureMessage(new Error("No route"))).toBe("Source added, initial scrape failed: No route");
    expect(sourceInitialScrapeFailureMessage("bad")).toBe("Source added, initial scrape failed");
  });
});

test("HTTP source requests carry explicit expectations while metrics keep their interval contract", () => {
  expect(sourceCreateRequest({ kind: "http_ingest", name: "Backup", expectEverySeconds: null, expectDailyBy: "04:00" })).toEqual({
    kind: "http_ingest",
    name: "Backup",
    expectEverySeconds: null,
    expectDailyBy: "04:00",
  });
  expect(sourceCreateRequest({ kind: "http_ingest", name: "Backup", expectEverySeconds: 300, expectDailyBy: null })).toEqual({
    kind: "http_ingest",
    name: "Backup",
    expectEverySeconds: 300,
    expectDailyBy: null,
  });
  const metrics = sourceCreateRequest({
    kind: "metrics",
    name: "CPU",
    endpointUrl: "https://example.test/metrics",
    expectEverySeconds: 300,
    expectDailyBy: "04:00",
  });
  expect(metrics).not.toHaveProperty("expectEverySeconds");
  expect(metrics).not.toHaveProperty("expectDailyBy");
});
