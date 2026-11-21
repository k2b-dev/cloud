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
const render = (view: "sources", locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PulseWorkspace, {
          ...props,
          initialRouteState: { view, sourceId: "" },
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
