import type { Result } from "./model";

/** A small Mail result for summary and schema tests. */
export function exampleResult(): Result {
  return {
    schemaVersion: 1,
    kind: "mail",
    metadata: {
      commit: "abc",
      dirty: true,
      timestamp: "2026-10-01T00:00:00Z",
      bunVersion: "1",
      runtimeImage: "bun",
      cpuCount: 8,
      cpuModel: "Test CPU",
      loadAverage: { start: [1, 2, 3], end: [2, 3, 4] },
      runs: 2,
      fixture: { seed: 1, anchor: "2026-10-01T00:00:00Z", messages: 600, conversations: 120, folders: 6 },
      fixtureDigest: "digest",
      shape: {},
      seedDurationMs: 1,
      bm25: false,
      pgTextsearch: false,
      postgresVersion: "17",
      origin: "https://localhost:4000",
    },
    idle: null,
    browser: null,
    notes: ["No provider connection"],
    errors: [],
    scenarios: [
      {
        id: "detail-small",
        group: "Details",
        status: "ok",
        errors: [],
        notes: [],
        database: null,
        plan: null,
        planError: null,
        unparsedPlans: 0,
        metrics: null,
        samples: [10, 20, 40].map((totalMs) => ({
          totalMs,
          ttfbMs: totalMs / 2,
          rawBytes: 100,
          brotliBytes: 30,
          propsBytes: 10,
          requests: [],
        })),
      },
    ],
  };
}
