import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PulseWorkspaceProps } from "./workspace/types";

const root = mkdtempSync(join(tmpdir(), "pulse-workspace-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
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
const render = (view: "sources" | "coming-back", locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PulseWorkspace, { ...props, initialRouteState: { view, sourceId: "" } });
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

test("one in-place hint renders in each locale with a sources action", () => {
  for (const [locale, title, action] of [
    ["en", "Dashboards and questions are coming back", "Go to sources"],
    ["de", "Dashboards und Fragen kommen zurück", "Zu den Quellen"],
  ] as const) {
    const html = render("coming-back", locale);
    expect(html.split(title)).toHaveLength(2);
    expect(html).toContain(action);
    expect(html).not.toContain("Warehouse importer");
    expect(html).not.toContain("<hr");
  }
});
