import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { Block } from "./schema";

const root = mkdtempSync(resolve(tmpdir(), "k2b-cloud-detail-block-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { BlockTree } = await import("./BlockTree");
const { formatDescriptionNumber } = await import("../descriptions/format");
const { blocksText } = await import("./text");
const { LocaleProvider } = await import("@k2b/ui");

const items = [
  { label: "Size", value: 2_400_000, format: { unit: "B" } },
  { label: "Price", value: 1234.5, format: { style: "currency" as const, currency: "EUR" } },
  { label: "Share", value: 0.125, format: { style: "percent" as const } },
  { label: "Weight", value: 1.5, format: { decimals: 2, unit: "kg" } },
  { label: "Year", value: 2026 },
];
const detail: Block = { kind: "Detail", title: "Details", items };

/** The values a detail block shows, in its row order, as the server draws them in the search preview. */
const shown = (locale: string, block: Block = detail) => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BlockTree, { blocks: [block], host: "preview", locale, timeZone: "Europe/Berlin" });
      },
    }),
  );
  return Array.from(html.matchAll(/<strong[^>]*>([^<]*)<\/strong>/g), (match) => match[1]!.replaceAll("&nbsp;", " "));
};

for (const [locale, size, price, share, weight] of [
  ["de", "2,4 MB", "1.234,50 €", "12,5 %", "1,50 kg"],
  ["en", "2.4 MB", "€1,234.50", "12.5%", "1.50 kg"],
] as const)
  test(`a detail block in ${locale} formats its numbers as key figures do: sizes, money, shares, and units`, () => {
    expect(shown(locale)).toEqual([size, price, share, weight, "2026"]);
    // The terminal and MCP read the same values as the screen.
    expect(blocksText([detail], { locale })).toBe(
      ["Details", ...items.map((item, index) => `${item.label}: ${shown(locale)[index]}`)].join("\n"),
    );
    const figures: Block = {
      kind: "Stats",
      items: items.map(({ label, value, format }) => ({ label, value, ...(format ? { format } : {}) })),
    };
    // Key figures format every number, also one without a format, as the screen does.
    expect(blocksText([figures], { locale }).split("\n")).toEqual(
      [size, price, share, weight, formatDescriptionNumber(2026, undefined, locale)].map(
        (value, index) => `${items[index]!.label}: ${value}`,
      ),
    );
    // One formatter for every block: what a key figure shows for the same value and format.
    expect(shown(locale).slice(0, 4)).toEqual([
      formatDescriptionNumber(2_400_000, { unit: "B" }, locale),
      formatDescriptionNumber(1234.5, { style: "currency", currency: "EUR" }, locale),
      formatDescriptionNumber(0.125, { style: "percent" }, locale),
      formatDescriptionNumber(1.5, { decimals: 2, unit: "kg" }, locale),
    ]);
  });

test("a changed size in an approval shows its earlier value in the same format", () => {
  const change: Block = {
    kind: "Detail",
    title: "Change",
    items: [{ label: "Size", before: 1_000, value: 2_400_000, format: { unit: "B" } }],
  };
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(BlockTree, { blocks: [change], host: "review", locale: "en", timeZone: "Europe/Berlin" });
      },
    }),
  );
  expect(html).toContain("1 KB</s>");
  expect(html).toContain("2.4 MB</strong>");
});

test("a change whose two sizes read alike shows both with more digits, on screen and in text", () => {
  const change: Block = {
    kind: "Detail",
    title: "Change",
    items: [{ label: "Size", before: 2_400_000, value: 2_400_100, format: { unit: "B" } }],
  };
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(BlockTree, { blocks: [change], host: "review", locale: "de", timeZone: "Europe/Berlin" });
      },
    }),
  );
  expect(html).toContain("2,4000 MB</s>");
  expect(html).toContain("2,4001 MB</strong>");
  expect(blocksText([change], { locale: "de" })).toBe("Change\nSize: 2,4000 MB → 2,4001 MB");
});
