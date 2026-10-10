import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser } from "../../../ui/test/browser";

// The shell's geometry at every width — which chrome exists, where the app
// area ends, which edges draw lines — is decided by real layout, so a real
// engine loads the server-rendered Layout with the global stylesheet and the
// shared workspace controller, as Cloud serves them.
const root = mkdtempSync(resolve(tmpdir(), "cloud-compact-shell-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
// Several tests walk every device, each in a fresh browser context.
setDefaultTimeout(30_000);

const { Hono } = await import("hono");
const { AppWorkspace, dropdownPosition } = await import("@k2b/ui");
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");

const probe = defineApp({
  id: "compact-shell-probe",
  name: "Compact shell probe",
  icon: "ti ti-layout",
  description: "Shell geometry probe",
  baseUrl: "http://compact-shell-probe:3000",
  routes: ["/app/mail"],
});
const apps = [
  {
    id: "mail",
    name: "Mail",
    icon: "ti ti-mail",
    description: "Read and write mail",
    routes: ["/app/mail"],
    nav: { href: "/app/mail", section: "primary" },
  },
  {
    id: "pwa",
    name: "Phone app",
    icon: "ti ti-device-mobile",
    description: "Phone app",
    routes: ["/pwa"],
    nav: { href: "/pwa", section: "hidden" },
  },
];

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];

/** A mail-like workspace: navigation, a list pane beside the reader, and a detail panel. Invented content. */
const workspace = (selected: string) =>
  createComponent(AppWorkspace, {
    mobileSurface: "flush",
    class: "min-h-0 flex-1",
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "mail-navigation",
          label: "Mailboxes",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  get children() {
                    return ["inbox", "archive", "sent"].map((id) =>
                      createComponent(AppWorkspace.SidebarItem, {
                        href: `#${id}`,
                        icon: "ti ti-inbox",
                        active: id === selected,
                        children: id[0]!.toUpperCase() + id.slice(1),
                      }),
                    );
                  },
                });
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() {
            return [
              createComponent(AppWorkspace.Main, {
                get children() {
                  return [
                    createComponent(AppWorkspace.MainPane, { id: "messages", label: "Messages", children: "Quarterly numbers" }),
                    `Reader for ${selected}`,
                  ];
                },
              }),
              createComponent(AppWorkspace.Detail, { id: "message-detail", open: true, width: "sm", children: "Sender details" }),
            ];
          },
        }),
      ];
    },
  });

const server = new Hono()
  .get(
    "/app/mail/:folder",
    async (c, next) => {
      // `?name=` renames Mail, for a long app name in the phone header.
      const name = c.req.query("name");
      c.set("runtime" as never, { apps: name ? apps.map((app) => (app.id === "mail" ? { ...app, name } : app)) : apps } as never);
      // A missing last name shows the profile notice above the app.
      c.set("user" as never, (c.req.query("notice") ? { ...person, sn: "" } : person) as never);
      await next();
    },
    ...probe.ssr((c) => {
      const folder = c.req.param("folder") ?? "inbox";
      const title = folder[0]!.toUpperCase() + folder.slice(1);
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          fullWidth: true,
          fullPage: true,
          title: [{ title: "Home", href: "/" }, { title: "Mail", href: "/app/mail" }, { title }],
          get children() {
            return workspace(folder);
          },
        });
    }),
  )
  .get(
    "/public",
    async (c, next) => {
      c.set("runtime" as never, { apps } as never);
      await next();
    },
    ...probe.ssr(
      (c) => () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          title: [{ title: "Home", href: "/" }, { title: c.req.query("title") ?? "Public tools" }],
          children: "Public content",
        }),
    ),
  );

let browser: Browser;
let css: string;
let controller: string;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  // Cloud installs the shared workspace controller once for the document; the
  // test installs the same export from the shipped browser build.
  const entry = resolve(import.meta.dir, "compact-shell.controller.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(resolve(import.meta.dir, "../../../ui/dist/browser/index.js"))};
window.installController = () => installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the workspace controller.");
  controller = await bundle.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.close();
});

type Device = { name: string; width: number; height: number; touch: boolean };
const phone: Device = { name: "phone", width: 390, height: 844, touch: true };
const ipadPortrait: Device = { name: "iPad portrait", width: 820, height: 1180, touch: true };
const ipadLandscape: Device = { name: "iPad landscape", width: 1180, height: 820, touch: true };
const laptop: Device = { name: "laptop", width: 1366, height: 900, touch: false };
const desktop: Device = { name: "desktop", width: 1920, height: 1080, touch: false };
const devices = [phone, ipadPortrait, ipadLandscape, laptop, desktop];

type Options = { language?: "en" | "de"; theme?: "light" | "dark"; notice?: boolean };
const html = async (path: string, options: Options = {}) => {
  const headers = {
    "Accept-Language": options.language ?? "en",
    Cookie: `theme=${options.theme ?? "light"}`,
  };
  const markup = await (await server.request(path, { headers })).text();
  return markup.replace(
    "</head>",
    `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
  );
};

/** Attaches the controller as Cloud's island does after the first paint, and lets its first frame run. */
const attach = async (page: Page) => {
  await page.addScriptTag({ content: controller });
  await page.evaluate(async () => {
    (window as unknown as { installController: () => void }).installController();
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
  });
};

const open = async (
  device: Device,
  path: string,
  options: Options & { attached?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> => {
  // iPads and phones report a coarse pointer without hover, as Safari does.
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.touch,
    isMobile: device.touch,
  });
  const page = await context.newPage();
  await page.setContent(await html(path, options));
  if (options.attached !== false) await attach(page);
  return { context, page };
};

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Geometry = {
  header: string | null;
  rail: { display: string; box: Box; borders: number[] } | null;
  shell: { box: Box; borders: number[]; background: string } | null;
  workspace: { box: Box; borders: number[]; radius: string; shadow: string } | null;
  bar: { display: string; box: Box; borders: number[]; title: string } | null;
  sidebar: { visibility: string; display: string; box: Box; borders: number[] } | null;
  pane: { box: Box; borders: number[] } | null;
  main: { box: Box; borders: number[] } | null;
  detail: { box: Box; borders: number[] } | null;
  avatar: { box: Box; visible: boolean } | null;
  hairlines: string[];
};

const geometry = (page: Page): Promise<Geometry> =>
  page.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const borders = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((value) =>
        Number.parseFloat(value),
      );
    };
    const find = (selector: string) => document.querySelector(selector);
    const header = find(".layout-header");
    const rail = find(".layout-rail");
    const shell = find(".layout-shell-content");
    const workspace = find(".k2b-app-workspace");
    const bar = find(".k2b-app-workspace__head");
    const title = find(".k2b-app-workspace__head .k2b-page-title__text");
    const sidebar = find(".k2b-app-workspace__sidebar");
    const pane = find(".k2b-app-workspace__main-pane");
    const main = find(".k2b-app-workspace__main");
    const detail = find(".k2b-app-workspace__detail");
    const avatar = [...document.querySelectorAll(".layout-profile-preferences > :is(button, .layout-profile-preferences__dropdown)")].find(
      (element) => getComputedStyle(element).display !== "none",
    );
    // A divider element: a visible box at most 2 px thin that spans a large part of the app area.
    const appWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const hairlines = [...document.querySelectorAll(".cloud-app-canvas *")].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return [];
      const vertical = rect.width > 0 && rect.width <= 2 && rect.height >= window.innerHeight / 2;
      const horizontal = rect.height > 0 && rect.height <= 2 && rect.width >= appWidth / 2;
      return vertical || horizontal ? [element.className.toString() || element.localName] : [];
    });
    return {
      header: header ? getComputedStyle(header).display : null,
      rail: rail ? { display: getComputedStyle(rail).display, box: box(rail), borders: borders(rail) } : null,
      shell: shell ? { box: box(shell), borders: borders(shell), background: getComputedStyle(shell).backgroundColor } : null,
      workspace: workspace
        ? {
            box: box(workspace),
            borders: borders(workspace),
            radius: getComputedStyle(workspace).borderTopRightRadius,
            shadow: getComputedStyle(workspace).boxShadow,
          }
        : null,
      bar: bar
        ? {
            display: getComputedStyle(bar).display,
            box: box(bar),
            borders: borders(bar),
            title: title?.textContent ?? "",
          }
        : null,
      sidebar: sidebar
        ? {
            visibility: getComputedStyle(sidebar).visibility,
            display: getComputedStyle(sidebar).display,
            box: box(sidebar),
            borders: borders(sidebar),
          }
        : null,
      pane: pane ? { box: box(pane), borders: borders(pane) } : null,
      main: main ? { box: box(main), borders: borders(main) } : null,
      detail: detail ? { box: box(detail), borders: borders(detail) } : null,
      avatar: avatar ? { box: box(avatar), visible: true } : null,
      hairlines,
    };
  });

const none = [0, 0, 0, 0];
const flush = (device: Device) => device.width >= 768 && device.width < 1536;
const compact = (device: Device) => device.width >= 768 && device.width < 1024;

describe("signed-in shell", () => {
  for (const device of devices) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device.name} ${device.width}×${device.height} ${theme}: chrome, app edges, and lines`, async () => {
        const { context, page } = await open(device, "/app/mail/inbox", { theme });
        try {
          const shape = await geometry(page);
          if (device.width < 768) {
            // Phones keep today's shell: the header, no rail, one pane at a time.
            expect(shape.header).not.toBe("none");
            expect(shape.rail?.display).toBe("none");
            expect(shape.bar?.display).toBe("none");
            expect(shape.sidebar?.display).toBe("none");
            expect(shape.workspace?.borders).toEqual(none);
            expect(shape.workspace?.radius).toBe("0px");
            return;
          }
          expect(shape.header).toBe("none");
          expect(shape.rail?.display).toBe("flex");
          expect(shape.rail?.box.left).toBe(0);
          expect(shape.rail?.box.width).toBe(48);
          // Nothing draws the rail/app boundary: no border on either side and no divider element.
          expect(shape.rail?.borders).toEqual(none);
          expect(shape.shell?.borders).toEqual(none);
          expect(shape.hairlines).toEqual([]);
          // The avatar is the rail's last control.
          expect(shape.avatar).not.toBeNull();
          expect(shape.avatar!.box.left).toBeGreaterThanOrEqual(0);
          expect(shape.avatar!.box.right).toBeLessThanOrEqual(48);
          expect(shape.rail!.box.bottom - shape.avatar!.box.bottom).toBeLessThanOrEqual(12);
          if (flush(device)) {
            // Flush: the app area meets the top, right, and bottom window edges and has no frame.
            expect(shape.shell?.box).toMatchObject({ left: 48, top: 0, right: device.width, bottom: device.height });
            expect(shape.rail?.box).toMatchObject({ top: 0, bottom: device.height });
            expect(shape.workspace?.box).toMatchObject({ left: 48, top: 0, right: device.width, bottom: device.height });
            expect(shape.workspace?.borders).toEqual(none);
            expect(shape.workspace?.radius).toBe("0px");
            expect(shape.workspace?.shadow).toBe("none");
            // An opaque surface, so the app canvas shows only behind the rail.
            expect(shape.shell?.background).toMatch(/^rgb\(/);
          } else {
            // From 1536 px the app is a card with the shell spacing, still without a header.
            expect(shape.workspace?.box).toMatchObject({ left: 48, top: 8, right: device.width - 8, bottom: device.height - 8 });
            expect(shape.workspace?.radius).not.toBe("0px");
            expect(shape.workspace?.shadow).not.toBe("none");
          }
          // The sidebar and the main area draw no lines; the list/reader and
          // main/detail separators are the ones origin/main already draws.
          expect(shape.sidebar?.borders).toEqual(none);
          expect(shape.main?.borders).toEqual(none);
          expect(shape.pane?.borders).toEqual([0, 1, 0, 0]);
          expect(shape.detail?.borders).toEqual([0, 0, 0, 1]);
          // List and reader stay side by side, the detail beside them.
          expect(shape.pane!.box.right).toBeLessThanOrEqual(shape.detail!.box.left);
          expect(shape.pane!.box.top).toBe(shape.detail!.box.top);
          if (compact(device)) {
            expect(shape.bar?.display).toBe("flex");
            expect(shape.bar?.borders).toEqual(none);
            expect(shape.bar?.box).toMatchObject({ left: 48, top: 0, right: device.width, height: 46 });
            expect(shape.bar?.title).toBe("Inbox");
            expect(shape.sidebar?.visibility).toBe("hidden");
            expect(shape.pane!.box.top).toBe(46);
          } else {
            expect(shape.bar?.display).toBe("none");
            expect(shape.sidebar?.visibility).toBe("visible");
            expect(shape.sidebar!.box.right).toBeLessThanOrEqual(shape.pane!.box.left);
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("a notice above the app is a flush strip in the flush range", async () => {
    for (const device of [ipadPortrait, laptop]) {
      const { context, page } = await open(device, "/app/mail/inbox?notice=1");
      try {
        const notice = await page.evaluate(() => {
          const card = document.querySelector(".layout-shell-content .k2b-notice-card")!;
          const style = getComputedStyle(card);
          const rect = card.getBoundingClientRect();
          return {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            radius: style.borderTopLeftRadius,
            border: style.borderTopWidth,
          };
        });
        expect(notice).toEqual({ left: 48, right: device.width, top: 0, radius: "0px", border: "0px" });
      } finally {
        await context.close();
      }
    }
  });

  test("neither the controller attaching nor navigating to another page moves any part of the shell", async () => {
    const keys = ["rail", "shell", "workspace", "bar", "sidebar", "pane", "main", "detail", "avatar"] as const;
    const same = (device: Device, step: string, actual: Geometry, expected: Geometry) => {
      for (const key of keys) {
        expect({ device: device.name, step, key, box: actual[key]?.box }).toEqual({
          device: device.name,
          step,
          key,
          box: expected[key]?.box,
        });
      }
    };
    for (const device of devices) {
      const { context, page } = await open(device, "/app/mail/inbox", { attached: false });
      try {
        const served = await geometry(page);
        await attach(page);
        same(device, "attach", await geometry(page), served);
        await page.setContent(await html("/app/mail/archive"));
        await attach(page);
        same(device, "navigate", await geometry(page), served);
      } finally {
        await context.close();
      }
    }
  });
});

describe("compact workspace navigation", () => {
  const state = (page: Page) =>
    page.evaluate(() => {
      const sidebar = document.getElementById("mail-navigation")!;
      const toggle = document.querySelector<HTMLElement>("[data-app-workspace-sidebar-toggle]")!;
      const rect = sidebar.getBoundingClientRect();
      return {
        open: getComputedStyle(sidebar).visibility === "visible",
        expanded: toggle.getAttribute("aria-expanded"),
        controls: toggle.getAttribute("aria-controls"),
        label: toggle.getAttribute("aria-label"),
        focus: document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || "",
        contentInert: document.querySelector(".k2b-app-workspace__content")!.hasAttribute("inert"),
        sidebar: { left: Math.round(rect.left), width: Math.round(rect.width), borders: getComputedStyle(sidebar).borderRightWidth },
        main: Math.round(document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().left),
      };
    });

  for (const language of ["en", "de"] as const) {
    test(`iPad portrait (${language}): the bar's button opens the navigation over the app and every way out returns focus`, async () => {
      const { context, page } = await open(ipadPortrait, "/app/mail/inbox", { language });
      try {
        const closed = await state(page);
        expect(closed).toMatchObject({ open: false, expanded: "false", controls: "mail-navigation", contentInert: false });
        expect(closed.label).toBe(language === "de" ? "Navigation anzeigen" : "Show navigation");

        // A tap opens it over the app; the work area does not move.
        await page.locator("[data-app-workspace-sidebar-toggle]").tap();
        const opened = await state(page);
        expect(opened).toMatchObject({ open: true, expanded: "true", contentInert: true, focus: "Inbox", main: closed.main });
        expect(opened.sidebar.left).toBe(48);
        expect(opened.sidebar.width).toBe(280);
        expect(opened.sidebar.borders).toBe("0px");

        // Tab stays in the navigation; Escape closes it and returns to the button.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        expect((await state(page)).focus).toBe("Sent");
        await page.keyboard.press("Tab");
        expect((await state(page)).focus).toBe("Inbox");
        await page.keyboard.press("Shift+Tab");
        expect((await state(page)).focus).toBe("Sent");
        await page.keyboard.press("Escape");
        expect(await state(page)).toMatchObject({ open: false, expanded: "false", contentInert: false, focus: closed.label });

        // The keyboard opens it too; the scrim closes it.
        await page.keyboard.press("Enter");
        expect((await state(page)).open).toBe(true);
        await page.mouse.click(ipadPortrait.width - 40, ipadPortrait.height / 2);
        expect(await state(page)).toMatchObject({ open: false, focus: closed.label });

        // Choosing a mailbox closes it.
        await page.locator("[data-app-workspace-sidebar-toggle]").click();
        await page.getByText("Archive").click();
        expect(await state(page)).toMatchObject({ open: false, expanded: "false", contentInert: false });
      } finally {
        await context.close();
      }
    });
  }

  test("leaving the compact range closes the navigation", async () => {
    const { context, page } = await open(ipadPortrait, "/app/mail/inbox");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      expect((await state(page)).open).toBe(true);
      await page.setViewportSize({ width: ipadLandscape.width, height: ipadLandscape.height });
      await page.waitForFunction(
        () => document.querySelector("[data-app-workspace-sidebar-toggle]")?.getAttribute("aria-expanded") === "false",
      );
      expect(await state(page)).toMatchObject({ expanded: "false", contentInert: false });
      await page.setViewportSize({ width: ipadPortrait.width, height: ipadPortrait.height });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".k2b-app-workspace__head")!).display === "flex");
      expect((await state(page)).open).toBe(false);
    } finally {
      await context.close();
    }
  });
});

describe("profile menu in the rail", () => {
  test("on a fine pointer the menu opens beside the rail, upward from the avatar, with every profile action", async () => {
    for (const language of ["en", "de"] as const) {
      const { context, page } = await open(laptop, "/app/mail/inbox", { language });
      try {
        await page.locator(".layout-profile-preferences__link").focus();
        const menu = await page.evaluate(() => {
          const avatar = document.querySelector(".layout-profile-preferences__link")!.getBoundingClientRect();
          const panel = document.querySelector<HTMLElement>(".layout-profile-preferences__panel")!;
          const rect = panel.getBoundingClientRect();
          return {
            visible: getComputedStyle(panel).visibility,
            left: Math.round(rect.left),
            bottom: Math.round(rect.bottom),
            top: Math.round(rect.top),
            avatarBottom: Math.round(avatar.bottom),
            avatarTop: Math.round(avatar.top),
            railRight: Math.round(document.querySelector(".layout-rail")!.getBoundingClientRect().right),
            items: [...panel.querySelectorAll(".menu-item")].map((item) => item.textContent?.trim()),
          };
        });
        expect(menu.visible).toBe("visible");
        expect(menu.left).toBeGreaterThanOrEqual(menu.railRight - 8);
        expect(menu.bottom).toBe(menu.avatarBottom);
        expect(menu.top).toBeLessThan(menu.avatarTop);
        expect(menu.items).toEqual(
          language === "de"
            ? ["Dunkler Modus", "English", "Profileinstellungen", "App", "Abmelden"]
            : ["Dark mode", "Deutsch", "Profile settings", "App", "Sign out"],
        );
        // Keyboard users move from the avatar into the menu.
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest(".layout-profile-preferences__panel") !== null)).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  test("on an iPad the avatar is the menu button, and the menu would open upward beside the rail", async () => {
    for (const device of [ipadPortrait, ipadLandscape]) {
      const { context, page } = await open(device, "/app/mail/inbox");
      try {
        const trigger = page.locator(".layout-profile-preferences__dropdown-trigger");
        await expect(trigger.isVisible()).resolves.toBe(true);
        await expect(page.locator(".layout-profile-preferences__link").isVisible()).resolves.toBe(false);
        expect(await page.locator(".layout-profile-preferences [data-position]").getAttribute("data-position")).toBe("right-start");
        // Beside the rail, the avatar's menu cannot open below the window's bottom edge, so it grows upward.
        const avatar = await trigger.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
        const menu = dropdownPosition(avatar, { width: 224, height: 220 }, "right-start", { width: device.width, height: device.height });
        expect(menu.left).toBeGreaterThanOrEqual(avatar.right);
        expect(menu.top + 220).toBeLessThanOrEqual(device.height - 8);
        expect(menu.top).toBeLessThan(avatar.top);
      } finally {
        await context.close();
      }
    }
  });
});

describe("anonymous pages", () => {
  // Without an app bar, the header keeps the phone's app name, help, and search up to lg; from lg it shows the trail.
  const header = (page: Page) =>
    page.evaluate(() => {
      const visible = (element: Element | null) => Boolean(element?.checkVisibility());
      const header = document.querySelector(".layout-header")!;
      return {
        header: getComputedStyle(header).display,
        signIn: visible(header.querySelector('a[href="/auth/login"]')),
        help: visible(header.querySelector('[aria-label="Open help"]')),
        breadcrumbs: visible(header.querySelector("nav")),
        rail: document.querySelector(".layout-rail"),
      };
    });

  for (const device of devices) {
    test(`${device.name}: keep the header with sign-in and no rail`, async () => {
      const { context, page } = await open(device, "/public");
      try {
        expect(await header(page)).toEqual({
          header: "flex",
          signIn: true,
          help: device.width < 1024,
          breadcrumbs: device.width >= 1024,
          rail: null,
        });
      } finally {
        await context.close();
      }
    });
  }
});

describe("phone header", () => {
  test("a long title does not squeeze the Home button", async () => {
    const long = encodeURIComponent("Kundenverwaltung und Abrechnung");
    for (const path of [`/app/mail/inbox?name=${long}`, `/public?title=${long}`]) {
      const { context, page } = await open(phone, path);
      try {
        const home = await page
          .locator('.layout-header a[href="/"]:has(img)')
          .evaluate((link) => link.getBoundingClientRect().toJSON() as DOMRect);
        expect({ path, width: Math.round(home.width), height: Math.round(home.height) }).toEqual({ path, width: 32, height: 32 });
      } finally {
        await context.close();
      }
    }
  });
});
