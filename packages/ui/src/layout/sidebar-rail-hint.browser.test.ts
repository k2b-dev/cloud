import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The collapsed rail shows only icons, so each entry names itself in the same
// hint the Cloud app rail uses: right beside it, at once, on hover and on
// keyboard focus, without a native title. Whether the rail shows depends on
// the container width and the controller, so a real engine runs the shipped
// browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-rail-hint.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const collapsed = new URLSearchParams(window.fixtureParams ?? "").has("collapsed");
// Live data such as a mailbox's counts changes a title after the hint took over.
const [openTitle, setOpenTitle] = createSignal("Open invoices: due this week");
window.setOpenTitle = setOpenTitle;
const item = (props, label) => createComponent(AppWorkspace.SidebarItem, { ...props, children: label });
const node = (props) => createComponent(AppWorkspace.NavTree.Item, props);
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(AppWorkspace, {
          layoutState: () => (collapsed ? { version: 2, sidebarCollapsed: true } : null),
          get children() {
            return [
              createComponent(AppWorkspace.Sidebar, {
                id: "navigation",
                label: "Navigation",
                collapsible: true,
                get children() {
                  return createComponent(AppWorkspace.SidebarDesktop, {
                    get children() {
                      return createComponent(AppWorkspace.SidebarBody, {
                        get children() {
                          return [
                            createComponent(AppWorkspace.SidebarSwitcher, {
                              currentId: "north",
                              label: "North Studio",
                              icon: "ti ti-building",
                              switchLabel: "Switch studio",
                              options: [{ id: "north", label: "North Studio", href: "#north" }],
                            }),
                            item({ href: "#invoices", icon: "ti ti-file-invoice", active: true }, "Invoices"),
                            item(
                              {
                                href: "#open",
                                icon: "ti ti-arrow-up-right",
                                get title() {
                                  return openTitle();
                                },
                              },
                              "Open invoices",
                            ),
                            item({ href: "#drafts", icon: "ti ti-file", title: "Drafts", actionIcon: "ti ti-dots", actionLabel: "Draft actions" }, "Drafts"),
                            createComponent(AppWorkspace.NavTree, {
                              ariaLabel: "Folders",
                              get children() {
                                return node({ id: "archive", label: "Archive", icon: "ti ti-archive", href: "#archive" });
                              },
                            }),
                            createComponent(AppWorkspace.SidebarIconGrid, {
                              get children() {
                                return createComponent(AppWorkspace.SidebarIconAction, { icon: "ti ti-plus", label: "New invoice" });
                              },
                            }),
                          ];
                        },
                      });
                    },
                  });
                },
              }),
              createComponent(AppWorkspace.Content, {
                get children() {
                  return createComponent(AppWorkspace.Main, { children: "Invoices" });
                },
              }),
            ];
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar rail hint fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (params = "") => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.evaluate((value) => {
    (window as unknown as { fixtureParams: string }).fixtureParams = value;
  }, params);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__main").first().waitFor({ state: "attached" });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page;
};

// Every entry kind the rail shows, found by the accessible name it keeps there.
const entries = (page: Page) => [
  { control: page.getByRole("button", { name: "North Studio", exact: true }), hint: "North Studio" },
  { control: page.getByRole("link", { name: "Invoices", exact: true }), hint: "Invoices" },
  { control: page.getByRole("link", { name: "Open invoices", exact: true }), hint: "Open invoices: due this week" },
  { control: page.getByRole("link", { name: "Drafts", exact: true }), hint: "Drafts" },
  {
    control: page.locator("[data-k2b-nav-tree-id='archive'] > .k2b-app-workspace__sidebar-item"),
    focus: page.getByRole("treeitem", { name: "Archive", exact: true }),
    hint: "Archive",
  },
  { control: page.getByRole("button", { name: "New invoice", exact: true }), hint: "New invoice" },
];

const openHints = async (page: Page) => {
  await settled(page);
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".k2b-tooltip:popover-open")).map((hint) => {
      const rect = hint.getBoundingClientRect();
      return { text: hint.textContent?.trim() ?? "", left: rect.left, bottom: rect.bottom, middle: rect.top + rect.height / 2 };
    }),
  );
};
// Longer than the default hint delay, so a hint that waits has had its chance.
const pastDelay = (page: Page) => page.waitForTimeout(400);
const box = async (control: Locator) => {
  await settled(control.page());
  const rect = (await control.boundingBox())!;
  return { right: rect.x + rect.width, middle: rect.y + rect.height / 2, rect };
};
const away = (page: Page) => page.mouse.move(1200, 600);

describe("collapsed sidebar rail hints", () => {
  test("hover and keyboard focus name every rail entry beside it, with no native title and nothing moving", async () => {
    const page = await load("collapsed");
    try {
      // The rail hides the labels from view, not from assistive technology.
      expect(await page.locator("#navigation").ariaSnapshot()).toContain('treeitem "Archive"');
      for (const { control, focus, hint } of entries(page)) {
        expect(await control.count()).toBe(1);
        const before = await box(control);
        await control.hover();
        const shown = await openHints(page);
        expect(shown.map((open) => open.text)).toEqual([hint]);
        // The native title gave way, so the name never shows twice.
        expect(await control.getAttribute("title")).toBeNull();
        // Beside the icon on the right, centred on it, as in the Cloud app rail.
        expect(shown[0]!.left).toBeGreaterThanOrEqual(before.right);
        expect(Math.abs(shown[0]!.middle - before.middle)).toBeLessThanOrEqual(1);
        expect((await box(control)).rect).toEqual(before.rect);
        // The open hint does not become part of the entry's name.
        expect(await page.locator("#navigation").ariaSnapshot()).not.toContain(`"${hint} ${hint}"`);
        await away(page);
        expect(await openHints(page)).toEqual([]);

        await page.keyboard.press("Shift");
        await (focus ?? control).focus();
        expect((await openHints(page)).map((open) => open.text)).toEqual([hint]);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        expect(await openHints(page)).toEqual([]);
      }
      // A hint that repeats the name adds no description; one that says more does.
      expect(
        await page.locator("#navigation [aria-describedby^='k2b-tooltip']").evaluateAll((all) => all.map((e) => e.textContent?.trim())),
      ).toEqual(["Open invoices"]);
      expect(await page.locator("#navigation [title]").count()).toBe(0);
      // The hint is the same surface the Cloud app rail renders.
      const reference = await page.evaluate(() => document.querySelector(".k2b-tooltip")?.className);
      expect(reference).toBe("k2b-tooltip");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("an open hint lets the pointer through to what lies under it", async () => {
    const page = await load("collapsed");
    try {
      await page.getByRole("link", { name: "Invoices", exact: true }).hover();
      const [shown] = await openHints(page);
      expect(shown?.text).toBe("Invoices");
      // A hint over a neighbouring control must not take the pointer, or WebKit applies :hover to that control
      // only after the hint has left the top layer (#2085).
      const hit = await page.evaluate(() => {
        const hint = document.querySelector<HTMLElement>(".k2b-tooltip:popover-open")!;
        const rect = hint.getBoundingClientRect();
        const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { onHint: Boolean(element && hint.contains(element)), pointerEvents: getComputedStyle(hint).pointerEvents };
      });
      expect(hit).toEqual({ onHint: false, pointerEvents: "none" });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a touch never opens a rail hint", async () => {
    const page = await load("collapsed");
    try {
      await page.getByRole("link", { name: "Invoices", exact: true }).dispatchEvent("pointerenter", { pointerType: "touch" });
      expect(await openHints(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("the expanded sidebar shows its labels and no hint that only repeats them", async () => {
    const page = await load();
    try {
      // Entries without a title whose whole label shows never even mount a hint.
      const mounted = () => page.locator("#navigation .k2b-tooltip").count();
      const before = await mounted();
      for (const { control, focus } of [entries(page)[1]!, entries(page)[4]!]) {
        await control.hover();
        await pastDelay(page);
        expect(await openHints(page)).toEqual([]);
        await page.keyboard.press("Shift");
        await (focus ?? control).focus();
        await pastDelay(page);
        expect(await openHints(page)).toEqual([]);
      }
      expect(await mounted()).toBe(before);

      // A title that only repeats the whole label gives way without a hint.
      for (const { control, hint } of [entries(page)[0]!, entries(page)[3]!]) {
        expect(await page.locator(`#navigation [title="${hint}"]`).count()).toBe(1);
        await control.hover();
        await pastDelay(page);
        expect(await openHints(page)).toEqual([]);
        expect(await page.locator(`#navigation [title="${hint}"]`).count()).toBe(0);
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a title with details shows above its expanded entry after the usual delay, in place of the native title", async () => {
    const page = await load();
    try {
      const open = page.getByRole("link", { name: "Open invoices", exact: true });
      await open.hover();
      expect(await openHints(page)).toEqual([]);
      await pastDelay(page);
      const shown = await openHints(page);
      expect(shown.map((hint) => hint.text)).toEqual(["Open invoices: due this week"]);
      expect(shown[0]!.bottom).toBeLessThanOrEqual((await box(open)).rect.y);
      expect(await open.getAttribute("title")).toBeNull();

      // A new title updates the hint and never brings the native title back.
      await page.mouse.move(1200, 600);
      await page.evaluate(() => (window as unknown as { setOpenTitle: (title: string) => void }).setOpenTitle("Open invoices: 4 due"));
      await open.hover();
      await pastDelay(page);
      expect((await openHints(page)).map((hint) => hint.text)).toEqual(["Open invoices: 4 due"]);
      expect(await open.getAttribute("title")).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);
});
