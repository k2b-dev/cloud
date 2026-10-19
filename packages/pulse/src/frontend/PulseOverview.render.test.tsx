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
  store: {
    state: "active",
    operation: null,
    errorCode: null,
    errorAt: null,
    writeBlockReason: null,
    profile: "normal",
    limits: {
      valuesPerMinute: 2000,
      bytesPerMinute: 5_242_880,
      storageBytes: 5_000_000_000,
      maxSeries: 50_000,
      maxEventKinds: 2000,
      maxStateKeys: 2000,
    },
    usage: null,
  },
});

const render = (bases: PulseBase[], capabilities: PulseCapabilitySnapshot | null = null, deletingBases: PulseBase[] = []) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(PulseOverview, { bases, deletingBases, capabilities, initialQuery: "" });
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

test("keeps a base in deletion on the overview, with Retry enabled only after a failure", () => {
  const deleting = (id: string, name: string, state: "deleting" | "failed"): PulseBase => {
    const value = base(id, name, null);
    return {
      ...value,
      deletionStartedAt: "2026-01-02T00:00:00.000Z",
      store: { ...value.store, state, operation: "delete", errorCode: state === "failed" ? "STORE_UNREACHABLE" : null },
    };
  };
  const html = render([], null, [deleting("Old001", "Old metrics", "deleting"), deleting("Gone01", "Legacy", "failed")]);

  expect(html).toContain("No Pulse bases yet");
  expect(html).toContain("Old metrics");
  expect(html).toContain("Being deleted");
  expect(html).toContain("Legacy");
  expect(html).toContain("Deleting the base failed");
  expect(html).not.toContain('href="/app/pulse/Old001"');
  const buttons = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*Retry/g)].map((match) => match[0]);
  expect(buttons).toHaveLength(2);
  expect(buttons.filter((button) => / disabled/.test(button))).toHaveLength(1);
});
