import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-data-table-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: DataTable } = await import("./DataTable");
const { LocaleProvider } = await import("../intl/locale");
const columns = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `c${i}`, header: `Column ${i}`, value: "id" as const, align: "right" as const }));
const table = (count: number, loading = false, loadingRows?: number, rows: { id: string }[] = []) =>
  createComponent(DataTable<{ id: string }>, { columns: columns(count), rows, loading, loadingRows });

test("only tables wider than eight columns carry data-wide in SSR", () => {
  for (const count of [6, 8]) expect(renderToString(() => table(count))).not.toContain("data-wide");
  expect(renderToString(() => table(9))).toContain('data-wide="true"');
});

test("loading renders bounded row-height placeholders with column alignment and a loading caption", () => {
  for (const [requested, expected] of [
    [undefined, 5],
    [3.9, 3],
    [0, 1],
    [-5, 1],
    [100, 50],
    [Number.NaN, 5],
    [Infinity, 50],
    [-Infinity, 1],
  ] as const) {
    const html = renderToString(() => table(2, true, requested));
    expect(html.match(/data-loading="true"/g)?.length).toBe(expected);
    expect(html.match(/k2b-data-table__skeleton/g)?.length).toBe(expected * 2);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-busy="true"');
    // The caption names the waiting table; the polite announcement goes through the shared live region in the browser.
    expect(html).toContain('<caption class="k2b-sr-only">Loading rows</caption>');
    expect(html).toContain('data-align="right"');
    expect(html).toContain("Loading rows");
    expect(html).not.toContain("No records");
  }
});

test("refreshing keeps existing rows and idle empty tables keep the fallback", () => {
  const refreshing = renderToString(() => table(2, true, 5, [{ id: "Existing content" }]));
  expect(refreshing).toContain("Existing content");
  expect(refreshing).not.toContain("data-loading");
  const empty = renderToString(() => table(2));
  expect(empty).toContain("No records");
  expect(empty).not.toContain("aria-busy");
  expect(empty).not.toContain("k2b-data-table__skeleton");
});

test("loading inherits the server locale", () => {
  expect(
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return table(2, true);
        },
      }),
    ),
  ).toContain("Zeilen werden geladen");
});
