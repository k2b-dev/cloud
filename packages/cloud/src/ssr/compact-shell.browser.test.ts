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
const { AppWorkspace, Button, dropdownPosition, ScrollArea } = await import("@k2b/ui");
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

/**
 * A task-list page: a long list in Main and an open detail that the server renders with its own close
 * control, as Contacts and Capabilities do. Invented content.
 */
const listWorkspace = () =>
  createComponent(AppWorkspace, {
    class: "min-h-0 flex-1",
    get children() {
      return createComponent(AppWorkspace.Content, {
        get children() {
          return [
            createComponent(AppWorkspace.Main, {
              get children() {
                return Array.from({ length: 80 }, (_, index) =>
                  createComponent(Button, { class: "list-row", align: "start", children: `Task ${index + 1}` }),
                );
              },
            }),
            createComponent(AppWorkspace.Detail, {
              id: "task-detail",
              open: true,
              get children() {
                return createComponent(Button, { "data-workspace-detail-close": "", children: "Close task" });
              },
            }),
          ];
        },
      });
    },
  });

/** A sidebar-first overview that is the page itself, as Mail and Notebooks render. Invented content. */
const overviewWorkspace = () =>
  createComponent(AppWorkspace, {
    mobileSurface: "flush",
    flat: true,
    resizable: false,
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "overview-navigation",
          label: "Mailboxes",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  get children() {
                    return ["Personal", "Projects", "Support"].map((name) =>
                      createComponent(AppWorkspace.SidebarItem, { href: `#${name.toLowerCase()}`, children: name }),
                    );
                  },
                });
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() {
            return createComponent(AppWorkspace.Main, {
              get children() {
                return Array.from({ length: 80 }, (_, index) =>
                  createComponent(Button, { class: "overview-row", align: "start", children: `Message ${index + 1}` }),
                );
              },
            });
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
      // `?overview=` keeps regular Layout props, including its page scroller's gutter.
      if (c.req.query("overview"))
        return () =>
          createComponent(Layout, {
            c: c as unknown as LayoutContextArg,
            title: [{ title: "Home", href: "/" }, { title: "Mail" }],
            get children() {
              return overviewWorkspace();
            },
          });
      // `?cards=` renders a page without a workspace that scrolls its content in a ScrollArea, as
      // Capabilities and Weather do.
      if (c.req.query("cards"))
        return () =>
          createComponent(Layout, {
            c: c as unknown as LayoutContextArg,
            fullWidth: true,
            title: [{ title: "Home", href: "/" }, { title: "Capabilities" }],
            get children() {
              return createComponent(ScrollArea, {
                class: "min-h-0 min-w-0 flex-1",
                get children() {
                  return Array.from({ length: 60 }, (_, index) =>
                    createComponent(Button, { class: "card-row", align: "start", children: `App ${index + 1}` }),
                  );
                },
              });
            },
          });
      // `?list=` renders the task list: `scroll` in a page that grows with its content, `page` in a full page.
      const list = c.req.query("list");
      if (list)
        return () =>
          createComponent(Layout, {
            c: c as unknown as LayoutContextArg,
            fullWidth: true,
            fullPage: list === "page",
            title: [{ title: "Home", href: "/" }, { title: "Tasks" }],
            get children() {
              return listWorkspace();
            },
          });
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
          get children() {
            return c.req.query("overview") ? overviewWorkspace() : "Public content";
          },
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
const ipadSplitView: Device = { name: "iPad Split View", width: 694, height: 834, touch: true };
const ipadPortrait: Device = { name: "iPad portrait", width: 834, height: 1194, touch: true };
const smallLaptop: Device = { name: "small laptop", width: 1024, height: 768, touch: false };
const ipadLandscape: Device = { name: "iPad landscape", width: 1194, height: 834, touch: true };
const laptop: Device = { name: "laptop", width: 1440, height: 900, touch: false };
const desktop: Device = { name: "desktop", width: 1920, height: 1080, touch: false };
const devices = [phone, ipadSplitView, ipadPortrait, smallLaptop, ipadLandscape, laptop, desktop];
const flushBoundary: Device = { name: "flush boundary", width: 1023, height: 768, touch: false };

// The signed-in card's spacing and radius in whole pixels: 4 and 10 px at 1024 px, 8 and 14 px from 1440 px.
const cardInset = (width: number) => Math.round(Math.min(8, Math.max(4, 4 + (width - 1024) / 104)));
const cardRadius = (width: number) => Math.round(Math.min(14, Math.max(10, 10 + (width - 1024) / 104)));

type Options = { language?: "en" | "de"; theme?: "light" | "dark"; notice?: boolean; style?: string };
const html = async (path: string, options: Options = {}) => {
  const headers = {
    "Accept-Language": options.language ?? "en",
    Cookie: `theme=${options.theme ?? "light"}`,
  };
  const markup = await (await server.request(path, { headers })).text();
  return markup.replace(
    "</head>",
    `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}${options.style ?? ""}</style></head>`,
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
  // iPads and phones report a coarse pointer without hover, as Safari does. A page set from markup has
  // no cookies in WebKit, so the theme script follows the system scheme; it matches the requested theme.
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.touch,
    isMobile: device.touch,
    colorScheme: options.theme ?? "light",
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

const geometry = (page: Page, rounded = true): Promise<Geometry> =>
  page.evaluate((rounded) => {
    const coordinate = (value: number) => (rounded ? Math.round(value) : value);
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        left: coordinate(rect.left),
        top: coordinate(rect.top),
        right: coordinate(rect.right),
        bottom: coordinate(rect.bottom),
        width: coordinate(rect.width),
        height: coordinate(rect.height),
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
  }, rounded);

const none = [0, 0, 0, 0];
const flush = (device: Device) => device.width >= 768 && device.width < 1024;
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
            expect(shape.workspace?.box).toMatchObject({ right: device.width, bottom: device.height });
            return;
          }
          expect(shape.header).toBe("none");
          expect(shape.rail?.display).toBe("flex");
          expect(shape.rail?.box.left).toBe(0);
          expect(shape.rail?.box.width).toBe(56);
          expect(shape.rail?.box.right).toBe(56);
          // Nothing draws the rail/app boundary: no border on either side and no divider element.
          expect(shape.rail?.borders).toEqual(none);
          expect(shape.shell?.borders).toEqual(none);
          expect(shape.hairlines).toEqual([]);
          // The avatar is the rail's last control.
          expect(shape.avatar).not.toBeNull();
          expect(shape.avatar!.box.left).toBeGreaterThanOrEqual(0);
          expect(shape.avatar!.box.right).toBeLessThanOrEqual(56);
          expect(shape.rail!.box.bottom - shape.avatar!.box.bottom).toBeLessThanOrEqual(12);
          if (flush(device)) {
            // Flush: the app area meets the top, right, and bottom window edges and has no frame.
            expect(shape.shell?.box).toMatchObject({ left: 56, top: 0, right: device.width, bottom: device.height });
            expect(shape.rail?.box).toMatchObject({ top: 0, bottom: device.height });
            expect(shape.workspace?.box).toMatchObject({ left: 56, top: 0, right: device.width, bottom: device.height });
            expect(shape.workspace?.borders).toEqual(none);
            expect(shape.workspace?.radius).toBe("0px");
            expect(shape.workspace?.shadow).toBe("none");
            // An opaque surface, so the app canvas shows only behind the rail.
            expect(shape.shell?.background).toMatch(/^rgb\(/);
          } else {
            // From 1024 px the card's spacing and radius grow until 1440 px.
            const precise = await geometry(page, false);
            const box = precise.workspace!.box;
            const gaps = [box.top, device.width - box.right, device.height - box.bottom];
            const radius = Number.parseFloat(precise.workspace!.radius);
            expect(box.left).toBe(56);
            for (const gap of gaps) expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
            expect(Math.abs(radius - cardRadius(device.width))).toBeLessThanOrEqual(0.05);
            if (device.width === 1024) {
              for (const gap of gaps) expect(gap).toBe(4);
              expect(radius).toBe(10);
            } else if (device.width >= 1440) {
              for (const gap of gaps) expect(gap).toBe(8);
              expect(radius).toBe(14);
            } else if (device.width === 1194) {
              // The dense tablet mockup's card: 6 px spacing and a 12 px radius.
              for (const gap of gaps) expect(gap).toBe(6);
              expect(radius).toBe(12);
            }
            expect(shape.workspace?.shadow).not.toBe("none");
          }
          // Sidebar and Main draw no lines. List/reader panes keep their
          // separator; the raised detail floats without one.
          expect(shape.sidebar?.borders).toEqual(none);
          expect(shape.main?.borders).toEqual(none);
          expect(shape.pane?.borders).toEqual([0, 1, 0, 0]);
          expect(shape.detail?.borders).toEqual([0, 0, 0, 0]);
          // List and reader stay side by side; the detail spans the workspace.
          expect(shape.pane!.box.right).toBeLessThanOrEqual(shape.detail!.box.left);
          expect(shape.detail!.box.top).toBe(shape.workspace!.box.top + shape.workspace!.borders[0]! + 8);
          if (compact(device)) {
            expect(shape.bar?.display).toBe("flex");
            expect(shape.bar?.borders).toEqual(none);
            // The 320 px detail and its 8 px right inset still reserve a 328 px track.
            expect(shape.detail!.box.width).toBe(320);
            expect(shape.bar?.box).toMatchObject({ left: 56, top: 0, right: device.width - (320 + 8), height: 46 });
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

  test("a notice above the app is a flush strip in the flush range and a card from 1024 px", async () => {
    for (const device of [ipadPortrait, flushBoundary, ipadLandscape]) {
      const { context, page } = await open(device, "/app/mail/inbox?notice=1");
      try {
        const notice = await page.evaluate(() => {
          const card = document.querySelector(".layout-shell-content .k2b-notice-card")!;
          const style = getComputedStyle(card);
          const rect = card.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            radius: style.borderTopLeftRadius,
            border: style.borderTopWidth,
          };
        });
        expect(notice.left).toBe(56);
        if (flush(device)) {
          expect(notice).toEqual({ left: 56, right: device.width, top: 0, radius: "0px", border: "0px" });
        } else {
          expect(Math.abs(notice.top - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(Math.abs(device.width - notice.right - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(Number.parseFloat(notice.radius)).toBeGreaterThan(0);
          expect(notice.border).toBe("1px");
        }
      } finally {
        await context.close();
      }
    }
  });

  test("neither the controller attaching nor navigating to another page moves any part of the shell", async () => {
    const keys = ["rail", "shell", "workspace", "bar", "sidebar", "pane", "main", "detail", "avatar"] as const;
    const same = (device: Device, step: string, actual: Geometry, expected: Geometry) => {
      for (const key of keys) {
        const box = actual[key]?.box;
        const reference = expected[key]?.box;
        expect({ device: device.name, step, key, present: !!box }).toEqual({ device: device.name, step, key, present: !!reference });
        if (box && reference) {
          for (const edge of ["left", "top", "right", "bottom", "width", "height"] as const)
            expect(Math.abs(box[edge] - reference[edge]), `${device.name} ${step} ${key}.${edge}`).toBeLessThanOrEqual(0.01);
        }
      }
    };
    const noOverflow = async (page: Page) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    for (const device of devices) {
      const { context, page } = await open(device, "/app/mail/inbox", { attached: false });
      try {
        const served = await geometry(page, false);
        await noOverflow(page);
        await attach(page);
        same(device, "attach", await geometry(page, false), served);
        await noOverflow(page);
        // Reload the same server path and attach again, without relying on a live HTTP server.
        await page.setContent(await html("/app/mail/inbox"));
        same(device, "reload served", await geometry(page, false), served);
        await attach(page);
        same(device, "reload attached", await geometry(page, false), served);
        await noOverflow(page);
        await page.setContent(await html("/app/mail/archive"));
        await attach(page);
        same(device, "navigate", await geometry(page, false), served);
        await noOverflow(page);
      } finally {
        await context.close();
      }
    }
  });

  for (const device of [ipadPortrait, smallLaptop, ipadLandscape, laptop, desktop]) {
    test(`${device.name}: a page without a workspace follows the card rule`, async () => {
      const { context, page } = await open(device, "/app/mail/inbox?cards=1");
      try {
        const shape = await geometry(page, false);
        expect(shape.workspace).toBeNull();
        expect(shape.shell!.box.left).toBe(56);
        if (flush(device)) {
          expect(shape.shell!.box).toMatchObject({ top: 0, right: device.width, bottom: device.height });
          expect(shape.shell!.background).toMatch(/^rgb\(/);
        } else {
          const box = shape.shell!.box;
          for (const gap of [box.top, device.width - box.right, device.height - box.bottom])
            expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(shape.shell!.background).toBe("rgba(0, 0, 0, 0)");
        }
      } finally {
        await context.close();
      }
    });
  }

  for (const device of [{ name: "rail boundary", width: 768, height: 1024, touch: true }, ipadPortrait, ipadLandscape, laptop, desktop]) {
    test(`${device.width}×${device.height}: rail controls are 44 px targets inside the 56 px rail`, async () => {
      const { context, page } = await open(device, "/app/mail/inbox");
      try {
        const controls = await page.evaluate(() => {
          const rail = document.querySelector(".layout-rail")!.getBoundingClientRect();
          const items = [...document.querySelectorAll(".layout-rail .rail-item")].filter((item) => item.checkVisibility());
          const avatar = [
            ...document.querySelectorAll(
              ".layout-rail .layout-profile-preferences__link, .layout-rail .layout-profile-preferences__dropdown-trigger",
            ),
          ].find((item) => item.checkVisibility())!;
          const box = (element: Element) => {
            const { left, right, width, height } = element.getBoundingClientRect();
            return { left, right, width, height };
          };
          return {
            rail: { left: rail.left, right: rail.right },
            items: items.map(box),
            avatar: box(avatar),
          };
        });
        expect(controls.rail).toEqual({ left: 0, right: 56 });
        expect(controls.items.length).toBeGreaterThan(0);
        for (const box of [...controls.items, controls.avatar]) {
          expect(box.width).toBe(44);
          expect(box.height).toBe(44);
          expect(box.left).toBeGreaterThanOrEqual(controls.rail.left);
          expect(box.right).toBeLessThanOrEqual(controls.rail.right);
        }
      } finally {
        await context.close();
      }
    });
  }
});

describe("the app card keeps its rounded corners", () => {
  const pages = [
    { name: "framed workspace", path: "/app/mail/inbox?list=scroll" },
    { name: "flat overview", path: "/app/mail/inbox?overview=1" },
  ];
  type CardGeometry = {
    box: Box;
    railRight: number | null;
    radii: string[];
    expectedRadius: string;
    shellSpacing: number;
    shadow: string;
    workspaceScroll: { top: number; end: number };
    pageScroll: { height: number; clientHeight: number; width: number; clientWidth: number };
  };
  const cardGeometry = (page: Page): Promise<CardGeometry> =>
    page.evaluate(async () => {
      const workspace = document.querySelector<HTMLElement>(".layout-content-main .k2b-app-workspace")!;
      const main = workspace.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
      const pageMain = document.querySelector<HTMLElement>(".layout-content-main")!;
      // Resolve the host's tokens on the workspace, including var() and rem values.
      const probe = document.createElement("span");
      const signedIn = !!workspace.closest("[data-layout-authenticated]");
      probe.style.cssText = signedIn
        ? "position:absolute;pointer-events:none;width:var(--cloud-card-inset);border-radius:var(--cloud-card-radius)"
        : "position:absolute;pointer-events:none;width:var(--ui-space-shell);border-radius:var(--k2b-radius-dialog)";
      workspace.append(probe);
      const expectedRadius = getComputedStyle(probe).borderTopLeftRadius;
      const shellSpacing = Number.parseFloat(getComputedStyle(probe).width);
      probe.remove();
      const rect = workspace.getBoundingClientRect();
      const style = getComputedStyle(workspace);
      // The corners are sampled with the content scrolled to its end, not on the first rows.
      main.scrollTop = main.scrollHeight;
      await new Promise<void>((settle) => requestAnimationFrame(() => settle()));
      return {
        box: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        railRight: document.querySelector(".layout-rail")?.getBoundingClientRect().right ?? null,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
        expectedRadius,
        shellSpacing,
        shadow: style.boxShadow,
        workspaceScroll: { top: main.scrollTop, end: main.scrollHeight - main.clientHeight },
        pageScroll: {
          height: pageMain.scrollHeight,
          clientHeight: pageMain.clientHeight,
          width: pageMain.scrollWidth,
          clientWidth: pageMain.clientWidth,
        },
      };
    });

  /**
   * Reads what the engine painted at the card's corners. Every part of the workspace and its text is
   * filled red first, so a part that reaches past the rounded corner shows in the pixel one step inside
   * the box's corner, which lies outside the card. Hit testing cannot tell this: WebKit ignores a
   * rounded clip there.
   */
  const cornerPaint = async (page: Page, box: Box) => {
    await page.addStyleTag({
      content:
        ".layout-content-main .k2b-app-workspace, .layout-content-main .k2b-app-workspace * { background: rgb(255 0 0) !important; color: rgb(255 0 0) !important; }",
    });
    const corners = [
      { corner: "top left", x: box.left, y: box.top, dx: 1, dy: 1 },
      { corner: "top right", x: box.right - 1, y: box.top, dx: -1, dy: 1 },
      { corner: "bottom right", x: box.right - 1, y: box.bottom - 1, dx: -1, dy: -1 },
      { corner: "bottom left", x: box.left, y: box.bottom - 1, dx: 1, dy: -1 },
    ];
    const shot = (await page.screenshot()).toString("base64");
    return page.evaluate(
      async ({ shot, corners }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const filled = (x: number, y: number) => {
          const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
          return red! > 200 && green! < 60 && blue! < 60;
        };
        return corners.map(({ corner, x, y, dx, dy }) => ({
          corner,
          outside: filled(x + dx, y + dy),
          inside: filled(x + 48 * dx, y + 48 * dy),
        }));
      },
      { shot, corners },
    );
  };

  /** Reads the RGB values the engine painted at the given viewport points. */
  const pixels = async (page: Page, points: { x: number; y: number }[]) => {
    const shot = (await page.screenshot()).toString("base64");
    return page.evaluate(
      async ({ shot, points }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
      },
      { shot, points },
    );
  };
  /** The largest channel difference between two pixel lists of the same points. */
  const difference = (a: number[][], b: number[][]) =>
    Math.max(...a.flatMap((pixel, index) => pixel.map((channel, rgb) => Math.abs(channel - b[index]![rgb]!))));

  /**
   * Reads what the engine painted in the shell spacing below the middle of the card's bottom edge, once
   * as served and once with the card's shadow removed. A computed `box-shadow` alone cannot tell whether
   * a scrolling ancestor clips the shadow away.
   */
  const shadowPaint = async (page: Page, box: Box, shellSpacing: number) => {
    const x = Math.round((box.left + box.right) / 2);
    const points = Array.from({ length: Math.max(1, Math.floor(shellSpacing) - 2) }, (_, step) => ({ x, y: box.bottom + 1 + step }));
    const painted = await pixels(page, points);
    const unshadowed = await page.addStyleTag({ content: ".layout-content-main .k2b-app-workspace { box-shadow: none !important; }" });
    const bare = await pixels(page, points);
    await unshadowed.evaluate((tag) => tag.parentNode?.removeChild(tag));
    return { painted, shadowDepth: difference(painted, bare) };
  };

  /**
   * Reads the paint one step inside each corner of the card's box, outside its rounded edge, once as
   * served and once with everything inside the card hidden. Unlike `cornerPaint`, it also sees paint the
   * red fill cannot reach, such as a shadow or a scrollbar of a part inside the card.
   */
  const cornerLeak = async (page: Page, box: Box) => {
    const points = [
      { x: box.left + 1, y: box.top + 1 },
      { x: box.right - 2, y: box.top + 1 },
      { x: box.right - 2, y: box.bottom - 2 },
      { x: box.left + 1, y: box.bottom - 2 },
    ];
    const served = await pixels(page, points);
    const emptied = await page.addStyleTag({ content: ".layout-content-main .k2b-app-workspace > * { opacity: 0 !important; }" });
    const empty = await pixels(page, points);
    await emptied.evaluate((tag) => tag.parentNode?.removeChild(tag));
    return difference(served, empty);
  };

  for (const device of [smallLaptop, ipadLandscape, laptop, desktop]) {
    test(`${device.width}×${device.height}: flat and framed cards share their frame, spacing, and corner clipping`, async () => {
      let framed: CardGeometry | undefined;
      let framedShadow: number[][] | undefined;
      for (const { name, path } of pages) {
        const { context, page } = await open(device, path);
        try {
          const shape = await cardGeometry(page);
          // The flat card paints the same shadow below its box as the framed one.
          const shadow = await shadowPaint(page, shape.box, shape.shellSpacing);
          expect(shadow.shadowDepth).toBeGreaterThanOrEqual(2);
          if (framedShadow) expect(difference(shadow.painted, framedShadow)).toBeLessThanOrEqual(1);
          else framedShadow = shadow.painted;
          // Nothing inside the flat card paints past its rounded corners, with its content scrolled to
          // the end. The framed fixture's open detail panel casts its shadow beyond the card on purpose.
          if (name === "flat overview") expect(await cornerLeak(page, shape.box)).toBeLessThanOrEqual(1);
          expect(Number.parseFloat(shape.expectedRadius)).toBeGreaterThan(0);
          expect(shape.radii).toEqual(Array(4).fill(shape.expectedRadius));
          for (const radius of shape.radii) expect(Number.parseFloat(radius)).toBeGreaterThan(0);
          expect(shape.shadow).not.toBe("none");
          expect(Math.abs(shape.shellSpacing - cardInset(device.width))).toBeLessThanOrEqual(0.05);
          for (const radius of shape.radii)
            expect(Math.abs(Number.parseFloat(radius) - cardRadius(device.width))).toBeLessThanOrEqual(0.05);
          expect(shape.railRight).toBe(56);
          expect(shape.box.left).toBe(56);
          for (const gap of [shape.box.top, device.width - shape.box.right, device.height - shape.box.bottom])
            expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(shape.workspaceScroll.top).toBeGreaterThan(0);
          expect(shape.workspaceScroll.top).toBeCloseTo(shape.workspaceScroll.end, 0);
          for (const corner of await cornerPaint(page, shape.box))
            expect(corner).toEqual({ corner: corner.corner, outside: false, inside: true });
          expect(shape.pageScroll.height).toBeLessThanOrEqual(shape.pageScroll.clientHeight);
          expect(shape.pageScroll.width).toBeLessThanOrEqual(shape.pageScroll.clientWidth);
          if (framed) {
            expect(shape.radii).toEqual(framed.radii);
            expect(shape.shadow).toBe(framed.shadow);
            expect(shape.box).toEqual(framed.box);
          } else framed = shape;
        } finally {
          await context.close();
        }
      }
    });
  }

  for (const device of [flushBoundary, ipadPortrait]) {
    test(`${device.width}×${device.height}: flat and framed workspaces fill the flush app area without a frame`, async () => {
      let framed: CardGeometry | undefined;
      for (const { path } of pages) {
        const { context, page } = await open(device, path);
        try {
          const shape = await cardGeometry(page);
          expect(shape.radii).toEqual(Array(4).fill("0px"));
          expect(shape.shadow).toBe("none");
          expect(shape.box).toMatchObject({ left: shape.railRight, top: 0, right: device.width, bottom: device.height });
          if (framed) expect(shape.box).toEqual(framed.box);
          else framed = shape;
        } finally {
          await context.close();
        }
      }
    });
  }

  test("phone: a flat overview keeps square corners and no shadow", async () => {
    const { context, page } = await open(phone, "/app/mail/inbox?overview=1");
    try {
      const shape = await cardGeometry(page);
      expect(shape.radii).toEqual(Array(4).fill("0px"));
      expect(shape.shadow).toBe("none");
    } finally {
      await context.close();
    }
  });

  test("1920×1080 dark: flat and framed cards share their border and painted shadow", async () => {
    const cards: { border: string; shadow: number[][] }[] = [];
    for (const { path } of pages) {
      const { context, page } = await open(desktop, path, { theme: "dark" });
      try {
        expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
        const shape = await cardGeometry(page);
        const border = await page.evaluate(
          () => getComputedStyle(document.querySelector(".layout-content-main .k2b-app-workspace")!).borderTopColor,
        );
        const shadow = await shadowPaint(page, shape.box, shape.shellSpacing);
        expect(shadow.shadowDepth).toBeGreaterThanOrEqual(2);
        if (cards[0]) expect(difference(shadow.painted, cards[0].shadow)).toBeLessThanOrEqual(1);
        cards.push({ border, shadow: shadow.painted });
      } finally {
        await context.close();
      }
    }
    expect(cards[0]!.border).not.toBe("rgba(0, 0, 0, 0)");
    expect(cards[1]!.border).toBe(cards[0]!.border);
  });

  test("anonymous 1024×768: a flat workspace already has the card's radius and shadow", async () => {
    const { context, page } = await open({ name: "anonymous laptop", width: 1024, height: 768, touch: false }, "/public?overview=1");
    try {
      const shape = await cardGeometry(page);
      expect(Number.parseFloat(shape.expectedRadius)).toBeGreaterThan(0);
      expect(shape.radii).toEqual(Array(4).fill(shape.expectedRadius));
      expect(shape.shellSpacing).toBe(8);
      expect(shape.shadow).not.toBe("none");
      expect((await shadowPaint(page, shape.box, shape.shellSpacing)).shadowDepth).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});

describe("a page that scrolls its content in a ScrollArea", () => {
  // Phones draw overlay scrollbars; styled ones take space, as classic scrollbars do in desktop browsers.
  // WebKit applies them only to scrollers laid out after the style, so the page loads with it. The
  // 1024 px case shows that the styled scrollbars take space.
  const style =
    "*::-webkit-scrollbar { width: 12px; height: 12px; background: rgb(221 221 221); } *::-webkit-scrollbar-thumb { background: rgb(136 136 136); } * { scrollbar-width: auto !important; scrollbar-color: auto !important; } .card-row { display: flex; width: 100%; }";
  const scrolling = (page: Page) =>
    page.evaluate(() => {
      const area = document.querySelector<HTMLElement>(".layout-content-main > .k2b-scroll-area")!;
      const root = document.documentElement;
      return {
        areaGutter: area.offsetWidth - area.clientWidth,
        areaScrolls: area.scrollHeight > area.clientHeight,
        documentScrolls: root.scrollHeight > root.clientHeight,
      };
    });

  test("600×900: the document scrolls, and the area reserves no second gutter", async () => {
    const { context, page } = await open({ name: "narrow window", width: 600, height: 900, touch: false }, "/app/mail/inbox?cards=1", {
      style,
    });
    try {
      expect(await scrolling(page)).toEqual({ areaGutter: 0, areaScrolls: false, documentScrolls: true });
    } finally {
      await context.close();
    }
  });

  test("1024×768: the area scrolls and keeps its stable gutter", async () => {
    const { context, page } = await open({ name: "small laptop", width: 1024, height: 768, touch: false }, "/app/mail/inbox?cards=1", {
      style,
    });
    try {
      expect(await scrolling(page)).toEqual({ areaGutter: 12, areaScrolls: true, documentScrolls: false });
    } finally {
      await context.close();
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
        expect(opened.sidebar.left).toBe(56);
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
            avatarWidth: avatar.width,
            avatarHeight: avatar.height,
            avatarLeft: avatar.left,
            avatarRight: avatar.right,
            railRight: Math.round(document.querySelector(".layout-rail")!.getBoundingClientRect().right),
            appearanceLabel: panel.querySelector(".menu-item")?.getAttribute("aria-label"),
            radios: panel.querySelectorAll('[role="radio"]').length,
            items: [...panel.querySelectorAll(".menu-item")].map((item) => item.textContent?.trim()),
          };
        });
        expect(menu.visible).toBe("visible");
        expect(menu.railRight).toBe(56);
        expect(menu.avatarWidth).toBe(44);
        expect(menu.avatarHeight).toBe(44);
        expect(menu.avatarLeft).toBeGreaterThanOrEqual(0);
        expect(menu.avatarRight).toBeLessThanOrEqual(56);
        expect(menu.left).toBeGreaterThanOrEqual(menu.railRight - 8);
        expect(menu.bottom).toBe(menu.avatarBottom);
        expect(menu.top).toBeLessThan(menu.avatarTop);
        expect(menu.items).toEqual(
          language === "de"
            ? ["Hell", "English", "Profileinstellungen", "App", "Abmelden"]
            : ["Light", "Deutsch", "Profile settings", "App", "Sign out"],
        );
        expect(menu.radios).toBe(0);
        expect(menu.appearanceLabel).toBe(
          language === "de" ? "Darstellung: Hell. Wechselt zu Dunkel." : "Appearance: Light. Switches to Dark.",
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
        expect(avatar.width).toBe(44);
        expect(avatar.height).toBe(44);
        expect(avatar.left).toBeGreaterThanOrEqual(0);
        expect(avatar.right).toBeLessThanOrEqual(56);
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

describe("workspace detail", () => {
  // Pages that are not `fullPage` grow with their content on a phone, so the sheet must not hang from the
  // bottom of the content area: it belongs to the window.
  for (const list of ["scroll", "page"] as const) {
    test(`phone, ${list === "scroll" ? "a page that grows with its list" : "a full page"}: the half sheet sits at the window's bottom edge and the last row scrolls above it`, async () => {
      const { context, page } = await open(phone, `/app/mail/inbox?list=${list}`);
      try {
        const sheet = await page
          .locator(".k2b-app-workspace__detail")
          .evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
        expect(Math.round(sheet.bottom)).toBe(phone.height);
        expect(sheet.height).toBeCloseTo(phone.height * 0.55, 0);
        const last = await page.evaluate(() => {
          const main = document.querySelector(".k2b-app-workspace__main")!;
          main.scrollTop = main.scrollHeight;
          window.scrollTo(0, document.scrollingElement!.scrollHeight);
          return [...document.querySelectorAll(".list-row")].at(-1)!.getBoundingClientRect().bottom;
        });
        expect(last).toBeLessThanOrEqual(sheet.top);
      } finally {
        await context.close();
      }
    });
  }

  test("iPad portrait: a server-rendered panel with its own close control overlays Main as a drawer", async () => {
    const { context, page } = await open(ipadPortrait, "/app/mail/inbox?list=page");
    try {
      const widths = await page.evaluate(() =>
        [".k2b-app-workspace__content", ".k2b-app-workspace__main"].map((selector) =>
          Math.round(document.querySelector(selector)!.getBoundingClientRect().width),
        ),
      );
      expect(widths[1]).toBe(widths[0]!);
    } finally {
      await context.close();
    }
  });
});
