import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { PulseWorkspaceProps } from "./workspace/types";

const root = mkdtempSync(join(tmpdir(), "pulse-workspace-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: PulseWorkspace } = await import("./PulseWorkspace.island");

const props: PulseWorkspaceProps = {
  initialBaseId: "Base01",
  initialBases: [],
  initialRouteState: { view: "sources", sourceId: "" },
  initialSources: [
    {
      id: "Src001",
      baseId: "Base01",
      kind: "http_ingest",
      name: "Warehouse importer",
      enabled: true,
      endpointUrl: null,
      bearerTokenConfigured: false,
      scrapeIntervalSeconds: null,
      metricFilters: [],
      revision: 1,
      expectEverySeconds: null,
      expectDailyBy: null,
      staleSince: null,
      status: {
        newestDataAt: null,
        throttled: false,
        throttledAt: null,
        refusedHistograms: [],
        skippedSummaries: 0,
        lastError: null,
        lastErrorAt: null,
      },
      lastSeenAt: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  initialSourceScrapes: {},
  initialSourceApiKeys: {},
  initialQueryCoverage: { bases: true, baseData: true, sourceDetail: true },
  initialDateConfig: { locale: "en", timeZone: "UTC", firstDayOfWeek: 1 },
  initialNow: "2026-01-01T00:00:00.000Z",
  initialOrigin: "https://cloud.example.test",
};
const render = (view: "sources", locale = "en", extra: Partial<PulseWorkspaceProps> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PulseWorkspace, {
          ...props,
          initialRouteState: { view, sourceId: "" },
          ...extra,
        });
      },
    }),
  );

test("sources render from their server snapshot without measurement counts or removed readers", () => {
  const html = render("sources");
  expect(html).toContain("Warehouse importer");
  expect(html).toContain('class="ti ti-plus"');
  expect(html).not.toContain("Query explorer");
  expect(html).not.toContain("Resources");
  expect(html).not.toContain("Signals");
  expect(html).not.toContain("No sources");
});

test("the sidebar offers sources, SQL and settings, but no overview or dashboards", () => {
  for (const [locale, gone] of [
    ["en", ["Overview", "Dashboards", "No dashboard yet"]],
    ["de", ["Übersicht", "Dashboards", "Noch kein Dashboard"]],
  ] as const) {
    const html = render("sources", locale);
    expect(html).toContain("SQL");
    for (const text of gone) expect(html).not.toContain(text);
  }
});

test("an old dashboard link opens the base with a notice the server renders, and only then", () => {
  for (const [locale, title, dismiss] of [
    ["en", "Dashboards are gone", "Got it"],
    ["de", "Dashboards gibt es nicht mehr", "Verstanden"],
  ] as const) {
    const html = render("sources", locale, { initialNotice: "dashboards-removed" });
    expect(html).toContain(title);
    expect(html).toContain("in Code");
    expect(html).toContain(dismiss);
    expect(html).toContain("Warehouse importer");
    expect(render("sources", locale)).not.toContain(title);
  }
});

test("SQL console SSR renders the same initial draft as the controller without browser effects", async () => {
  const { default: SqlConsoleView } = await import("./workspace/SqlConsoleView");
  for (const [locale, title, save, helper] of [
    ["en", "New query", "Save as", "SQL helpers: bucket, rate, increase, histogram_quantile"],
    ["de", "Neue Abfrage", "Speichern unter", "SQL-Hilfen: bucket, rate, increase, histogram_quantile"],
  ] as const) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(SqlConsoleView, {
            base: { id: "Base01", name: "Operations" },
            route: { view: "sql", sourceId: "", sql: "SELECT 123", params: {} },
            snapshot: undefined,
            canWrite: false,
          });
        },
      }),
    );
    expect(html).toMatch(/<textarea[^>]*>\nSELECT 123<\/textarea>/);
    expect(html).toContain(title);
    expect(html).not.toContain(save);
    expect(html).toContain(helper);
  }
});

const firedAlert = {
  reference: "Alt001",
  name: "Orders too low",
  state: "firing" as const,
  severity: "critical" as const,
  since: "2025-12-31T23:30:00.000Z",
  lastCheckedAt: "2025-12-31T23:58:00.000Z",
  errorCode: null,
  key: "orders",
  value: 0,
  comparison: "below" as const,
  threshold: 2,
};

test("Sources lists fired alerts and a lost store from the server read", () => {
  const attention = { readAt: "2026-01-01T00:00:00.000Z", store: { unavailable: false, since: null }, alerts: [firedAlert] };
  const list = render("sources", "en", { initialAttention: attention });
  expect(list).toContain("Needs attention");
  expect(list).toContain("Alert “Orders too low” fired");
  expect(list).toContain("Critical");
  expect(list).toContain("Fires when the value is below 2.");
  expect(list).toContain("Adjust with Gustav");
  expect(list).toContain('href="/app/pulse/Base01/sql?alert=Alt001"');
  expect(list).toContain("Warehouse importer");
  expect(render("sources", "en")).not.toContain("Needs attention");
  // An outage of the store comes from the read, not from a failed base store.
  const down = render("sources", "de", {
    initialAttention: { ...attention, alerts: [], store: { unavailable: true, since: "2025-12-31T23:05:00.000Z" } },
  });
  expect(down).toContain("Datenspeicher nicht erreichbar");
  expect(down).toContain("Pulse prüft das automatisch");
  expect(render("sources", "de")).not.toContain("Datenspeicher nicht erreichbar");
});
