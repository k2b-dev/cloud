import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { defaultLogFilter } from "./types";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-log-table-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: LogTable } = await import("./LogTable.island");

const renderTable = (loadError: string | null, withEntry = false) =>
  renderToString(() =>
    createComponent(LogTable, {
      entries: withEntry
        ? [{ id: 1, source: "core", level: "error", message: "Example failure", metadata: null, createdAt: "2026-08-09T08:00:00Z" }]
        : [],
      total: withEntry ? 12345 : 0,
      filter: defaultLogFilter,
      sources: [],
      retentionDays: 30,
      timeZone: "Europe/Berlin",
      totalPages: withEntry ? 124 : 1,
      baseUrl: "/admin/observability/logs?page=",
      loadError,
    }),
  );

describe("LogTable", () => {
  test("labels the table, renders timezone-aware records and preserves pagination", () => {
    const html = renderTable(null, true);
    expect(html).toContain("1 of 12,345 log entries");
    expect(html).toContain("10:00");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('href="/admin/observability/logs?page=2"');
    expect(html).toContain('aria-labelledby="k2b-data-table-');
  });

  test("distinguishes failed loading from a successful empty result and retains search", () => {
    const failed = renderTable("Storage unavailable");
    expect(failed).toContain("Storage unavailable");
    expect(failed).not.toContain("No log entries");
    expect(failed).not.toContain("0 of 0 log entries");
    expect(failed).toContain('type="search"');
    const empty = renderTable(null);
    expect(empty).toContain("No log entries");
    expect(empty).not.toContain("Storage unavailable");
  });
});
