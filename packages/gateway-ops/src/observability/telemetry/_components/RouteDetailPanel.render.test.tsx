import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { TelemetryEventRow } from "../service";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-route-detail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: RouteDetailPanel } = await import("./RouteDetailPanel");

const events: TelemetryEventRow[] = [
  {
    id: 41,
    appId: "mail",
    routePrefix: "/api/mail",
    route: "/api/mail/messages/:id",
    method: "GET",
    status: 503,
    durationMs: 750,
    errorKind: "upstream_unavailable",
    occurredAt: "2026-08-09T08:00:00.000Z",
  },
  {
    id: 42,
    appId: "mail",
    routePrefix: "/api/mail",
    route: "/api/mail/messages/:id",
    method: "PATCH",
    status: 204,
    durationMs: 15,
    errorKind: null,
    occurredAt: "2026-08-09T08:01:00.000Z",
  },
];

const renderPanel = (rows: TelemetryEventRow[] = events) =>
  renderToString(() =>
    createComponent(RouteDetailPanel, {
      route: "/api/mail/messages/:id",
      events: rows,
      eventLimit: 100,
      slowRequestMs: 500,
      dateConfig: { locale: "en-GB", timeZone: "Europe/Berlin" },
      closeHref: "/admin/observability/telemetry?range=7d&app=mail&sort=requests",
    }),
  );

describe("RouteDetailPanel", () => {
  test("renders retained requests through one shared detail panel body", () => {
    const html = renderPanel();
    expect(html).toContain("10:00");
    expect(html).not.toContain("08:00");

    expect(html).toContain('aria-label="Route detail"');
    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("/api/mail/messages/:id");
    expect(html).toContain("Last 100 requests in this range");
    expect(html).toContain('aria-label="Close route detail"');
    expect(html).toContain('href="/admin/observability/telemetry?range=7d&amp;app=mail&amp;sort=requests"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain("Requests");
    expect(html).toContain("GET");
    expect(html).toContain("PATCH");
    expect(html.indexOf("GET")).toBeLessThan(html.indexOf("PATCH"));
    expect(html).toContain('title="upstream_unavailable"');
    expect(html).toContain("text-amber-600 dark:text-amber-400");
    expect(html).not.toContain('class="k2b-detail-panel__summary"');
    expect(html).not.toContain("overflow-y-auto");
  });

  test("preserves the empty retained-request state", () => {
    const html = renderPanel([]);

    expect(html).toContain("No individual requests retained for this range.");
    expect(html).not.toContain("k2b-table");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });
});
