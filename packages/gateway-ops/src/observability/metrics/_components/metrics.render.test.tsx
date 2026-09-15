import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MetricsToken } from "../service";
import type { MetricsCatalogueRow } from "./MetricsCatalogue.island";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-metrics-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MetricsCatalogue }, { default: MetricsTokens }, { LocaleProvider }] = await Promise.all([
  import("./MetricsCatalogue.island"),
  import("./MetricsTokens.island"),
  import("@k2b/ui"),
]);

const token: MetricsToken = {
  id: "token-1",
  name: "Monitoring",
  tokenPrefix: "metrics_visible_prefix",
  scopes: ["metrics:read"],
  expiresAt: "2026-09-15T12:30:00Z",
  lastUsedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
};

const renderTokens = (tokens: MetricsToken[], timeZone: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(MetricsTokens, { tokens, timeZone });
      },
    }),
  );

describe("metrics presentation", () => {
  test("keeps token dates in the requested timezone and preserves token actions", () => {
    const berlin = renderTokens([token], "Europe/Berlin");
    const newYork = renderTokens([token], "America/New_York");
    expect(berlin).toContain("14:30");
    expect(newYork).toContain("08:30");
    expect(berlin).toContain("metrics_visible_prefix");
    expect(berlin).toContain("metrics:read");
    expect(berlin).toContain("Monitoring");
    expect(berlin).toContain("—");
    expect(berlin).toContain('aria-label="Revoke metrics token Monitoring"');
    expect(berlin).toContain("New token");
  });

  test("keeps the empty token state and creation action", () => {
    const html = renderTokens([], "UTC");
    expect(html).toContain("No metrics bearer tokens yet.");
    expect(html).toContain("New token");
  });

  test("preserves all collector states and failure details with localized series counts", () => {
    const rows: MetricsCatalogueRow[] = (["ok", "degraded", "error"] as const).map((status) => ({
      name: `cloud_${status}`,
      sourceId: status,
      source: status,
      description: "Collector metric",
      type: "gauge",
      series: 12345,
      status,
      error: status === "ok" ? null : `${status} detail`,
    }));
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(MetricsCatalogue, { rows, sources: [] });
        },
      }),
    );
    expect(html).toContain("12.345");
    expect(html).toContain('title="degraded detail"');
    expect(html).toContain('title="error detail"');
    expect(html).toContain("OK");
    expect(html).toContain("cloud_ok");
    expect(html).toContain("cloud_degraded");
    expect(html).toContain("cloud_error");
  });
});
