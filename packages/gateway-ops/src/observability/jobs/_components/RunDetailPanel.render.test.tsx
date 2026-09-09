import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { TraceEvent, TraceSpan } from "@k2b/cloud/services";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-run-detail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: RunDetailPanel } = await import("./RunDetailPanel");

const span: TraceSpan = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  spanKey: "mail-cleanup",
  parentSpanId: null,
  name: "Clean stale mail",
  source: "mail.cleanup",
  appId: "mail",
  category: "schedule",
  kind: "internal",
  status: "ok",
  statusMessage: "Cleanup completed",
  attributes: { queue: "maintenance" },
  summary: { deleted: 12 },
  eventCount: 2,
  startedAt: "2026-08-09T08:00:00.000Z",
  endedAt: "2026-08-09T08:00:01.250Z",
  durationMs: 1250,
  updatedAt: "2026-08-09T08:00:01.250Z",
};

const events: TraceEvent[] = [
  {
    id: "event-1",
    traceId: span.traceId,
    spanId: span.spanId,
    name: "queued",
    severity: "info",
    attributes: null,
    body: "Run entered the queue.",
    occurredAt: "2026-08-09T08:00:00.000Z",
  },
  {
    id: "event-2",
    traceId: span.traceId,
    spanId: span.spanId,
    name: "completed",
    severity: "info",
    attributes: { deleted: 12 },
    body: "Cleanup finished.",
    occurredAt: "2026-08-09T08:00:01.250Z",
  },
];

const renderPanel = (input: { span?: TraceSpan; events?: TraceEvent[] } = {}) =>
  renderToString(() =>
    createComponent(RunDetailPanel, {
      span: input.span ?? span,
      events: input.events ?? events,
      status: "Healthy",
      closeHref: "/admin/observability/jobs?source=mail.cleanup",
    }),
  );

describe("RunDetailPanel", () => {
  test("renders the complete run context through one shared detail panel body", () => {
    const html = renderPanel();

    expect(html).toContain('<aside class="paper min-h-0 p-3" aria-label="Run detail">');
    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Clean stale mail</h2>");
    expect(html).toContain("mail-cleanup");
    expect(html).toContain('aria-label="Close run detail panel"');
    expect(html).toContain('href="/admin/observability/jobs?source=mail.cleanup"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('aria-label="Run data"');
    expect(html).toContain("Summary");
    expect(html).toContain("Attributes");
    expect(html).toContain("Cleanup completed");
    expect(html).toContain("Run entered the queue.");
    expect(html).toContain("Cleanup finished.");
    expect(html.indexOf("Run entered the queue.")).toBeLessThan(html.indexOf("Cleanup finished."));
    expect(html).not.toContain('class="detail-stack');
    expect(html).not.toContain('class="detail-section');
    expect(html).not.toContain('class="detail-facts');
    expect(html).not.toContain("overflow-y-auto");
  });

  test("keeps sparse runs sparse and preserves the empty-events state", () => {
    const html = renderPanel({
      span: { ...span, statusMessage: null, summary: null, attributes: null, eventCount: 0 },
      events: [],
    });

    expect(html).not.toContain('aria-label="Run data"');
    expect(html).not.toContain("Cleanup completed");
    expect(html).toContain("No events recorded for this run.");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });
});
