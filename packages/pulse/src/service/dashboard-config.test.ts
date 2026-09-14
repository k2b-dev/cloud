import { describe, expect, test } from "bun:test";
import type { PulseDashboardConfig } from "../contracts";
import {
  compileDashboardConfigForSave,
  dashboardEventsWidgets,
  dashboardMapWidgets,
  dashboardMetricWidgets,
  dashboardRenderConfig,
  dashboardStatesWidgets,
  normalizeDashboardConfig,
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

describe("Pulse dashboard config", () => {
  test("drops pre-V1 layout data unless a DSL is present", () => {
    const config = normalizeDashboardConfig({
      layout: {
        version: 1,
        sections: [
          {
            kind: "section",
            title: "Legacy",
            rows: [
              {
                kind: "row",
                cells: [{ kind: "markdown", markdown: "legacy" }],
              },
            ],
          },
        ],
      },
    });

    expect(config).toEqual({ dsl: "", layout: null });
  });

  test("normalizes dashboard config from raw persisted JSON", () => {
    const config = normalizeDashboardConfig(
      JSON.stringify({
        dsl: dashboardDsl,
        refreshIntervalSeconds: 7,
        layout: {
          version: 1,
          controls: [
            {
              id: "range-control",
              kind: "range",
              label: " Range ",
              variable: " range ",
              defaultValue: " 1h ",
              options: [" 1h ", "", "6h"],
            },
            { kind: "unknown", label: "Broken", variable: "broken" },
          ],
          sections: [
            {
              id: "main",
              kind: "section",
              title: " Main ",
              rows: [
                {
                  id: "row-1",
                  kind: "row",
                  height: "huge",
                  cells: [
                    {
                      id: "metric-1",
                      kind: "metric",
                      title: " CPU ",
                      metric: "system.cpu.usage",
                      visual: "unknown",
                      aggregation: "unknown",
                      bucket: "bad",
                      since: "bad",
                      span: 99,
                      dimensions: { z: "last", a: "first", empty: null },
                      query: {
                        kind: "metric",
                        metric: "system.cpu.usage",
                        aggregation: "max",
                        bucket: "1m",
                        since: "6h",
                        dimensions: { host: "macbook" },
                      },
                      conditions: [
                        { level: "warn", operator: ">", value: 80, message: " high " },
                        { level: "info", operator: ">", value: 80 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    expect(config.refreshIntervalSeconds).toBeUndefined();
    expect(config.layout?.controls).toHaveLength(1);
    expect(config.layout?.controls?.[0]).toMatchObject({
      kind: "range",
      variable: "range",
      label: "Range",
      defaultValue: "1h",
      options: ["1h", "6h"],
    });

    const widget = config.layout?.sections[0]?.rows[0]?.cells[0];
    expect(widget?.kind).toBe("metric");
    if (widget?.kind !== "metric") return;
    expect(widget).toMatchObject({
      title: "CPU",
      visual: "line",
      aggregation: "avg",
      bucket: "5m",
      since: "24h",
      span: 12,
      dimensions: { a: "first", z: "last" },
      conditions: [{ level: "warn", operator: ">", value: 80, message: "high" }],
    });
    expect(widget.query).toMatchObject({
      aggregation: "max",
      bucket: "1m",
      since: "6h",
      dimensions: { host: "macbook" },
    });
  });

  test("compiles DSL before save and exposes all widget query types recursively", () => {
    const compiled = compileDashboardConfigForSave("base", { dsl: dashboardDsl, refreshIntervalSeconds: 5 });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    expect(compiled.data.refreshIntervalSeconds).toBe(5);
    expect(dashboardMetricWidgets(compiled.data).map((widget) => widget.metric)).toEqual(["system.cpu.usage"]);
    expect(dashboardEventsWidgets(compiled.data).map((widget) => widget.query.event)).toEqual(["deploy.finished"]);
    expect(dashboardStatesWidgets(compiled.data).map((widget) => widget.query.state)).toEqual(["service.online"]);
  });

  test("normalizes map selectors and rejects unsafe selector roles", () => {
    const config = normalizeDashboardConfig({
      dsl: 'dashboard "Map" {}',
      layout: {
        version: 1,
        sections: [
          {
            kind: "section",
            title: "Engagement",
            rows: [
              {
                kind: "row",
                cells: [
                  {
                    kind: "map",
                    title: "QR scans",
                    query: {
                      kind: "events",
                      event: "qr.opened",
                      since: "24h",
                    },
                    latitude: { role: "attribute", path: " geo.latitude " },
                    longitude: { role: "dimension", path: "longitude" },
                    label: { role: "sensitive", path: "ip_address" },
                    series: { role: "attribute", path: "campaign.name" },
                    size: "sum",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const widgets = dashboardMapWidgets(config);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({
      title: "QR scans",
      latitude: { role: "attribute", path: "geo.latitude" },
      longitude: { role: "dimension", path: "longitude" },
      series: { role: "attribute", path: "campaign.name" },
      size: "sum",
    });
    expect(widgets[0]?.label).toBeUndefined();
  });

  test("rejects saving dashboards without DSL", () => {
    const result = compileDashboardConfigForSave("base", { layout: { version: 1, sections: [] } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Dashboard DSL is required");
  });

  test("renders compiled config when only DSL is persisted", () => {
    const dashboard = {
      id: "dashboard",
      baseId: "base",
      name: "Ops",
      publicEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      config: { dsl: dashboardDsl, layout: null } satisfies PulseDashboardConfig,
    };

    const config = dashboardRenderConfig(dashboard);

    expect(config.layout?.sections.map((section) => section.title)).toEqual(["Main", "Nested"]);
    expect(dashboardMetricWidgets(config)).toHaveLength(1);
  });
});
