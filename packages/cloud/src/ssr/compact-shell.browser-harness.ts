import { afterAll, beforeAll, setDefaultTimeout, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { createComponent } from "solid-js";
import type { launchBrowser } from "../../../ui/test/browser";

// The shell's geometry at every width — which chrome exists, where the app
// area ends, which edges draw lines — is decided by real layout, so a real
// engine loads the server-rendered Layout with the global stylesheet and the
// shared workspace controller, as Cloud serves them.
const root = mkdtempSync(resolve(tmpdir(), "cloud-compact-shell-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Hono } = await import("hono");
const { AppWorkspace, Button, ScrollArea } = await import("@k2b/ui");
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
const extraApps = ["Amber", "Birch", "Cedar", "Dune", "Elm"].map((name) => ({
  id: name.toLowerCase(),
  name,
  icon: "ti ti-box",
  description: `${name} demo`,
  routes: [`/app/${name.toLowerCase()}`],
  nav: { href: `/app/${name.toLowerCase()}`, section: "primary" },
}));
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
    "/",
    async (c, next) => {
      c.set("runtime" as never, { apps } as never);
      c.set("user" as never, person as never);
      await next();
    },
    ...probe.ssr((c) => () => createComponent(Layout, { c: c as unknown as LayoutContextArg, title: "Start", children: "Start content" })),
  )
  .get(
    "/app/mail/:folder",
    async (c, next) => {
      // `?name=` renames Mail, for a long app name in the phone header.
      const name = c.req.query("name");
      const catalog = c.req.query("catalog") ? [...extraApps, ...apps] : apps;
      c.set("runtime" as never, { apps: name ? catalog.map((app) => (app.id === "mail" ? { ...app, name } : app)) : catalog } as never);
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
      // `?plain=` renders a regular page without a workspace or scroll area: `main` is its page scroller.
      if (c.req.query("plain"))
        return () =>
          createComponent(Layout, {
            c: c as unknown as LayoutContextArg,
            title: [{ title: "Home", href: "/" }, { title: "Settings" }],
            get children() {
              return Array.from({ length: 60 }, (_, index) =>
                createComponent(Button, { class: "plain-row w-full", align: "start", children: `Setting ${index + 1}` }),
              );
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
                    createComponent(Button, { class: "card-row w-full", align: "start", children: `App ${index + 1}` }),
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
            if (c.req.query("cards"))
              return createComponent(ScrollArea, {
                get children() {
                  return Array.from({ length: 60 }, (_, index) =>
                    createComponent(Button, { class: "card-row", children: `App ${index + 1}` }),
                  );
                },
              });
            return c.req.query("overview") ? overviewWorkspace() : "Public content";
          },
        }),
    ),
  );

let browser: Browser;
let css: string;
let controller: string;
const spies: { mockRestore(): void }[] = [];
// Register hooks in each importing test file; Bun caches this module across files.
// Keeping hooks at module scope would leave the second file with a closed browser.
/**
 * Each suite passes `launchBrowser` from packages/ui/test/browser itself, so the test runner and the
 * browser-launch check find it as a browser suite and the gate also runs it in WebKit.
 */
export function installCompactShellHarness(launch: typeof launchBrowser) {
  // Several tests walk every device, each in a fresh browser context. Bun scopes the default timeout to
  // the test file that sets it, and this module runs once per process, so each suite sets it here.
  setDefaultTimeout(30_000);
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
    browser = await launch();
  }, 60_000);
  afterAll(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await browser?.close();
  });
}

export type Device = { name: string; width: number; height: number; touch: boolean };
export const phone: Device = { name: "phone", width: 390, height: 844, touch: true };
export const ipadSplitView: Device = { name: "iPad Split View", width: 694, height: 834, touch: true };
export const ipadPortrait: Device = { name: "iPad portrait", width: 834, height: 1194, touch: true };
export const smallLaptop: Device = { name: "small laptop", width: 1024, height: 768, touch: false };
export const ipadLandscape: Device = { name: "iPad landscape", width: 1194, height: 834, touch: true };
export const laptop: Device = { name: "laptop", width: 1440, height: 900, touch: false };
export const desktop: Device = { name: "desktop", width: 1920, height: 1080, touch: false };
export const devices = [phone, ipadSplitView, ipadPortrait, smallLaptop, ipadLandscape, laptop, desktop];
export const tabletBoundary: Device = { name: "tablet boundary", width: 1023, height: 768, touch: false };

// The signed-in card's spacing and radius in whole pixels: 4 and 10 px at 1024 px, 8 and 14 px from 1440 px.
export const cardInset = (width: number) => Math.round(Math.min(8, Math.max(4, 4 + (width - 1024) / 104)));
export const cardRadius = (width: number) => Math.round(Math.min(14, Math.max(10, 10 + (width - 1024) / 104)));

export type Options = {
  language?: "en" | "de";
  theme?: "light" | "dark";
  notice?: boolean;
  style?: string;
  insets?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
};
// Match the existing app-canvas safe-area fixture: engines cannot override env().
export const withInsets = (stylesheet: string, insets: Options["insets"] = {}) => {
  for (const [side, inset] of Object.entries(insets)) {
    const pattern = new RegExp(`env\\(\\s*safe-area-inset-${side}\\s*(?:,\\s*0px\\s*)?\\)`, "g");
    if (!pattern.test(stylesheet)) throw new Error(`Missing safe-area-inset-${side}`);
    stylesheet = stylesheet.replace(pattern, `${inset}px`);
  }
  return stylesheet;
};
export const html = async (path: string, options: Options = {}) => {
  const headers = {
    "Accept-Language": options.language ?? "en",
    Cookie: `theme=${options.theme ?? "light"}`,
  };
  const markup = await (await server.request(path, { headers })).text();
  const clean = new HTMLRewriter()
    .on('script[src], script[type="module"]', { element: (element) => void element.remove() })
    .on('link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]', { element: (element) => void element.remove() })
    .transform(markup);
  return clean.replace(
    "</head>",
    `<style>${withInsets(css, options.insets)}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}${options.style ?? ""}</style></head>`,
  );
};

/** Attaches the controller as Cloud's island does after the first paint, and lets its first frame run. */
export const attach = async (page: Page) => {
  await page.addScriptTag({ content: controller });
  await page.evaluate(async () => {
    (window as unknown as { installController: () => void }).installController();
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
  });
};

export const open = async (
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
