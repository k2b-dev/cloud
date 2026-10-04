import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";
import type { FolderDisplay } from "../../contracts";
import type { MailAdminFolderView } from "../../service/folders";
import type { FolderSettingsHarnessOptions } from "./MailFolderSettings.browser-harness";

// Row heights, the fixed state column, container queries, and the menu in the top layer are layout, which only a
// real engine decides, so the folder settings run in a browser inside the shared settings frame.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailFolderSettings.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-folder-settings-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Mail folder settings harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const folder = (id: string, name: string, overrides: Partial<MailAdminFolderView> = {}): MailAdminFolderView => ({
  id,
  parentId: null,
  name,
  role: "other",
  providerRole: "other",
  configuredRole: null,
  selectable: true,
  display: "everywhere",
  effectiveDisplay: "everywhere",
  displayInheritedFromFolderId: null,
  displayNeutral: false,
  namespaceKinds: ["personal"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total: 0,
  unread: 0,
  subscribed: true,
  rightsSource: "acl",
  effectiveRights: [],
  canCreateChildren: true,
  canRename: true,
  canDelete: false,
  canManageSubscription: true,
  ...overrides,
});
const shared = { namespaceKinds: ["shared"] as MailAdminFolderView["namespaceKinds"], canRename: false };
const neutral = { displayNeutral: true, canRename: false };
// An invented team mailbox on a Gmail-like provider.
const folders: MailAdminFolderView[] = [
  folder("Inbox1", "Inbox", { role: "inbox", providerRole: "inbox", canRename: false }),
  folder("News01", "Newsletter", { display: "folder_only", effectiveDisplay: "folder_only" }),
  folder("Shar01", "Shared", shared),
  folder("Acct01", "Accounting", { ...shared, parentId: "Shar01" }),
  folder("Impo01", "Important", { ...shared, parentId: "Acct01" }),
  folder("Proj01", "Projects", { ...shared, parentId: "Shar01" }),
  folder("Fair01", "Trade fair", { ...shared, parentId: "Proj01" }),
  folder("Webs01", "Website", { ...shared, parentId: "Proj01" }),
  folder("Arch01", "Old files", { display: "hidden", effectiveDisplay: "hidden" }),
  folder("Y20201", "2021", { parentId: "Arch01", effectiveDisplay: "hidden", displayInheritedFromFolderId: "Arch01" }),
  folder("Gone01", "Old project", { discoveryState: "missing", missingSince: "2026-09-01T00:00:00.000Z", canCreateChildren: false }),
  folder("Gmai01", "[Gmail]", { selectable: false, canCreateChildren: false, canRename: false, canManageSubscription: false }),
  folder("Draf01", "Drafts", { ...neutral, parentId: "Gmai01", role: "drafts", providerRole: "drafts" }),
  folder("Sent01", "Sent Mail", { ...neutral, parentId: "Gmai01", role: "sent", providerRole: "sent" }),
  folder("AllM01", "All Mail", {
    ...neutral,
    parentId: "Gmai01",
    role: "all",
    providerRole: "all",
    display: "hidden",
    effectiveDisplay: "hidden",
  }),
  folder("Impt01", "Important", { ...neutral, parentId: "Gmai01", display: "hidden", effectiveDisplay: "hidden" }),
  folder("Junk01", "Spam", { ...neutral, parentId: "Gmai01", role: "junk", providerRole: "junk" }),
  folder("Tras01", "Trash", { ...neutral, parentId: "Gmai01", role: "trash", providerRole: "trash" }),
];

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** The displays the page stored, in order. */
let stored: { folderId: string; display: FolderDisplay }[] = [];
/** How long the server takes to answer a display change. */
let patchDelayMs = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const match = /^\/api\/mail\/mailboxes\/Box001\/folders\/([^/]+)$/u.exec(pathname);
    if (match?.[1] && request.method === "PATCH") {
      const { display } = (await request.json()) as { display: FolderDisplay };
      await Bun.sleep(patchDelayMs);
      stored.push({ folderId: match[1], display });
      return Response.json({ folderId: match[1], display, effectiveDisplay: display, displayInheritedFromFolderId: null });
    }
    return new Response(
      // The settings frame of Mail's settings dialog: centred on wide screens, the whole screen on phones.
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:2rem;margin:auto;max-width:64rem;display:flex;flex-direction:column}' +
        "@media (max-width:47.999rem){#root{inset:0}}</style></head>" +
        '<body class="k2b-ui" style="margin:0"><div id="root" class="paper"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const load = async (
  options: { context?: BrowserContextOptions; theme?: "light" | "dark"; locale?: "en" | "de"; reloadMs?: number } = {},
) => {
  stored = [];
  patchDelayMs = 0;
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: FolderSettingsHarnessOptions) => window.mountFolderSettings(harnessOptions), {
    locale: options.locale ?? "en",
    folders,
    reloadMs: options.reloadMs,
  } satisfies FolderSettingsHarnessOptions);
  await page.waitForSelector(".mail-folder-tree");
  return Object.assign(page, { errors });
};
const close = (page: Page) => page.context().close();

const exactName = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** The trigger of the folder row whose name is `name`; `index` picks among folders of the same name. */
const trigger = (page: Page, name: string, index = 0) =>
  page.locator(".mail-folder-tree__main", { has: page.locator(".mail-folder-tree__name", { hasText: exactName(name) }) }).nth(index);
const rowState = (page: Page, name: string, index = 0) =>
  page
    .locator(".mail-folder-tree__row", { has: page.locator(".mail-folder-tree__name", { hasText: exactName(name) }) })
    .nth(index)
    .locator(".mail-folder-tree__state");
/** Every row, name, and state box of the tree, and the panel around it. */
const layout = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".k2b-settings__body, .mail-folder-tree, .mail-folder-tree__row, .mail-folder-tree__name, .mail-folder-tree__state",
      ),
    ].map((element) => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return [
        element.className,
        Math.round(top * 100) / 100,
        Math.round(left * 100) / 100,
        Math.round(width * 100) / 100,
        Math.round(height * 100) / 100,
      ];
    }),
  );
const openMenu = () =>
  [...document.querySelectorAll<HTMLElement>(".mail-folder-menu")].find((menu) => menu.matches(":popover-open")) ?? null;
const menuText = (page: Page) => page.evaluate(`(${openMenu.toString()})()?.innerText ?? null`) as Promise<string | null>;
const choose = (page: Page, label: string) =>
  page.locator(".mail-folder-menu:popover-open [role='menuitemradio']", { hasText: label }).click();
/**
 * Waits until the server stored `count` displays and the page applied its answer. The server records a change
 * before it answers, so only the page can say when the answer arrived: the changed row is no longer busy.
 */
const settled = async (page: Page, count: number) => {
  for (let attempt = 0; attempt < 100 && stored.length < count; attempt += 1) await Bun.sleep(20);
  await page.waitForFunction(() => document.querySelector(".mail-folder-tree__item[aria-busy]") === null);
};

describe("Mail folder settings", () => {
  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`keeps every row compact, aligned, and inside the panel on ${name} in ${theme} mode`, async () => {
        const page = await load({ context, theme, locale: theme === "dark" ? "de" : "en" });
        try {
          const rows = await page.evaluate(() =>
            [...document.querySelectorAll(".mail-folder-tree__row")].map((row) => {
              const box = row.getBoundingClientRect();
              const state = row.querySelector(".mail-folder-tree__state")!.getBoundingClientRect();
              const body = document.querySelector(".k2b-settings__body")!;
              return { height: box.height, right: Math.round(state.right), overflow: body.scrollWidth > body.clientWidth };
            }),
          );
          expect(rows).toHaveLength(folders.length);
          // 38 px rows, 44 px on touch screens; one state column for all.
          expect(new Set(rows.map((row) => row.height))).toEqual(new Set([name === "phone" ? 44 : 38]));
          expect(new Set(rows.map((row) => row.right)).size).toBe(1);
          expect(rows.some((row) => row.overflow)).toBe(false);
          // Each level indents by one step; a provider group's folders start at the top level again.
          const left = async (name: string, index = 0) => (await trigger(page, name, index).boundingBox())!.x;
          const step = (await left("Accounting")) - (await left("Shared"));
          expect(step).toBe(20);
          expect((await left("Important", 0)) - (await left("Accounting"))).toBe(step);
          expect(await left("Sent Mail")).toBe(await left("Inbox"));
          // Phones say only "inherited"; the source is in the row's name and the menu.
          const inherited = await rowState(page, "2021").innerText();
          expect(inherited).toBe(
            name === "phone"
              ? theme === "dark"
                ? "geerbt"
                : "inherited"
              : theme === "dark"
                ? "geerbt von Old files"
                : "inherited from Old files",
          );
          expect(page.errors).toEqual([]);
        } finally {
          await close(page);
        }
      }, 30_000);
    }
  }

  test("opens the displays with explanations from a click on the folder and changes it and its subfolders without moving a row", async () => {
    const page = await load();
    try {
      const before = await layout(page);
      expect(await rowState(page, "Shared").getAttribute("data-kind")).toBe("default");
      await trigger(page, "Shared").click();
      expect(await menuText(page)).toContain("WHERE MAIL APPEARS · ALSO 5 SUBFOLDERS");
      expect(await menuText(page)).toContain("Only in the folder\nIn the sidebar. Its mail appears only when you open the folder.");
      expect(await menuText(page)).toContain("New subfolder");
      // The menu sits under the row, inside the window.
      const menu = await page.evaluate(`(${openMenu.toString()})()?.getBoundingClientRect().toJSON()`);
      const row = (await trigger(page, "Shared").boundingBox())!;
      expect((menu as DOMRect).top).toBeGreaterThan(row.y + row.height - 1);
      expect((menu as DOMRect).right).toBeLessThanOrEqual(1440 - 8);
      expect(await layout(page)).toEqual(before);

      await choose(page, "Only in the folder");
      await settled(page, 1);
      expect(stored).toEqual([{ folderId: "Shar01", display: "folder_only" }]);
      expect(await rowState(page, "Shared").innerText()).toBe("Only in the folder");
      for (const subfolder of ["Accounting", "Projects", "Trade fair", "Website"]) {
        expect(await rowState(page, subfolder).innerText()).toBe("inherited from Shared");
      }
      expect(await trigger(page, "Trade fair").getAttribute("aria-label")).toBe(
        "Trade fair, Shared by provider, Only in the folder, inherited from Shared",
      );
      // Focus is back on the row itself, and nothing moved.
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
        "Shared, Shared by provider, Only in the folder",
      );
      expect(await layout(page)).toEqual(before);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("lets a subfolder be stricter than its parent, never looser, and follow the parent again", async () => {
    const page = await load();
    try {
      await trigger(page, "Shared").click();
      await choose(page, "Only in the folder");
      await settled(page, 1);

      await trigger(page, "Trade fair").click();
      const everywhere = page.locator(".mail-folder-menu:popover-open [role='menuitemradio']", { hasText: "Everywhere" });
      expect(await everywhere.isDisabled()).toBe(true);
      expect(await everywhere.innerText()).toContain("Set by “Shared”. Change it there.");
      // The choice the keyboard reaches names the parent too, since a menu skips the disabled ones.
      expect(
        await page.locator(".mail-folder-menu:popover-open [role='menuitemradio']", { hasText: "Only in the folder" }).innerText(),
      ).toContain("Follows “Shared”. Looser choices are set there.");
      await choose(page, "Hidden");
      await settled(page, 2);
      expect(await rowState(page, "Trade fair").innerText()).toBe("Hidden");

      // Picking what Shared passes down stores no own display, so Trade fair follows Shared again.
      await trigger(page, "Trade fair").click();
      await choose(page, "Only in the folder");
      await settled(page, 3);
      expect(stored.slice(1)).toEqual([
        { folderId: "Fair01", display: "hidden" },
        { folderId: "Fair01", display: "everywhere" },
      ]);
      expect(await rowState(page, "Trade fair").innerText()).toBe("inherited from Shared");

      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("lets a neutral folder ignore Only in the folder from its parent and be shown again when hidden", async () => {
    const page = await load();
    try {
      await trigger(page, "[Gmail]").click();
      await choose(page, "Only in the folder");
      await settled(page, 1);

      // Sent Mail never decides what combined views show, so it shows like Everywhere, and its menu says so.
      expect(await rowState(page, "Sent Mail").getAttribute("data-kind")).toBe("default");
      await trigger(page, "Sent Mail").click();
      const radio = (label: string) => page.locator(".mail-folder-menu:popover-open [role='menuitemradio']", { hasText: label });
      expect(await radio("Everywhere").getAttribute("aria-checked")).toBe("true");
      expect(await radio("Everywhere").isDisabled()).toBe(false);
      expect(await radio("Only in the folder").getAttribute("aria-checked")).toBe("false");
      expect(await radio("Only in the folder").isDisabled()).toBe(true);
      expect(await radio("Only in the folder").innerText()).toContain("Not needed: this folder never decides what combined views show.");
      await page.keyboard.press("Escape");

      // The hidden All Mail can be shown again without loosening [Gmail].
      await trigger(page, "All Mail").click();
      expect(await radio("Everywhere").isDisabled()).toBe(false);
      await choose(page, "Everywhere");
      await settled(page, 2);
      expect(stored).toEqual([
        { folderId: "Gmai01", display: "folder_only" },
        { folderId: "AllM01", display: "everywhere" },
      ]);
      expect(await rowState(page, "All Mail").getAttribute("data-kind")).toBe("default");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("works from the keyboard and collapses groups without moving the rows above", async () => {
    const page = await load();
    try {
      await trigger(page, "Projects").focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitemradio");
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Only in the folder");
      await page.keyboard.press("Escape");
      expect(await menuText(page)).toBeNull();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
        "Projects, Shared by provider, Everywhere",
      );

      // The panel and the tree come first; then the rows Inbox, Newsletter, and Shared with their name and state.
      const above = (await layout(page)).slice(2, 11);
      const chevron = page.getByRole("button", { name: "Subfolders of Shared" });
      await chevron.click();
      expect(await chevron.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator(".mail-folder-tree__row").count()).toBe(folders.length - 5);
      expect((await layout(page)).slice(2, 11)).toEqual(above);
      await chevron.click();
      expect(await chevron.getAttribute("aria-expanded")).toBe("true");
      expect(await page.locator(".mail-folder-tree__row").count()).toBe(folders.length);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("keeps focus on the row and every row at full strength while a change saves and the folders reload", async () => {
    const page = await load({ reloadMs: 600 });
    try {
      patchDelayMs = 600;
      const projects = "Projects, Shared by provider, Everywhere";
      await trigger(page, "Projects").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      const snapshot = () =>
        page.evaluate(() => ({
          focused: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
          busy: document.querySelector("[aria-busy='true'] .mail-folder-tree__name")?.textContent ?? null,
          disabled: [...document.querySelectorAll<HTMLButtonElement>(".mail-folder-tree__main")].filter((row) => row.disabled).length,
          dimmed: [...document.querySelectorAll(".mail-folder-tree__main")].filter((row) => getComputedStyle(row).opacity !== "1").length,
        }));

      // While the change saves: only the changed row is busy, and no row dims or loses its focus.
      await Bun.sleep(300);
      expect(await snapshot()).toEqual({ focused: projects, busy: "Projects", disabled: 0, dimmed: 0 });
      // A second choice waits for the first.
      await page.keyboard.press("Enter");
      const offered = await page.$$eval(".mail-folder-menu:popover-open [role='menuitemradio']", (items) =>
        items.map((item) => item.getAttribute("aria-disabled")),
      );
      expect(offered).toEqual(["true", "true", "true"]);
      await page.keyboard.press("Escape");

      // While the folders reload.
      await settled(page, 1);
      await Bun.sleep(300);
      expect(await snapshot()).toEqual({
        focused: "Projects, Shared by provider, Only in the folder",
        busy: null,
        disabled: 0,
        dimmed: 0,
      });
      await Bun.sleep(500);
      expect(stored).toEqual([{ folderId: "Proj01", display: "folder_only" }]);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
        "Projects, Shared by provider, Only in the folder",
      );
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("keeps the menu inside a phone screen with touch-sized entries", async () => {
    const page = await load({ context: phone, locale: "de" });
    try {
      await trigger(page, "Important", 0).tap();
      const menu = (await page.evaluate(`(${openMenu.toString()})()?.getBoundingClientRect().toJSON()`)) as DOMRect;
      expect(menu.left).toBeGreaterThanOrEqual(8);
      expect(menu.right).toBeLessThanOrEqual(390 - 8);
      const heights = await page.$$eval(".mail-folder-menu:popover-open .k2b-dropdown__item", (items) =>
        items.map((item) => item.getBoundingClientRect().height),
      );
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
      expect(await menuText(page)).toContain("WO E-MAILS ERSCHEINEN");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);
});
