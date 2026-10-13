import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-switcher.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, createNavigation, Navigation } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const params = new URLSearchParams(document.body.dataset.fixtureParams);
const name = params.has("long") ? "Offene Fahrradwerkstatt der Nachbarschaftsinitiative Südviertel im Hinterhof" : "Work";
const [options, setOptions] = createSignal();
const [error, setError] = createSignal();
let loading = false;
let attempts = 0;
const containers = [
  { id: "personal", label: "Personal", href: "#personal" },
  { id: "work", label: name, description: "team@example.com", href: "#work" },
  { id: "archive", label: "Archive", description: "shared@example.com", href: "#archive" },
  ...(params.has("many") ? Array.from({ length: 7 }, (_, index) => ({ id: "book-" + index, label: "Book " + index, href: "#book-" + index })) : []),
];
const switcher = {
  currentId: "work", label: name, icon: "ti-notebook", switchLabel: "Switch notebook",
  description: params.has("description") ? "team@example.com" : undefined,
  get options() { return options(); },
  get error() { return error(); },
  onLoad() {
    document.body.dataset.loadRequests = String(Number(document.body.dataset.loadRequests ?? 0) + 1);
    if (loading) return;
    loading = true;
    attempts++;
    document.body.dataset.loadStarts = String(attempts);
    setError(undefined);
    setTimeout(() => {
      loading = false;
      if (params.has("error") && attempts === 1) setError("Could not load notebooks");
      else setOptions(containers);
    }, Number(params.get("delay")) || 100);
  },
  actions: [
    { id: "new", label: "New notebook", icon: "ti-plus", action: () => { document.body.dataset.created = "true"; } },
    { id: "disabled", label: "Unavailable", icon: "ti-lock", href: "#unavailable", disabled: true },
    { id: "all", label: "All notebooks", icon: "ti-list", href: "#all" },
  ],
};
const items = () => [
  { id: "notes", label: "Notes", href: "#notes" },
  { id: "recent", label: "Recent", href: "#recent" },
];
const workspace = () => createComponent(AppWorkspace, {
  layoutState: () => params.has("collapsed") ? { version: 2, sidebarCollapsed: true } : null,
  get children() { return [
    createComponent(AppWorkspace.Sidebar, {
      id: "navigation", label: "Navigation", collapsible: true,
      get children() { return createComponent(AppWorkspace.SidebarDesktop, {
        get children() { return [
          createComponent(AppWorkspace.SidebarSwitcher, switcher),
          createComponent(AppWorkspace.SidebarBody, {
            get children() { return items().map(item => createComponent(AppWorkspace.SidebarItem, { href: item.href, children: item.label })); },
          }),
        ]; },
      }); },
    }),
    createComponent(AppWorkspace.Content, {
      get children() { return createComponent(AppWorkspace.Main, { children: "Notebook content" }); },
    }),
  ]; },
});
// Stands in for a host menu that finishes dismissing itself first, as the phone menu does, and may cancel the choice.
const beforeSelect = params.has("guard")
  ? () => new Promise((done) => setTimeout(() => {
      document.body.dataset.beforeSelect = String(Number(document.body.dataset.beforeSelect ?? 0) + 1);
      done(params.get("guard") !== "deny");
    }, 50))
  : undefined;
if (params.has("low")) document.getElementById("app").style.paddingTop = params.get("low") + "px";
render(() => params.has("navigation")
  ? createComponent(Navigation, { navigation: createNavigation({ switcher: () => switcher, items }), label: "Notes", beforeSelect })
  : workspace(), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar switcher fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const trigger = ".k2b-sidebar-switcher__trigger";
const panel = ".k2b-sidebar-switcher__panel";
const search = 'input[type="search"]';
const option = (id: string) => `[data-switcher-option][href="#${id}"]`;
const load = async (width = 1366, params = "", touch = false, height = 800) => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>` +
      `<style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" data-fixture-params="${params}" data-theme="light" style="margin:0;${params.includes("accent=1") ? "--app-accent:#16a34a;--k2b-app-workspace-active:var(--app-accent)" : ""}"><div id="app" style="height:40rem"></div>` +
      '<button id="outside">Outside</button></body></html>',
  );
  await page.addScriptTag({ content: script });
  await page.locator(trigger).waitFor({ state: "attached" });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page;
};
const focused = (page: Page, selector: string) => page.waitForFunction((value) => document.activeElement?.matches(value), selector);
const loaded = (page: Page) => page.locator(option("work")).waitFor({ state: "attached" });
const prime = async (page: Page) => {
  await page.locator(trigger).hover();
  await loaded(page);
  await page.mouse.move(1100, 700);
};
const closed = async (page: Page) => {
  await page.locator(panel).waitFor({ state: "hidden" });
  await page.waitForFunction((value) => document.querySelector(value)?.getAttribute("aria-expanded") === "false", trigger);
};
const geometry = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { trigger: box(".k2b-sidebar-switcher__trigger"), row: box(".k2b-app-workspace__sidebar-item, .k2b-navigation__row") };
  });

// Each test walks a whole flow of key presses; WebKit through a remote Playwright server needs about 5 s for one.
const TEST_TIMEOUT = 20_000;

// Focus, native popover dismissal and placement need the shipped CSS and a real browser.
describe("AppWorkspace.SidebarSwitcher in the browser", () => {
  test(
    "accent scopes keep a neutral hover and open fill, stable geometry and an accented check",
    async () => {
      const page = await load(1366, "accent=1");
      try {
        const head = page.locator(trigger);
        const rest = await head.boundingBox();
        const colors = () =>
          head.evaluate((element) => {
            const style = getComputedStyle(element);
            const probe = document.createElement("span");
            element.append(probe);
            const read = (color: string) => {
              probe.style.backgroundColor = color;
              const computed = getComputedStyle(probe).backgroundColor;
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d")!;
              // Painted over white, so the translucent fill reads as the colour people see.
              context.fillStyle = "#fff";
              context.fillRect(0, 0, 1, 1);
              context.fillStyle = computed;
              context.fillRect(0, 0, 1, 1);
              return Array.from(context.getImageData(0, 0, 1, 1).data);
            };
            const background = read(style.backgroundColor);
            const platformHover = read("var(--k2b-hover)");
            probe.remove();
            return { background, platformHover };
          });
        const neutral = async () => {
          const { background, platformHover } = await colors();
          expect(Math.max(...background.slice(0, 3)) - Math.min(...background.slice(0, 3))).toBeLessThanOrEqual(2);
          expect(background[0]).toBeLessThan(255);
          expect(background).not.toEqual(platformHover);
          expect(await head.boundingBox()).toEqual(rest);
        };
        await head.hover();
        await neutral();
        await head.click();
        await loaded(page);
        expect(await head.getAttribute("aria-expanded")).toBe("true");
        await page.mouse.move(1100, 700);
        await neutral();
        expect(await page.locator(`${option("work")} .k2b-dropdown__check`).evaluate((element) => getComputedStyle(element).color)).toBe(
          "rgb(22, 163, 74)",
        );
        await page.screenshot({ path: "/tmp/k2b-ui-sidebar-switcher-open.png", clip: { x: 0, y: 0, width: 300, height: 320 } });
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "keyboard opens at the current row, wraps, returns focus and closes on Tab out",
    async () => {
      const page = await load();
      try {
        await prime(page);
        await page.keyboard.press("Tab");
        await focused(page, trigger);
        await page.keyboard.press("Enter");
        await focused(page, option("work"));
        for (const [key, selector] of [
          ["ArrowDown", option("archive")],
          ["ArrowUp", option("work")],
          ["Home", option("personal")],
          ["ArrowUp", '[href="#all"]'],
          ["ArrowDown", option("personal")],
          ["End", '[href="#all"]'],
          ["ArrowUp", ".k2b-sidebar-switcher__actions button"],
        ]) {
          await page.keyboard.press(key!);
          await focused(page, selector!);
        }
        await page.keyboard.press("Escape");
        await closed(page);
        await focused(page, trigger);
        await page.keyboard.press("ArrowUp");
        await focused(page, '[href="#all"]');
        await page.keyboard.press("Tab");
        await closed(page);
        expect(await page.locator(trigger).evaluate((element) => element === document.activeElement)).toBe(false);
        await page.locator(trigger).focus();
        await page.keyboard.press("ArrowDown");
        await focused(page, option("work"));
        await page.keyboard.press("Escape");
        await page.keyboard.press("Space");
        await focused(page, option("work"));
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "search filters labels and descriptions, follows the first result and accepts typing on a row",
    async () => {
      const page = await load(1366, "many=1");
      try {
        await prime(page);
        await page.locator(trigger).click();
        await focused(page, search);
        await page.locator(search).fill("SHARED@");
        expect(await page.locator("[data-switcher-option]").count()).toBe(1);
        expect(await page.locator(option("archive")).isVisible()).toBe(true);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => location.hash === "#archive");
        await closed(page);
        await page.locator(trigger).click();
        await focused(page, search);
        expect(await page.locator(search).inputValue()).toBe("");
        await page.keyboard.press("ArrowDown");
        await focused(page, option("personal"));
        await page.keyboard.press("b");
        await focused(page, search);
        expect(await page.locator(search).inputValue()).toBe("b");
        expect(await page.locator("[data-switcher-option]").count()).toBe(7);
        await page.locator(search).fill("nothing matches");
        expect(await page.getByRole("status").textContent()).toBe("No results");
        expect(await page.locator("[data-switcher-option]").count()).toBe(0);
        await page.locator(search).fill("Book");
        await page.keyboard.press("End");
        await focused(page, search);
        await page.keyboard.press("Home");
        await focused(page, search);
        await page.keyboard.press("ArrowUp");
        await focused(page, '[href="#all"]');
        await page.keyboard.press("ArrowDown");
        await focused(page, search);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an open trigger press, outside click and current link each close the panel",
    async () => {
      const page = await load();
      try {
        await prime(page);
        await page.locator(trigger).click();
        await page.locator(panel).waitFor({ state: "visible" });
        await page.locator(trigger).click();
        await closed(page);
        await page.locator(trigger).click();
        await page.locator(panel).waitFor({ state: "visible" });
        await page.locator("#outside").click();
        await closed(page);
        await page.locator(trigger).click();
        await page.locator(option("work")).click();
        await closed(page);
        await focused(page, trigger);
        expect(await page.evaluate(() => location.hash)).toBe("");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "focus and opening request options, and arriving options leave focus on the loading panel",
    async () => {
      const page = await load(1366, "delay=500");
      try {
        await page.keyboard.press("Tab");
        await focused(page, trigger);
        expect(await page.locator("body").getAttribute("data-load-requests")).toBe("1");
        await page.keyboard.press("Enter");
        await focused(page, panel);
        expect(await page.getByRole("status").textContent()).toBe("Loading...");
        expect(await page.locator("body").getAttribute("data-load-requests")).toBe("2");
        expect(await page.locator("body").getAttribute("data-load-starts")).toBe("1");
        await loaded(page);
        await focused(page, panel);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "retry loads the options and action buttons run their callback",
    async () => {
      const page = await load(1366, "error=1");
      try {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await focused(page, panel);
        await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Could not load notebooks"));
        await page.keyboard.press("ArrowDown");
        await focused(page, ".k2b-choice-status button");
        await page.keyboard.press("Enter");
        await loaded(page);
        expect(await page.locator("body").getAttribute("data-load-starts")).toBe("2");
        await page.getByRole("button", { name: "New notebook", exact: true }).click();
        await closed(page);
        expect(await page.locator("body").getAttribute("data-created")).toBe("true");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "loading, opening and closing keep the trigger and following rows in place",
    async () => {
      for (const params of ["delay=500", "delay=500&description=1"]) {
        const page = await load(1366, params);
        try {
          const before = await geometry(page);
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          await focused(page, panel);
          expect(await geometry(page)).toEqual(before);
          await loaded(page);
          expect(await geometry(page)).toEqual(before);
          const bounds = await page.locator(panel).boundingBox();
          expect(bounds?.y).toBeGreaterThanOrEqual(before.trigger.y + before.trigger.height);
          expect(bounds?.width).toBeGreaterThanOrEqual(Math.max(before.trigger.width, 256));
          expect(bounds?.width).toBeLessThanOrEqual(1366 - 16);
          await page.keyboard.press("Escape");
          await closed(page);
          expect(await geometry(page)).toEqual(before);
        } finally {
          await page.close();
        }
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "short and long names give the head one height that hover and opening keep",
    async () => {
      const fullName = "Offene Fahrradwerkstatt der Nachbarschaftsinitiative Südviertel im Hinterhof";
      for (const [width, base] of [
        [1366, "delay=500"],
        [390, "navigation=1&delay=500"],
      ] as const) {
        const heads: Awaited<ReturnType<typeof geometry>>[] = [];
        for (const variant of ["", "&long=1", "&long=1&description=1"]) {
          const long = variant.includes("long");
          const page = await load(width, base + variant, width < 600, 844);
          try {
            const size = await page.locator(`${trigger} .k2b-sidebar-switcher__copy`).evaluate((element) => {
              const name = element.querySelector("span")!;
              return {
                height: element.getBoundingClientRect().height,
                line: Number.parseFloat(getComputedStyle(name).lineHeight),
                clamped: name.scrollHeight > name.clientHeight,
              };
            });
            // Two name lines are reserved for every name; a long one ends with an ellipsis after them, or after one beside a fact.
            expect(size.height).toBe(2 * size.line);
            expect(size.clamped).toBe(long);
            expect(await page.locator(trigger).getAttribute("title")).toBe(long ? fullName : "Work");
            expect(await page.locator(trigger).getAttribute("aria-label")).toBe(long ? fullName : "Work");
            const before = await geometry(page);
            heads.push(before);
            if (width > 600) {
              await page.locator(trigger).hover();
              expect(await geometry(page)).toEqual(before);
            }
            await page.locator(trigger).click();
            await page.locator(panel).waitFor({ state: "visible" });
            expect(await geometry(page)).toEqual(before);
            await loaded(page);
            expect(await geometry(page)).toEqual(before);
            await page.keyboard.press("Escape");
            await closed(page);
            expect(await geometry(page)).toEqual(before);
          } finally {
            await page.close();
          }
        }
        // Switching from a short to a long name keeps every row below the head in place.
        for (const head of heads.slice(1)) {
          expect(head.trigger.height).toBe(heads[0]!.trigger.height);
          expect(head.row.y).toBe(heads[0]!.row.y);
        }
      }
    },
    TEST_TIMEOUT * 2,
  );

  test(
    "the panel never covers its trigger in the phone menu",
    async () => {
      for (const low of [false, true]) {
        const page = await load(390, low ? "navigation=1&long=1&many=1&low=420" : "navigation=1&long=1", true, 844);
        try {
          await page.locator(trigger).tap();
          await loaded(page);
          await page.waitForFunction(() => {
            const button = document.querySelector(".k2b-sidebar-switcher__trigger")!.getBoundingClientRect();
            const bounds = document.querySelector(".k2b-sidebar-switcher__panel")!.getBoundingClientRect();
            return bounds.top >= 8 && bounds.bottom <= innerHeight - 8 && (bounds.bottom <= button.top - 4 || bounds.top >= button.bottom);
          });
          const button = (await page.locator(trigger).boundingBox())!;
          const bounds = (await page.locator(panel).boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(8);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(390 - 8);
          if (low) {
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(button.y - 4);
            const list = page.locator(".k2b-sidebar-switcher__options");
            expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            expect(
              await list.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
                return element.scrollTop;
              }),
            ).toBeGreaterThan(0);
          } else expect(bounds.y).toBeGreaterThanOrEqual(button.y + button.height);
          const all = page.locator('[href="#all"]');
          expect(await all.isVisible()).toBe(true);
          const action = (await all.boundingBox())!;
          expect(action.y).toBeGreaterThanOrEqual(bounds.y);
          expect(action.y + action.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        } finally {
          await page.close();
        }
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the compact overlay stays open when Escape closes the switcher above it",
    async () => {
      const page = await load(900);
      try {
        await page.locator("[data-app-workspace-sidebar-toggle]").click();
        await page.locator(trigger).click();
        await page.locator(panel).waitFor({ state: "visible" });
        await loaded(page);
        expect(await page.locator("[data-k2b-app-workspace]").getAttribute("data-sidebar-overlay")).toBe("open");
        expect(
          await page.locator(panel).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          }),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await closed(page);
        await focused(page, trigger);
        expect(await page.locator("[data-k2b-app-workspace]").getAttribute("data-sidebar-overlay")).toBe("open");
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => document.querySelector("[data-k2b-app-workspace]")?.getAttribute("data-sidebar-overlay") !== "open",
        );
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a collapsed rail shows the icon alone and opens the panel to its right",
    async () => {
      const page = await load(1366, "collapsed=1");
      try {
        expect(await page.locator(`${trigger} .k2b-sidebar-switcher__icon`).isVisible()).toBe(true);
        expect(await page.locator(`${trigger} .k2b-sidebar-switcher__copy`).isVisible()).toBe(false);
        expect(await page.locator(`${trigger} .k2b-sidebar-switcher__chevron`).isVisible()).toBe(false);
        await prime(page);
        await page.locator(trigger).click();
        await page.locator(panel).waitFor({ state: "visible" });
        const button = await page.locator(trigger).boundingBox();
        const bounds = await page.locator(panel).boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(button!.x + button!.width);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the phone navigation lets its host finish dismissing before a container opens or an action runs, and may cancel",
    async () => {
      const allowed = await load(390, "navigation=1&guard=allow", true);
      try {
        await allowed.locator(trigger).tap();
        await allowed.locator(option("archive")).tap();
        await closed(allowed);
        await allowed.waitForFunction(() => location.hash === "#archive");
        expect(await allowed.locator("body").getAttribute("data-before-select")).toBe("1");
        await allowed.locator(trigger).tap();
        await allowed.getByRole("button", { name: "New notebook", exact: true }).tap();
        await allowed.waitForFunction(() => document.body.dataset.created === "true");
        expect(await allowed.locator("body").getAttribute("data-before-select")).toBe("2");
      } finally {
        await allowed.close();
      }
      const denied = await load(390, "navigation=1&guard=deny", true);
      try {
        await denied.locator(trigger).tap();
        await denied.locator(option("archive")).tap();
        await denied.locator(trigger).tap();
        await denied.locator('[href="#all"]').tap();
        await denied.locator(trigger).tap();
        await denied.getByRole("button", { name: "New notebook", exact: true }).tap();
        await denied.waitForFunction(() => document.body.dataset.beforeSelect === "3");
        expect(await denied.evaluate(() => location.hash)).toBe("");
        expect(await denied.locator("body").getAttribute("data-created")).toBeNull();
      } finally {
        await denied.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the panel keeps its side and its edge by the trigger while options load and a search narrows them",
    async () => {
      const page = await load(390, "navigation=1&many=1&long=1&low=420&delay=300", true, 844);
      try {
        const box = () =>
          page.evaluate(() => {
            const rect = document.querySelector(".k2b-sidebar-switcher__panel")!.getBoundingClientRect();
            const field = document.querySelector('.k2b-sidebar-switcher__panel input[type="search"]')?.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, field: field?.top };
          });
        await page.locator(trigger).tap();
        await page.locator(panel).waitFor({ state: "visible" });
        expect(await page.getByRole("status").textContent()).toBe("Loading...");
        const button = (await page.locator(trigger).boundingBox())!;
        // The panel at its tallest does not fit below the low trigger, so it opens above from the start.
        const loading = await box();
        expect(loading.bottom).toBe(button.y - 4);
        await loaded(page);
        await page.locator(search).waitFor({ state: "visible" });
        const full = await box();
        expect(full.bottom).toBe(loading.bottom);
        expect(full.top).toBeGreaterThanOrEqual(8);
        expect(await page.locator('[href="#all"]').isVisible()).toBe(true);
        await page.locator(search).tap();
        await focused(page, search);
        for (const text of ["Book 1", "nothing matches", ""]) {
          await page.locator(search).fill(text);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          expect(await box()).toEqual(full);
        }
        expect(await page.locator("[data-switcher-option]").count()).toBe(10);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the phone navigation keeps its panel within the viewport and waits for a tap to search",
    async () => {
      const page = await load(390, "navigation=1&many=1&description=1", true);
      try {
        await page.locator(trigger).tap();
        await loaded(page);
        await page.keyboard.press("Escape");
        await closed(page);
        await page.locator(trigger).tap();
        await page.locator(panel).waitFor({ state: "visible" });
        await focused(page, option("work"));
        const bounds = await page.locator(panel).boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(8);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        expect((await page.locator(trigger).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        for (const row of await page.locator("[data-switcher-option]").all()) {
          expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        expect(
          await page.locator(search).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
        expect(await page.locator(search).evaluate((element) => element === document.activeElement)).toBe(false);
        await page.locator(search).tap();
        await focused(page, search);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
