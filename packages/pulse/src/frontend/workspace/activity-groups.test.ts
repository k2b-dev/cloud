import { describe, expect, test } from "bun:test";
import type { PulseCurrentState, PulseRecordedEvent } from "../../contracts";
import { buildActivityEventGroups, buildActivityStateGroups } from "./activity-groups";

const event = (overrides: Partial<PulseRecordedEvent>): PulseRecordedEvent => ({
  id: "event-1",
  kind: "deploy.finished",
  ts: "2026-07-10T10:00:00.000Z",
  value: null,
  sourceId: "source-a",
  resourceKey: "service:api",
  resourceType: "service",
  dimensions: {},
  attributes: {},
  payload: {},
  recordedAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const state = (overrides: Partial<PulseCurrentState>): PulseCurrentState => ({
  variantKey: "fixture-0",
  key: "service.online",
  value: true,
  sourceId: "source-a",
  resourceKey: "service:api",
  resourceType: "service",
  dimensions: {},
  updatedAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

describe("Pulse activity grouping helpers", () => {
  test("groups events by kind and subject and keeps newest rows first", () => {
    const groups = buildActivityEventGroups([
      event({ id: "old-api", ts: "2026-07-10T10:00:00.000Z", resourceKey: "service:api" }),
      event({ id: "new-api", ts: "2026-07-10T10:05:00.000Z", resourceKey: "service:api" }),
      event({ id: "worker", ts: "2026-07-10T10:03:00.000Z", resourceKey: "service:worker" }),
    ]);

    expect(groups.map((group) => group.subject)).toEqual(["service:api", "service:worker"]);
    expect(groups[0]?.latest.id).toBe("new-api");
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["new-api", "old-api"]);
  });

  test("groups states by key and source and keeps newest rows first", () => {
    const groups = buildActivityStateGroups([
      state({ value: "old-api", updatedAt: "2026-07-10T10:00:00.000Z", resourceKey: "service:api" }),
      state({ value: "new-api", updatedAt: "2026-07-10T10:05:00.000Z", resourceKey: "service:api" }),
      state({ value: "worker", updatedAt: "2026-07-10T10:03:00.000Z", resourceKey: "service:worker", sourceId: "source-b" }),
    ]);

    expect(groups.map((group) => group.sourceId)).toEqual(["source-a", "source-b"]);
    expect(groups[0]?.latest.value).toBe("new-api");
    expect(groups[0]?.rows.map((row) => row.value)).toEqual(["new-api", "old-api"]);
  });
});
