import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for the worst case (break-ui, 25.11.): numbers that are never cut, columns that drop by the
// table's room, a person in a cell, counts in the locale's figures, progress beyond its whole and
// text a machine wrote. The browser test of the recipes measures the result; this pins the server's markup it rests on.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-worst-case-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Table, Text } = await import("./content");
const { Tabs } = await import("./components");
const { Section } = await import("./structure");
const { Progress } = await import("./marks");
const { LocaleProvider } = await import("../intl/locale");

type Invoice = { number: string; customer: string; amount: string };
const rows: Invoice[] = [
  { number: "RE-2611-0042-NACHLASS-SONNENHALDE", customer: "Nachlassverwaltung Oberhauser-Wettstein", amount: "12.345.678,90 €" },
  { number: "RE-1", customer: "J", amount: "0,30 €" },
];
const german = (render: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return render();
      },
    }),
  );

const table = () =>
  renderToString(() =>
    createComponent(Table<Invoice>, {
      label: "Rechnungen",
      rows,
      columns: [
        { title: "Nummer", width: { min: 120, default: 140 }, cell: (row) => row.number, drop: true },
        { title: "Kunde", width: { min: 160, default: 240 }, cell: (row) => ({ avatar: { name: row.customer }, lines: [row.customer] }) },
        { title: "Fällig", width: { min: 100, default: 120 }, cell: () => "31.12.2026", numeric: true, drop: true },
        { title: "Betrag", width: { min: 100, default: 120 }, align: "end", cell: (row) => row.amount },
        { title: "Notiz", cell: () => "–" },
      ],
    }),
  );

test("an amount column is at least as wide as its longest value and marked numeric, so it is never cut", () => {
  const markup = table();
  // the amount and the date need more than their defaults (reckoned at 10 px a figure, above any font), so each keeps
  // what it needs, and never less than its longest value in the font it stands in
  expect(markup).toContain("--k2-col-base:max(182px, calc(15ch + 12px + var(--k2-edge)))");
  expect(markup).toContain("--k2-col-base:max(132px, calc(10ch + 12px + var(--k2-edge)))");
  expect(markup.match(/<td[^>]*data-numeric=""/g)?.length).toBe(4); // two rows × (Fällig, Betrag)
});

test("drop columns leave one by one from the last, by a container query on the table's own place", () => {
  const markup = table();
  const id = markup.match(/data-k2-table="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  // at their minimum the columns need 120 + 160 + 132 + 182 + 96 px (the date and the amount at 10 px a figure, the
  // last column without a width 96): below that the date (the last drop column) leaves, below what the rest need
  // the number leaves as well; above it the columns give way between minimum and default
  expect(markup).toContain(
    `@container k2-table (width < 690px) { .k2-ui [data-k2-table="${id}"] [data-drop-step="1"] { width: 0; padding: 0; visibility: hidden; overflow: hidden; }`,
  );
  expect(markup).toContain(
    `@container k2-table (width < 558px) { .k2-ui [data-k2-table="${id}"] [data-drop-step="2"] { width: 0; padding: 0; visibility: hidden; overflow: hidden; }`,
  );
  // each step shares the room anew among the columns still shown (delta review r4): without the date the customer
  // gives way between 160 and 240 px over 558 to 722 px, without the number too over 438 to 582 px
  expect(markup).toContain(
    `[data-k2-table="${id}"] col:nth-child(2) { --k2-col-w: max(clamp(160px, calc(160px + (100cqw - 558px) * 0.4878), 240px), calc(240px + (100cqw - 722px) * 0.8)); }`,
  );
  expect(markup).toContain(
    `[data-k2-table="${id}"] col:nth-child(2) { --k2-col-w: max(clamp(160px, calc(160px + (100cqw - 438px) * 0.5556), 240px), calc(240px + (100cqw - 582px) * 1)); }`,
  );
  // the column leaves with its cells, so the remaining columns keep their widths
  expect(markup).toMatch(/<col data-drop="" data-drop-step="1"/);
});

test("a person in a cell is a picture beside lines, the picture without a name of its own", () => {
  const markup = table();
  expect(markup).toContain('class="k2-cell-person"');
  expect(markup).toMatch(/class="k2-av"[^>]*aria-hidden="true"/);
  expect(markup).toContain('class="k2-cell-lines"');
});

test("counts of tabs and sections are written in the figures of the render locale; words stay as given", () => {
  const tabs = german(() =>
    Tabs({
      label: "Ansichten",
      items: [
        { label: "Alle", count: 12840, current: true, href: "?" },
        { label: "Neu", count: "99+", href: "?n" },
      ],
    }),
  );
  expect(tabs).toContain("12.840");
  expect(tabs).toContain("99+");
  expect(german(() => Section({ title: "Einlieferungen", count: 1284, children: "" }))).toContain("1.284");
});

test("progress beyond its whole is full and marked, its part beyond the whole in its own colour", () => {
  const markup = renderToString(() => Progress({ value: 23, of: 22, label: "Arbeitstag 23 von 22" }));
  expect(markup).toContain("data-over");
  expect(markup).toContain("--k2-p:100%");
  expect(markup).toContain("--k2-whole:95.7%");
  expect(markup).toContain('aria-valuenow="22"');
});

test("text a machine wrote keeps its line breaks as written", () => {
  const trace = "Error: boom\n    at handler (rows.ts:80)";
  const markup = renderToString(() => Text({ mono: true, children: trace }));
  expect(markup).toContain("data-mono");
  expect(markup).toContain(trace);
});
