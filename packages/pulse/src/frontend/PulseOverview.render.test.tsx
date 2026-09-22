import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PulseBase, PulseCapabilitySnapshot } from "../contracts";

const root = mkdtempSync(join(tmpdir(), "pulse-overview-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: PulseOverview } = await import("./PulseOverview.island");

const base = (id: string, name: string, description: string | null): PulseBase => ({
  id,
  name,
  description,
  rawRetentionDays: 30,
  rollupRetentionDays: 365,
  sensitiveRetentionHours: 24,
  createdBy: null,
  deletionStartedAt: null,
  deletionFailedAt: null,
  deletionError: null,
  dataClearStartedAt: null,
  dataClearCompletedAt: null,
  dataClearFailedAt: null,
  dataClearError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const render = (bases: PulseBase[], capabilities: PulseCapabilitySnapshot | null = null) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(PulseOverview, { bases, capabilities, initialQuery: "" });
      },
    }),
  );

test("renders Pulse bases as cards under one page header with one create action", () => {
  const html = render([base("Ops001", "Operations", null), base("Web001", "Website", "Public site telemetry")]);

  expect(html).toMatch(/<h1 class="k2b-panel-header__title is-large">Pulse<\/h1>/);
  expect(html).toContain("2 bases available");
  expect(html).toMatch(/k2b-panel-header__actions"><button[^>]*data-variant="primary"[^>]*>.*New base/);
  expect(html).toContain("k2b-app-overview__cards");
  expect(html).toContain('href="/app/pulse/Ops001"');
  expect(html).toContain("30-day raw retention");
  expect(html).toContain("Public site telemetry");
  expect(html).not.toContain("k2b-app-overview__aside");
});

test("keeps the empty state and the TimescaleDB notice on the page", () => {
  const html = render([], { timescaleEnabled: false, timeBucketAvailable: false, continuousAggregatesAvailable: false });

  expect(html).toContain("No Pulse bases yet");
  expect(html).toContain("New base");
  expect(html).toContain("k2b-notice");
  expect(html).not.toContain("k2b-app-overview__cards");
});
