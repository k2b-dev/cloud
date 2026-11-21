import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { workspaceCss } from "../../test/workspace-host-fixture";

// K6, K10, K15: the status row keeps its lead statement at the same place and size in every state; a selection, a
// disturbance, or an announcement takes the place of the key figures. The head row is 56 px and its views end on
// the head line, where the current view's mark lies; no view is cut.
const directory = mkdtempSync(resolve(tmpdir(), "k2b-status-row-"));
registerSsrTestPlugin({ dev: true, rootDir: directory });
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));

const { StatusRow } = await import("./StatusRow");
const { default: AppWorkspace } = await import("./AppWorkspace");
const { ViewTabs } = await import("../actions/ViewTabs");
const { Button } = await import("../actions/Button");
const { LocaleProvider } = await import("../intl/locale");

const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const el = (component: string, props: Record<string, unknown>) => createComponent(Dynamic, { component, ...props });
const facts = [
  { value: "12", label: "open" },
  { value: "3", label: "overdue" },
  { value: "22 s", label: "since the last delivery" },
];
const filters = () => [
  createComponent(Button, { size: "sm", children: "Tag" }),
  createComponent(Button, { size: "sm", children: "Assigned" }),
];
const rows: Record<string, () => JSX.Element> = {
  facts: () => createComponent(StatusRow, { lead: "12 tasks open", facts, filters: filters() }),
  selection: () =>
    createComponent(StatusRow, {
      lead: "12 tasks open",
      facts,
      filters: filters(),
      selection: { count: 3, actions: createComponent(Button, { size: "sm", children: "Move" }) },
    }),
  state: () =>
    createComponent(StatusRow, {
      lead: "12 tasks open",
      facts,
      filters: filters(),
      state: { label: "Sync paused", tone: "warning", icon: "ti ti-refresh", next: "14:05" },
    }),
  announcement: () =>
    createComponent(StatusRow, { lead: "12 tasks open", facts, filters: filters(), announcement: "Moving “Invoice 12” to Done" }),
};

const open = async (width: number, body: string) => {
  const page = await browser.newPage({ viewport: { width, height: 600 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0">${body}</body></html>`,
  );
  await settled(page);
  return page;
};

const lead = (page: Page, index: number) =>
  page
    .locator(".k2b-status-row")
    .nth(index)
    .evaluate((row) => {
      const lead = row.querySelector(".k2b-status-row__lead")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const text = row.querySelector(".k2b-status-row__lead")!;
      return {
        left: lead.left - box.left,
        top: Math.round((lead.top - box.top) * 10) / 10,
        width: Math.round(lead.width * 10) / 10,
        height: box.height,
        cut: text.scrollWidth > text.clientWidth + 0.5,
        size: getComputedStyle(text).fontSize,
        weight: getComputedStyle(text).fontWeight,
      };
    });

for (const width of [1440, 768, 390])
  test(`${width}: the lead statement keeps its place and size in every state, never cut`, async () => {
    const html = Object.values(rows)
      .map(
        (row) =>
          `<div style="width:${Math.min(width, 900)}px">${renderToString(() => createComponent(LocaleProvider, { locale: "en", children: row() }))}</div>`,
      )
      .join("");
    const page = await open(width, html);
    try {
      const all = await Promise.all(Object.keys(rows).map((_, index) => lead(page, index)));
      // A phone row wraps its filters below the lead statement, so only the lead is compared there.
      const same = ({ height, ...rest }: (typeof all)[number]) => (width >= 768 ? { height, ...rest } : rest);
      for (const row of all) {
        expect(same(row)).toEqual(same(all[0]!));
        expect(row.cut).toBe(false);
        expect(row.size).toBe("18px");
        expect(row.weight).toBe("600");
      }
      if (width >= 768) expect(all[0]!.height).toBe(52);
      // The text edge: 20 px, 16 px on a phone.
      expect(all[0]!.left).toBe(width >= 768 ? 20 : 16);
      // At most three key figures; a state, a selection, or an announcement replaces them.
      expect(await page.locator(".k2b-status-row").nth(0).locator(".k2b-status-row__fact").count()).toBe(3);
      expect(await page.locator(".k2b-status-row").nth(1).locator(".k2b-status-row__middle").innerText()).toBe("3 selected");
      expect(await page.locator(".k2b-status-row").nth(1).locator(".k2b-status-row__end").innerText()).toBe("Move");
      expect(await page.locator(".k2b-status-row").nth(2).locator(".k2b-status-row__middle").innerText()).toContain("next attempt 14:05");
      expect(await page.locator(".k2b-status-row").nth(3).locator("[aria-live=polite]").innerText()).toBe("Moving “Invoice 12” to Done");
    } finally {
      await page.close();
    }
  });

test("1440: a narrow row drops key figures whole before the lead statement shrinks", async () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      children: el("div", { style: "width:360px", children: rows.facts!() }),
    }),
  );
  const page = await open(1440, html);
  try {
    const row = await lead(page, 0);
    expect(row.cut).toBe(false);
    // Every key figure is either whole on the row's line or gone; none shows half.
    const figures = await page.locator(".k2b-status-row__fact").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const clip = element.parentElement!.getBoundingClientRect();
        return box.right <= clip.right + 0.5 && box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5
          ? "whole"
          : box.top >= clip.bottom - 0.5
            ? "gone"
            : "half";
      }),
    );
    expect(figures).not.toContain("half");
  } finally {
    await page.close();
  }
});

const head = (items: number) =>
  renderToString(() =>
    createComponent(AppWorkspace, {
      get children() {
        return [
          createComponent(AppWorkspace.Head, {
            views: createComponent(ViewTabs, {
              label: "Views",
              current: "1",
              items: Array.from({ length: items }, (_, index) => ({
                id: String(index + 1),
                label: ["List", "Board", "Calendar", "Timeline", "Files", "Activity"][index]!,
                href: `?view=${index + 1}`,
              })),
            }),
            primary: { label: "New task", icon: "ti ti-plus", href: "?new" },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, { children: "Tasks" });
            },
          }),
        ];
      },
    }),
  );

for (const width of [1440, 768, 390])
  test(`${width}: the head row is one band; the current view's mark lies on its line and no view is cut`, async () => {
    const page = await open(width, `<div style="height:400px;display:flex">${head(4)}</div>`);
    try {
      const geometry = await page.evaluate(() => {
        const head = document.querySelector(".k2b-app-workspace__head")!;
        const box = head.getBoundingClientRect();
        const current = document.querySelector('.k2b-view-tabs__tab[aria-current="page"]')!;
        const tab = current.getBoundingClientRect();
        const tabs = [...document.querySelectorAll<HTMLElement>(".k2b-view-tabs__tab")].filter(
          (element) => element.getClientRects().length > 0,
        );
        const list = document.querySelector(".k2b-view-tabs__list")!.getBoundingClientRect();
        return {
          height: Math.round(box.height),
          line: getComputedStyle(head).boxShadow.includes("inset"),
          markOnLine: Math.abs(tab.bottom - box.bottom) <= 0.5,
          mark: getComputedStyle(current).boxShadow.split("),")[0]!.includes("-2px"),
          cut: tabs.filter((element) => {
            const r = element.getBoundingClientRect();
            return element.scrollWidth > element.clientWidth + 0.5 || r.left < list.left - 0.5 || r.right > list.right + 0.5;
          }).length,
          fill: getComputedStyle(current).backgroundColor,
          edge: Math.round(document.querySelector(".k2b-view-tabs__label")!.getBoundingClientRect().left - box.left),
        };
      });
      expect(geometry).toEqual({
        height: width >= 768 ? 56 : 44,
        line: true,
        markOnLine: true,
        mark: true,
        cut: 0,
        fill: "rgba(0, 0, 0, 0)",
        edge: width >= 768 ? 20 : 16,
      });
    } finally {
      await page.close();
    }
  });
