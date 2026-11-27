import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import type { TickState } from "./marks";

// Ticks kept a fixed 140 px. In a column of 120 px the strip ran past its cell, and the cell cut its end: the newest
// slots, such as the three failed scrapes of "Drucker Halle 2" (DP, #4360). The strip now takes the cell's width where
// that is narrower, and where its slots do not fit it clips its oldest ones, never its newest.

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-ticks-fit-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Table } = await import("./content");
const { Ticks } = await import("./marks");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");

/** 30 minutes of scrapes; the last three failed. */
const recent: TickState[] = Array.from({ length: 30 }, (_, minute) => (minute >= 27 ? "bad" : "ok"));
/** More slots than any cell holds; only the newest failed. */
const many: TickState[] = Array.from({ length: 500 }, (_, slot) => (slot === 499 ? "bad" : "ok"));
const rows = [
  { name: "Drucker Halle 2", slots: recent },
  { name: "Syslog alle", slots: many },
];
const SourceTable = Table<(typeof rows)[number]>;
const markup = renderToString(() =>
  createComponent(SourceTable, {
    label: "Quellen",
    rows,
    rowKey: (row) => row.name,
    columns: [
      { title: "Quelle", width: { min: 160, default: 180 }, cell: (row) => row.name },
      {
        title: "Abrufe",
        width: { min: 120, default: 120 },
        cell: (row) => createComponent(Ticks, { slots: row.slots, label: `${row.name}, letzte Abrufe`, color: "#eab308" }),
      },
      { title: "Letzter Abruf", cell: () => "vor 12 s" },
    ],
  }),
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

for (const [width, dir] of [
  [1440, "ltr"],
  [390, "ltr"],
  [1440, "rtl"],
] as const)
  test(`${width} px, ${dir}: Ticks in a 120 px cell keep their newest slot whole inside the cell`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de" dir="${dir}"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui"><div class="k2-scroll">${markup}</div></body></html>`,
      );
      await settled(page);
      const found = await page.evaluate(() =>
        [...document.querySelectorAll(".k2-ticks")].map((ticks) => {
          const cell = ticks.closest("td")!;
          const style = getComputedStyle(cell);
          const box = cell.getBoundingClientRect();
          const [start, end] = [box.left + Number.parseFloat(style.paddingLeft), box.right - Number.parseFloat(style.paddingRight)];
          const strip = ticks.getBoundingClientRect();
          const newest = ticks.lastElementChild!.getBoundingClientRect();
          const visible = (slot: DOMRect) => slot.width >= 1 && slot.left >= strip.left - 0.5 && slot.right <= strip.right + 0.5;
          return {
            cell: Math.round(box.width),
            // the strip stays between the cell's text edges
            inside: strip.left >= start - 0.5 && strip.right <= end + 0.5,
            // the newest slot is whole inside the strip, at its end in the writing direction
            newest: visible(newest),
            atEnd:
              document.documentElement.dir === "rtl"
                ? Math.abs(newest.left - strip.left) < 0.5
                : Math.abs(newest.right - strip.right) < 0.5,
            // the last three failed scrapes all show
            failed: [...ticks.querySelectorAll('[data-s="bad"]')].filter((slot) => visible(slot.getBoundingClientRect())).length,
          };
        }),
      );
      expect(found).toEqual([
        { cell: 120, inside: true, newest: true, atEnd: true, failed: 3 },
        { cell: 120, inside: true, newest: true, atEnd: true, failed: 1 },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
