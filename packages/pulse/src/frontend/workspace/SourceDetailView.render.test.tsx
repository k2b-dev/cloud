import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PulseSource, PulseSourceScrape } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "pulse-source-detail-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SourceDetailView } = await import("./SourceDetailView");

const source: PulseSource = {
  id: "source-1",
  baseId: "base-1",
  kind: "metrics",
  name: "Shop exporter",
  enabled: true,
  endpointUrl: "https://shop.example.test/metrics",
  bearerTokenConfigured: true,
  scrapeIntervalSeconds: 60,
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
};

const scrape: PulseSourceScrape = {
  id: "scrape-1",
  sourceId: "source-1",
  startedAt: "2026-01-02T10:00:00.000Z",
  finishedAt: "2026-01-02T10:00:01.000Z",
  durationMs: 120,
  success: true,
  metrics: 12,
  events: 0,
  states: 0,
  errorMessage: null,
};

const noop = () => undefined;
const render = (overrides: Partial<PulseSource> = {}, locale = "en", scrapes: PulseSourceScrape[] = [scrape]) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SourceDetailView, {
          source: { ...source, ...overrides },
          origin: "https://cloud.example.test",
          dateContext: { locale: "en", timeZone: "UTC", now: "2026-01-02T12:00:00.000Z" },
          loading: false,
          scrapes,
          apiKeys: [],
          scrapeColumns: [{ id: "status", header: "Status" }],
          renderScrapeCell: () => "ok",
          copySetupText: noop,
          editSource: noop,
          toggleSource: noop,
          close: noop,
          scrape: noop,
          removeSource: noop,
          createApiKey: async () => {
            throw new Error("not used");
          },
          revokeApiKey: async () => undefined,
        });
      },
    }),
  );

test("a source detail follows the K1 outline: kind and state, one main action, properties, then More about this source", () => {
  const html = render();
  // The kind and state share the first row; no header icon.
  expect(html).toMatch(/class="k2b-detail-panel__kind"><span>Source<\/span>[\s\S]*?k2b-status-badge__label">Enabled</);
  expect(html).not.toContain("ti-database-share");
  // One quiet meta line: the source type and its authentication; the state moved into the badge.
  expect(html).toContain("<p>Metrics endpoint<!--!$--> · Bearer authentication</p>");
  // Edit is the main action in the panel accent; pause, scrape, and remove wait under "…".
  const header = html.slice(0, html.indexOf("</header>"));
  expect(header).toMatch(/class="k2b-button pulse-details-main[^"]*"[^>]*>[\s\S]*?Edit/);
  expect(header).toMatch(
    /role="menu" aria-label="More source actions"[\s\S]*?<span>Pause<\/span>[\s\S]*?<span>Scrape<\/span>[\s\S]*?<span>Remove source<\/span>/,
  );
  expect(header).not.toContain(">Remove</span></button>");
  // Properties lead with the target; the scrape history waits collapsed with its newest result.
  expect(html).toMatch(/>Properties<\/h3>[\s\S]*>Target<\/dt>[\s\S]*shop\.example\.test\/metrics[\s\S]*>Newest data<\/dt>/);
  expect(html).toMatch(/>More about this source<\/div>[\s\S]*>Scrape history<\/span>[\s\S]*>Success · /);
  // No section icons, no danger zone section.
  expect(html).not.toContain("k2b-detail-panel__section-icon");
  expect(html).not.toContain("Danger zone");
});

test("an HTTP ingest source keeps its API keys open and its example collapsed, in German", () => {
  const html = render({ kind: "http_ingest", endpointUrl: null, scrapeIntervalSeconds: null, enabled: false }, "de", []);
  expect(html).toMatch(/class="k2b-detail-panel__kind"><span>Quelle<\/span>[\s\S]*?k2b-status-badge__label">Pausiert</);
  expect(html).toMatch(/role="menu"[\s\S]*?<span>Fortsetzen<\/span>/);
  expect(html).not.toContain("<span>Abrufen</span>");
  expect(html).toContain("POST https://cloud.example.test/api/pulse/ingest");
  expect(html).toMatch(
    />Eigenschaften<\/h3>[\s\S]*>API-Schlüssel<\/h3>[\s\S]*>Mehr zu dieser Quelle<\/div>[\s\S]*>HTTP-Beispiel für die Datenaufnahme<\/span>/,
  );
  expect(html).toContain(">curl mit Messwerten, Ereignissen und Zuständen</span>");
  expect(html).not.toContain(">Abrufverlauf<");
});
