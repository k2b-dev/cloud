import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

setDefaultTimeout(20_000);
const root = mkdtempSync(resolve(tmpdir(), "k2b-sidebar-chips-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { IconButton } = await import("../actions/Button");
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");

type Options = { count?: number; active?: number; dark?: boolean; stacked?: boolean; tree?: boolean };
type Components = {
  AppWorkspace: typeof AppWorkspace;
  IconButton: typeof IconButton;
  createComponent: typeof createComponent;
  createSignal: typeof createSignal;
};
// Source SSR and the shipped client build render exactly the same tree. Every
// children getter creates fresh JSX, as an application's Sidebar children do.
function tree(
  { AppWorkspace, IconButton, createComponent, createSignal }: Components,
  options: Options,
  expose?: (select: (id: number) => void, clicks: () => number) => void,
) {
  const [active, select] = createSignal(options.active ?? 0);
  const [clicks, setClicks] = createSignal(0);
  expose?.(select, clicks);
  const item = (index: number) =>
    createComponent(AppWorkspace.SidebarItem, {
      href: `#object-${index}`,
      variant: "object",
      icon: "ti ti-notebook",
      description: "Secondary description",
      get active() {
        return active() === index;
      },
      get actions() {
        return createComponent(AppWorkspace.SidebarItemActions, {
          get children() {
            return createComponent(IconButton, {
              label: `Actions ${index}`,
              onClick: () => setClicks((value) => value + 1),
              children: "…",
            });
          },
        });
      },
      get children() {
        return [
          createComponent(AppWorkspace.SidebarItemLabel, {
            children:
              index === 2 ? "A very long notebook name that cannot possibly fit into a single chip without an ellipsis" : `Object ${index}`,
          }),
          createComponent(AppWorkspace.SidebarItemMeta, { children: `${index + 1}` }),
        ];
      },
    });
  return createComponent(AppWorkspace, {
    flat: true,
    resizable: false,
    mobileSurface: "flush",
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          label: "Notebooks",
          mobile: options.stacked === false ? undefined : "stacked",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return [
                  createComponent(AppWorkspace.SidebarBody, {
                    get children() {
                      return [
                        createComponent(AppWorkspace.SidebarSection, {
                          title: "Your notebooks",
                          get children() {
                            return Array.from({ length: options.count ?? 5 }, (_, index) => item(index));
                          },
                        }),
                        options.tree
                          ? createComponent(AppWorkspace.NavTree, {
                              ariaLabel: "Folders",
                              get children() {
                                return createComponent(AppWorkspace.NavTree.Item, {
                                  id: "branch",
                                  label: "Branch",
                                  href: "#branch",
                                  get children() {
                                    return createComponent(AppWorkspace.NavTree.Item, { id: "leaf", label: "Leaf", href: "#leaf" });
                                  },
                                });
                              },
                            })
                          : null,
                        createComponent(AppWorkspace.SidebarSection, {
                          title: "Archive",
                          collapsible: true,
                          defaultOpen: false,
                          get children() {
                            return createComponent(AppWorkspace.SidebarItem, { href: "#archived", children: "Archived notebook" });
                          },
                        }),
                      ];
                    },
                  }),
                  createComponent(AppWorkspace.SidebarFooter, {
                    get children() {
                      return [
                        createComponent(AppWorkspace.SidebarItem, {
                          onClick: () => setClicks((value) => value + 1),
                          children: "New notebook",
                        }),
                        createComponent(AppWorkspace.SidebarItem, { href: "#deleted", children: "Recently deleted" }),
                      ];
                    },
                  }),
                ];
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() {
            return createComponent(AppWorkspace.Main, { children: "Notebook overview" });
          },
        }),
      ];
    },
  });
}

function measure() {
  const nav = document.querySelector<HTMLElement>(".k2b-app-workspace__sidebar")!;
  const row = nav.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-desktop")!;
  const box = (element: Element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const all = nav.querySelector(".k2b-app-workspace__sidebar-all");
  const chips = [...row.querySelectorAll<HTMLElement>('[data-variant="object"]')];
  return {
    nav: box(nav),
    row: box(row),
    all: all ? box(all) : null,
    footer: box(row.querySelector(".k2b-app-workspace__sidebar-footer")!),
    chips: chips.map((chip) => ({
      rect: box(chip),
      weight: getComputedStyle(chip.querySelector(".k2b-app-workspace__sidebar-item-label")!).fontWeight,
      background: getComputedStyle(chip).backgroundColor,
      color: getComputedStyle(chip).color,
    })),
    background: getComputedStyle(nav).backgroundColor,
    overflowing: row.scrollWidth > row.clientWidth,
    current: box(row.querySelector('[aria-current="page"]')!.closest(".k2b-app-workspace__sidebar-item")!),
    fade: row.getAttribute("data-scroll-fade"),
  };
}
type Frame = ReturnType<typeof measure>;
declare global {
  interface Window {
    chipMeasure: typeof measure;
    chipServer: Frame;
    chipClient: Frame;
    chipSettled: Frame;
    selectChip: (id: number) => void;
    chipClicks: () => number;
  }
}
const entry = resolve(import.meta.dir, "sidebar-chips.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { AppWorkspace, IconButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const tree = ${tree};
const island = document.getElementById("island");
island.innerHTML = "";
render(() => tree({ AppWorkspace, IconButton, createComponent, createSignal }, JSON.parse(document.body.dataset.options), (select, clicks) => { window.selectChip = select; window.chipClicks = clicks; }), island);
window.chipClient = window.chipMeasure();
requestAnimationFrame(() => requestAnimationFrame(() => { window.chipSettled = window.chipMeasure(); }));
`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle chip sidebar fixture");
const client = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function load(width: number, height: number, options: Options = {}) {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width !== 1440, isMobile: width !== 1440 });
  page.setDefaultTimeout(5_000);
  try {
    const markup = renderToString(() => tree({ AppWorkspace, IconButton, createComponent, createSignal }, options));
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
<body class="k2b-ui${options.dark ? " k2b-dark" : ""}" data-options='${JSON.stringify(options)}' style="margin:0"><div style="height:100dvh;display:flex;flex-direction:column"><solid-island id="island" style="display:contents">${markup}</solid-island></div>
<script>window.chipMeasure = ${measure}; requestAnimationFrame(() => { window.chipServer = window.chipMeasure(); });</script></body></html>`;
    await page.route("http://chips.test/**", (route) =>
      route.fulfill(
        route.request().url().endsWith("client.js")
          ? { contentType: "text/javascript", body: client }
          : { contentType: "text/html", body: html },
      ),
    );
    await page.goto("http://chips.test/overview");
    await attach(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}
async function attach(page: Page) {
  // Capture the server's first animation frame before replacing the island.
  await page.waitForFunction(() => !!window.chipServer);
  await page.addScriptTag({ url: "http://chips.test/client.js" });
  await page.waitForFunction(() => !!window.chipSettled);
}
const frames = (page: Page) =>
  page.evaluate(() => {
    const fixture = window;
    return [fixture.chipServer, fixture.chipClient, fixture.chipSettled];
  });
const geometry = (frame: Frame) => ({
  nav: frame.nav,
  row: frame.row,
  all: frame.all,
  footer: frame.footer,
  chips: frame.chips.map(({ rect, weight }) => ({ rect, weight })),
});
const all = (page: Page) => page.getByRole("button", { name: "All Notebooks", exact: true });

for (const [width, height] of [
  [390, 844],
  [834, 1194],
] as const) {
  describe(`${width} touch chip sidebar`, () => {
    test("one transparent row exposes named navigation and hides full-sidebar content", async () => {
      const page = await load(width, height);
      try {
        const nav = page.getByRole("navigation", { name: "Notebooks", exact: true });
        expect(await nav.count()).toBe(1);
        expect(await nav.getByRole("link", { name: "Object 0" }).getAttribute("aria-current")).toBe("page");
        const frame = (await frames(page))[2]!;
        expect(frame.background).toBe("rgba(0, 0, 0, 0)");
        expect(new Set(frame.chips.map((chip) => chip.rect.top)).size).toBe(1);
        expect(frame.row.height).toBeLessThan(64);
        expect(frame.footer.height).toBe(0);
        for (const label of ["Your notebooks", "Archive", "Archived notebook", "New notebook", "Recently deleted", "Secondary description"])
          expect(await nav.getByText(label, { exact: true }).first().isVisible()).toBe(false);
        expect(await nav.getByRole("button", { name: "Actions 0" }).isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });

    test("selection changes only fill and color, with stable chip boxes and weights", async () => {
      const page = await load(width, height);
      try {
        const before = await page.evaluate(() => window.chipMeasure());
        await page.evaluate(() => window.selectChip(1));
        const after = await page.evaluate(() => window.chipMeasure());
        expect(after.chips.map(({ rect, weight }) => ({ rect, weight }))).toEqual(
          before.chips.map(({ rect, weight }) => ({ rect, weight })),
        );
        for (const index of [0, 1]) {
          expect(after.chips[index]!.background).not.toBe(before.chips[index]!.background);
          expect(after.chips[index]!.color).not.toBe(before.chips[index]!.color);
        }
        expect(geometry((await frames(page))[0]!)).toEqual(geometry(before));
      } finally {
        await page.close();
      }
    });

    test("All opens the complete adaptive sidebar, actions work, Escape restores focus and links close it", async () => {
      const page = await load(width, height);
      try {
        await all(page).click();
        const dialog = page.getByRole("dialog", { name: "Notebooks", exact: true });
        await dialog.waitFor();
        expect(await all(page).getAttribute("aria-expanded")).toBe("true");
        const bounds = (await dialog.boundingBox())!;
        if (width < 768) expect(bounds.y + bounds.height).toBeCloseTo(height, 0);
        else {
          expect(bounds.y + bounds.height).toBeLessThan(height - 20);
          expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0);
          expect(bounds.y + bounds.height / 2).toBeCloseTo(height / 2, 0);
        }
        await dialog.getByRole("button", { name: "Archive", exact: true }).click();
        for (const label of [
          "Object 0",
          "Object 1",
          "Object 3",
          "Object 4",
          "A very long notebook name that cannot possibly fit into a single chip without an ellipsis",
          "Archived notebook",
          "New notebook",
          "Recently deleted",
        ])
          expect(await dialog.getByText(label, { exact: true }).isVisible()).toBe(true);
        await page.evaluate(() => window.selectChip(3));
        expect(await dialog.getByRole("link", { name: "Object 3" }).getAttribute("aria-current")).toBe("page");
        expect(await page.locator('.k2b-app-workspace__sidebar-desktop [aria-current="page"]').textContent()).toContain("Object 3");
        await dialog.getByRole("button", { name: "Actions 0", exact: true }).click();
        expect(await page.evaluate(() => window.chipClicks())).toBe(1);
        await dialog.getByRole("button", { name: "New notebook", exact: true }).click();
        expect(await page.evaluate(() => window.chipClicks())).toBe(2);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-app-workspace__sidebar-all"));
        expect(await all(page).getAttribute("aria-expanded")).toBe("false");
        await all(page).click();
        await dialog.getByRole("link", { name: "Recently deleted", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        expect(new URL(page.url()).hash).toBe("#deleted");
        // The sheet adds no history entry: one Back returns from the chosen link to the overview.
        await page.goBack();
        await page.waitForFunction(() => location.hash === "");
        expect(new URL(page.url()).pathname).toBe("/overview");
      } finally {
        await page.close();
      }
    });

    test("a tree branch's disclosure in the sheet expands it instead of following its link", async () => {
      const page = await load(width, height, { tree: true });
      try {
        await all(page).click();
        const dialog = page.getByRole("dialog", { name: "Notebooks", exact: true });
        await dialog.waitFor();
        expect(await dialog.getByText("Leaf", { exact: true }).isVisible()).toBe(false);
        await dialog.locator('.k2b-app-workspace__nav-tree-node:has-text("Branch") [data-k2b-nav-tree-toggle]').first().click();
        await dialog.getByText("Leaf", { exact: true }).waitFor();
        expect(await dialog.isVisible()).toBe(true);
        expect(new URL(page.url()).hash).toBe("");
      } finally {
        await page.close();
      }
    });

    test("long labels truncate at 15rem without wrapping a 36px chip", async () => {
      const page = await load(width, height);
      try {
        const size = await page
          .locator('[data-variant="object"]')
          .nth(2)
          .evaluate((chip) => {
            const label = chip.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label")!;
            return {
              width: chip.getBoundingClientRect().width,
              height: chip.getBoundingClientRect().height,
              cut: label.scrollWidth > label.clientWidth,
              whiteSpace: getComputedStyle(label).whiteSpace,
              overflow: getComputedStyle(label).textOverflow,
            };
          });
        expect(size.width).toBeLessThanOrEqual(240);
        expect(size).toMatchObject({ height: 36, cut: true, whiteSpace: "nowrap", overflow: "ellipsis" });
      } finally {
        await page.close();
      }
    });

    for (const dark of [false, true])
      test(`${dark ? "dark" : "light"}: 30 objects keep All reachable and the current chip visible before hydration and after reload`, async () => {
        const page = await load(width, height, { count: 30, active: 20, dark });
        try {
          for (let reload = 0; reload < 2; reload++) {
            const snapshots = await frames(page);
            for (const frame of snapshots) {
              expect(geometry(frame)).toEqual(geometry(snapshots[0]!));
              expect(frame.overflowing).toBe(true);
              expect(new Set(frame.chips.map((chip) => chip.rect.top)).size).toBe(1);
              expect(frame.current.left).toBeGreaterThanOrEqual(frame.row.left);
              expect(frame.current.right).toBeLessThanOrEqual(frame.row.right);
              expect(frame.fade).toBe("both");
              expect(frame.all!.left).toBeGreaterThan(0);
              expect(frame.all!.right).toBeLessThanOrEqual(width);
            }
            expect(await page.getByRole("link", { name: "Object 20", exact: false }).getAttribute("aria-current")).toBe("page");
            expect(
              await all(page).evaluate((button) => {
                const box = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
              }),
            ).toBe(true);
            await all(page).click();
            await page.getByRole("dialog").waitFor();
            await page.keyboard.press("Escape");
            await page.getByRole("dialog").waitFor({ state: "detached" });
            if (!reload) {
              await page.reload();
              await attach(page);
            }
          }
        } finally {
          await page.close();
        }
      });
  });
}

for (const [width, height] of [
  [1194, 834],
  [1440, 900],
] as const)
  test(`${width}: stacked and default sidebars keep identical desktop geometry`, async () => {
    const stacked = await load(width, height);
    let standard: Page | undefined;
    try {
      standard = await load(width, height, { stacked: false });
      const read = (page: Page) =>
        page.evaluate(() => {
          const rect = (element: Element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const nav = document.querySelector(".k2b-app-workspace__sidebar")!;
          return {
            nav: rect(nav),
            items: [...nav.querySelectorAll(".k2b-app-workspace__sidebar-item")].map(rect),
            footer: rect(nav.querySelector(".k2b-app-workspace__sidebar-footer")!),
          };
        });
      expect(await read(stacked)).toEqual(await read(standard));
      expect(await stacked.locator(".k2b-app-workspace__sidebar-all").isVisible()).toBe(false);
      expect(await standard.locator(".k2b-app-workspace__sidebar-all").count()).toBe(0);
    } finally {
      await stacked.close();
      await standard?.close();
    }
  });
