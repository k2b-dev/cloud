import { describe, expect, test } from "bun:test";
import {
  compileDashboardConfigForSave,
  dashboardEventsWidgets,
  dashboardMetricWidgets,
  dashboardSource,
  dashboardStatesWidgets,
  readDashboardConfig,
} from "./dashboard-config";

const dashboardDsl = `dashboard "Ops" {
  controls {
    range "Range" variable range default 1h options 1h, 6h
  }

  section "Main" {
    card "Status" {
      gauge "CPU" {
        query metric system.cpu.usage latest since $range
      }
    }

    table "Events" {
      query events deploy.finished since 24h limit 25
    }
  }

  section "Nested" {
    section "Inner" {
      table "States" {
        query states service.online resource_type service limit 50
      }
    }
  }
}`;

describe("canonical dashboard source", () => {
  test("rejects historical and malformed persisted shapes without repair", () => {
    for (const value of [
      null,
      {},
      JSON.stringify({ dsl: dashboardDsl }),
      { dsl: dashboardDsl, layout: {} },
      { dsl: dashboardDsl, refreshIntervalSeconds: 7 },
      { dsl: "x".repeat(40001) },
    ]) {
      expect(compileDashboardConfigForSave("base", value).ok).toBe(false);
      expect(() => readDashboardConfig("base", value)).toThrow();
    }
  });
  test("compiles source deterministically and only persists author input", () => {
    const config = readDashboardConfig("base", { dsl: dashboardDsl, refreshIntervalSeconds: 5 });
    expect(dashboardSource(config)).toEqual({ dsl: dashboardDsl, refreshIntervalSeconds: 5 });
    expect(readDashboardConfig("base", dashboardSource(config))).toEqual(config);
    expect(dashboardMetricWidgets(config)[0]?.query).toMatchObject({ kind: "metric", metric: "system.cpu.usage", since: "1h" });
    expect(dashboardMetricWidgets(config)[0]?.queryText).toContain("$range");
    expect(dashboardEventsWidgets(config)).toHaveLength(1);
    expect(dashboardStatesWidgets(config)).toHaveLength(1);
  });
  test("does not shorten valid resource keys", () => {
    const resource = "host:" + "x".repeat(500);
    const config = readDashboardConfig("base", { dsl: `dashboard "Ops" { line "CPU" { query metric cpu latest resource ${resource} } }` });
    expect(dashboardMetricWidgets(config)[0]?.query.resourceKey).toBe(resource);
  });
});

test("uses one explicit data-widget budget and rejects excess instead of slicing", () => {
  const section = (count: number) =>
    `section "S" { ${Array.from({ length: Math.ceil(count / 6) }, (_, row) => `row { ${Array.from({ length: Math.min(6, count - row * 6) }, (_, i) => `line "M${row}-${i}" { query metric cpu avg }`).join("\n")} }`).join("\n")} }`;
  expect(compileDashboardConfigForSave("base", { dsl: `dashboard "Ops" { ${section(18)} ${section(18)} }` }).ok).toBe(true);
  expect(compileDashboardConfigForSave("base", { dsl: `dashboard "Ops" { ${section(18)} ${section(19)} }` }).ok).toBe(false);
});
test("rejects queries longer than the execution API accepts", () => {
  const filters = Array.from({ length: 25 }, (_, i) => `key${i}=${"x".repeat(90)}`).join(", ");
  expect(
    compileDashboardConfigForSave("base", { dsl: `dashboard "Ops" { line "CPU" { query metric cpu avg where ${filters} } }` }).ok,
  ).toBe(false);
});
