import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The attention mark's width and colour are results of real layout, so the shipped browser build runs in a browser.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-item-status-attention.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const rows = {
  plain: null,
  attention: { attention: "needs attention" },
  count: { unread: 3 },
  countAttention: { unread: 3, attention: "needs attention" },
};
render(
  () =>
    createComponent(AppWorkspace, {
      resizable: false,
      get children() {
        return createComponent(AppWorkspace.Sidebar, {
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  get children() {
                    return Object.entries(rows).map(([name, status]) =>
                      createComponent(AppWorkspace.SidebarItem, {
                        href: "#" + name,
                        icon: "ti ti-code",
                        data: { state: name },
                        get meta() {
                          return status ? createComponent(AppWorkspace.SidebarItemStatus, status) : undefined;
                        },
                        children: "Code",
                      }),
                    );
                  },
                });
              },
            });
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the attention fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (theme: "light" | "dark"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head>` +
      `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0"><div id="app" style="height:30rem"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator('[data-state="countAttention"]').waitFor();
  await settled(page);
  return page;
};

const measure = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>(".k2b-app-workspace__sidebar-item[data-state]")).map((row) => {
        const box = (selector: string) => {
          const element = row.querySelector(selector);
          if (!element) return null;
          const { left, right, width, height } = element.getBoundingClientRect();
          return { left, right, width, height };
        };
        const dot = row.querySelector(".k2b-app-workspace__sidebar-status-attention");
        return [
          row.dataset.state!,
          {
            height: row.getBoundingClientRect().height,
            dot: box(".k2b-app-workspace__sidebar-status-attention"),
            count: box(".k2b-app-workspace__sidebar-status-count"),
            color: dot ? getComputedStyle(dot).backgroundColor : null,
          },
        ];
      }),
    ),
  );

for (const theme of ["light", "dark"] as const)
  test(`${theme}: the attention dot is a fixed 14 px mark in warning colour that moves neither the row nor a count`, async () => {
    const page = await load(theme);
    try {
      const rows = await measure(page);
      for (const name of ["attention", "count", "countAttention"]) expect(rows[name]!.height).toBe(rows.plain!.height);
      // 0.5rem dot plus 0.1875rem on each side: the width of the bell and "@" marks.
      expect(rows.attention!.dot).toMatchObject({ width: 8, height: 8 });
      expect(rows.attention!.color).toBe("rgb(245, 158, 11)");
      expect(rows.attention!.count).toBeNull();
      // The count keeps its place at the row's end; the dot sits before it.
      expect(rows.countAttention!.count!.right).toBe(rows.count!.count!.right);
      expect(rows.countAttention!.dot!.right).toBeLessThanOrEqual(rows.countAttention!.count!.left);
    } finally {
      await page.close();
    }
  });
