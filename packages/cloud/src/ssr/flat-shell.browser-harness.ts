import { afterAll, beforeAll, setDefaultTimeout, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import type { launchBrowser } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// The flat shell as a person sees it: the server-rendered Layout with the global stylesheet and the shared
// workspace controller, around three invented pages that use only public @k2b/ui parts: a task list with tabs, a
// status row, and an open detail (Spaces); a folder with a path and a view segment (Files); and a note in a reading
// column (Notebooks). Every name and number is invented.
const root = mkdtempSync(resolve(tmpdir(), "cloud-flat-shell-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const ui = await import("@k2b/ui");
const { AppWorkspace, Breadcrumbs, Button, DataTable, DetailPanel, FloatingPill, IconButton, SegmentedControl, StatusRow, ViewTabs } = ui;
const { Hono } = await import("hono");
const { Dynamic } = await import("solid-js/web");
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");

const probe = defineApp({
  id: "flat-shell-probe",
  name: "Flat shell probe",
  icon: "ti ti-layout",
  description: "Flat shell probe",
  baseUrl: "http://flat-shell-probe:3000",
  routes: ["/app/spaces", "/app/files", "/app/notebooks", "/app/mail"],
});
const apps = [
  { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban", accent: "#4d7c0f", from: "#65a30d", to: "#84cc16" },
  { id: "files", name: "Files", icon: "ti ti-folder", accent: "#1d4ed8", from: "#2563eb", to: "#60a5fa" },
  { id: "notebooks", name: "Notebooks", icon: "ti ti-notebook", accent: "#a16207", from: "#eab308", to: "#facc15" },
  { id: "mail", name: "Mail", icon: "ti ti-mail", accent: "#0f766e", from: "#0f766e", to: "#2563eb" },
].map(({ accent, from, to, ...app }) => ({
  ...app,
  description: app.name,
  routes: [`/app/${app.id}`],
  nav: { href: `/app/${app.id}`, section: "primary" },
  appearance: { accent, background: { from, to } },
}));

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
const h = createComponent;
const icon = (name: string) => createComponent(Dynamic, { component: "i", class: name, "aria-hidden": "true" });

type Task = { id: string; title: string; space: string; due: string; who: string; state: string };
const tasks: Task[] = [
  { id: "t1", title: "Lieferschein Halle 3 prüfen", space: "Logistik", due: "Heute", who: "Mira Ost", state: "open" },
  { id: "t2", title: "Angebot Hofmann & Söhne nachfassen", space: "Vertrieb", due: "Morgen", who: "Jonas Weil", state: "open" },
  { id: "t3", title: "Inventur Lager Süd vorbereiten", space: "Logistik", due: "Fr., 27.11.", who: "Mira Ost", state: "waiting" },
  { id: "t4", title: "Rahmenvertrag Spedition verlängern", space: "Einkauf", due: "Mo., 30.11.", who: "Ella Brandt", state: "open" },
  { id: "t5", title: "Retouren November auswerten", space: "Logistik", due: "Di., 1.12.", who: "Tom Riegel", state: "done" },
  { id: "t6", title: "Neue Etiketten bestellen", space: "Einkauf", due: "Mi., 2.12.", who: "Ella Brandt", state: "open" },
  { id: "t7", title: "Schulung Stapler Team B", space: "Logistik", due: "Do., 3.12.", who: "Jonas Weil", state: "waiting" },
  { id: "t8", title: "Kundentermin Bäckerei Lind", space: "Vertrieb", due: "Fr., 4.12.", who: "Mira Ost", state: "open" },
];

const sidebar = (id: string, label: string, items: { label: string; icon: string; active?: boolean; meta?: string }[]) =>
  h(AppWorkspace.Sidebar, {
    id,
    label,
    get children() {
      return h(AppWorkspace.SidebarDesktop, {
        get children() {
          return h(AppWorkspace.SidebarBody, {
            get children() {
              return items.map((item) =>
                h(AppWorkspace.SidebarItem, {
                  href: `#${item.label}`,
                  icon: item.icon,
                  active: item.active,
                  meta: item.meta,
                  children: item.label,
                }),
              );
            },
          });
        },
      });
    },
  });

type Query = { req: { query: (key: string) => string | undefined } };
const spacesPage = (detail: boolean, c: Query) =>
  h(AppWorkspace, {
    class: "min-h-0 flex-1",
    get children() {
      return [
        // Valentin 21.11. (4): the main action also waits as a quiet entry at the top of the sidebar, never filled.
        sidebar("spaces-navigation", "Spaces", [
          { label: "Neue Aufgabe", icon: "ti ti-plus" },
          { label: "Meine Arbeit", icon: "ti ti-user-check", meta: "6" },
          { label: "Logistik", icon: "ti ti-truck", active: true, meta: "12" },
          { label: "Vertrieb", icon: "ti ti-briefcase", meta: "5" },
          { label: "Einkauf", icon: "ti ti-shopping-cart", meta: "3" },
        ]),
        h(AppWorkspace.Head, {
          views: h(ViewTabs, {
            label: "Ansichten",
            current: "list",
            items: [
              { id: "list", label: "Liste", href: "?view=list", count: 12 },
              { id: "table", label: "Tabelle", href: "?view=table" },
              { id: "board", label: "Kanban", href: "?view=board" },
              { id: "calendar", label: "Kalender", href: "?view=calendar" },
            ],
          }),
          actions: h(IconButton, { label: "Suchen", size: "sm", variant: "ghost", children: icon("ti ti-search") }),
          primary: { label: "Neue Aufgabe", icon: "ti ti-plus", href: "?new=task" },
        }),
        h(AppWorkspace.Content, {
          get children() {
            return [
              h(AppWorkspace.Main, {
                get children() {
                  return [
                    h(StatusRow, {
                      lead: "5 Aufgaben offen",
                      facts: [
                        { value: "2", label: "überfällig" },
                        { value: "3", label: "diese Woche" },
                      ],
                      filters: [
                        h(Button, { size: "sm", variant: "secondary", children: "Tag" }),
                        h(Button, { size: "sm", variant: "secondary", children: "Zuständig" }),
                      ],
                      state:
                        c.req.query("state") === "sync"
                          ? { label: "Abgleich pausiert", tone: "warning", icon: "ti ti-refresh", next: "14:05" }
                          : undefined,
                    }),
                    h(DataTable<Task>, {
                      // A table in a flat column has no frame: the column's lines are its edges (K2).
                      surface: "plain",
                      ariaLabel: "Aufgaben",
                      rows: tasks,
                      getRowId: (row) => row.id,
                      selectedRowId: detail ? "t2" : null,
                      columns: [
                        { id: "title", header: "Aufgabe", value: "title" },
                        { id: "space", header: "Space", value: "space" },
                        { id: "who", header: "Zuständig", value: "who" },
                        { id: "due", header: "Fällig", value: "due", nowrap: true },
                      ],
                    }),
                  ];
                },
              }),
              h(AppWorkspace.Detail, {
                id: "task-detail",
                open: detail,
                width: "md",
                get children() {
                  return h(DetailPanel, {
                    surface: "plain",
                    get children() {
                      return [
                        h(DetailPanel.Header, { title: "Angebot Hofmann & Söhne nachfassen", subtitle: "Vertrieb · fällig morgen" }),
                        h(DetailPanel.Body, {
                          get children() {
                            return [
                              h(DetailPanel.Row, { title: "Zuständig", description: "Jonas Weil" }),
                              h(DetailPanel.Row, { title: "Kunde", description: "Hofmann & Söhne GmbH" }),
                              h(DetailPanel.Row, { title: "Notiz", description: "Preis für 40 Paletten bestätigen." }),
                            ];
                          },
                        }),
                      ];
                    },
                  });
                },
              }),
            ];
          },
        }),
      ];
    },
  });

const filesPage = () =>
  h(AppWorkspace, {
    class: "min-h-0 flex-1",
    get children() {
      return [
        sidebar("files-navigation", "Dateien", [
          { label: "Hochladen", icon: "ti ti-upload" },
          { label: "Zuletzt", icon: "ti ti-clock" },
          { label: "Favoriten", icon: "ti ti-star" },
          { label: "Meine Dateien", icon: "ti ti-folder", active: true },
          { label: "Freigaben", icon: "ti ti-users" },
        ]),
        h(AppWorkspace.Head, {
          views: h(Breadcrumbs, {
            label: "Pfad",
            items: [
              { label: "Meine Dateien", href: "#root" },
              { label: "Projekte", href: "#projekte" },
              { label: "2026", href: "#2026" },
              { label: "Messe Frühjahr" },
            ],
          }),
          actions: h(SegmentedControl, {
            label: "Darstellung",
            value: "list",
            onValueChange: () => {},
            options: [
              { value: "list", label: "Liste", icon: "ti ti-list" },
              { value: "grid", label: "Raster", icon: "ti ti-layout-grid" },
            ],
          }),
          primary: { label: "Hochladen", icon: "ti ti-upload", href: "?upload=1" },
        }),
        h(AppWorkspace.Content, {
          get children() {
            return h(AppWorkspace.Main, {
              get children() {
                return h(DataTable<{ id: string; name: string; size: string; changed: string }>, {
                  surface: "plain",
                  ariaLabel: "Dateien",
                  rows: [
                    { id: "f1", name: "Standplan_final.pdf", size: "2,4 MB", changed: "Heute" },
                    { id: "f2", name: "Preisliste Messe.xlsx", size: "88 KB", changed: "Gestern" },
                    { id: "f3", name: "Fotos Aufbau", size: "–", changed: "18.11." },
                    { id: "f4", name: "Einladung Kunden.docx", size: "41 KB", changed: "12.11." },
                  ],
                  getRowId: (row) => row.id,
                  columns: [
                    { id: "name", header: "Name", value: "name" },
                    { id: "changed", header: "Geändert", value: "changed", nowrap: true },
                    { id: "size", header: "Größe", value: "size", align: "right", nowrap: true },
                  ],
                });
              },
            });
          },
        }),
      ];
    },
  });

const notePage = () =>
  h(AppWorkspace, {
    class: "min-h-0 flex-1",
    get children() {
      return [
        sidebar("notebook-navigation", "Notizbuch", [
          { label: "Willkommen", icon: "ti ti-file-text" },
          { label: "Messeplanung", icon: "ti ti-file-text", active: true },
          { label: "Lieferanten", icon: "ti ti-file-text" },
        ]),
        h(AppWorkspace.Content, {
          get children() {
            return h(AppWorkspace.Main, {
              width: "reading",
              get children() {
                return [
                  h(FloatingPill, {
                    label: "Ansichten und Aktionen der Notiz",
                    get children() {
                      return [
                        h(IconButton, { label: "Bearbeiten", size: "sm", variant: "ghost", children: icon("ti ti-pencil") }),
                        h(IconButton, { label: "Lesen", size: "sm", variant: "ghost", children: icon("ti ti-book") }),
                        h(FloatingPill.Separator, {}),
                        h(IconButton, { label: "Teilen", size: "sm", variant: "ghost", children: icon("ti ti-share") }),
                        h(IconButton, { label: "Weitere Aktionen", size: "sm", variant: "ghost", children: icon("ti ti-dots") }),
                      ];
                    },
                  }),
                  createComponent(Dynamic, {
                    component: "article",
                    get children() {
                      return [
                        createComponent(Dynamic, {
                          component: "h1",
                          style: "font-size:1.5rem;margin:3.5rem 0 1rem",
                          children: "Messeplanung Frühjahr",
                        }),
                        ...[
                          "Stand, Personal und Material für drei Tage am Standort Nord. Der Aufbau beginnt am Vortag um 14 Uhr; das Team aus der Logistik bringt die Wände und die Theke mit dem Sprinter.",
                          "Am Stand sind jeden Tag drei Personen: zwei aus dem Vertrieb, eine aus dem Einkauf. Die Liste der Termine mit Kunden liegt im Space Vertrieb.",
                          "Offen ist noch, ob wir den Bildschirm mieten oder den eigenen mitnehmen. Bis Freitag entscheidet Ella.",
                        ].map((text) =>
                          createComponent(Dynamic, { component: "p", style: "line-height:1.6;margin:0 0 1rem", children: text }),
                        ),
                      ];
                    },
                  }),
                ];
              },
            });
          },
        }),
      ];
    },
  });

/** A mail-like split: folders, a list pane beside the reader, and an open detail. Invented content. */
const mailPage = () =>
  h(AppWorkspace, {
    class: "min-h-0 flex-1",
    get children() {
      return [
        sidebar("mail-navigation", "Postfächer", [
          { label: "Verfassen", icon: "ti ti-pencil" },
          { label: "Eingang", icon: "ti ti-inbox", active: true, meta: "8" },
          { label: "Gesendet", icon: "ti ti-send" },
          { label: "Archiv", icon: "ti ti-archive" },
        ]),
        h(AppWorkspace.Head, {
          views: h(ViewTabs, {
            label: "Ansichten",
            current: "all",
            items: [
              { id: "all", label: "Alle", href: "?view=all", count: 8 },
              { id: "action", label: "Handlungsbedarf", href: "?view=action", count: 3 },
              { id: "mine", label: "Mir zugewiesen", href: "?view=mine", count: 2 },
            ],
          }),
          primary: { label: "Verfassen", icon: "ti ti-pencil", href: "?compose=1" },
        }),
        h(AppWorkspace.Content, {
          get children() {
            return [
              h(AppWorkspace.Main, {
                get children() {
                  return [
                    h(AppWorkspace.MainPane, {
                      id: "list",
                      label: "Nachrichten",
                      get children() {
                        return h(StatusRow, { lead: "8 Nachrichten", facts: [{ value: "3", label: "ungelesen" }] });
                      },
                    }),
                    createComponent(Dynamic, {
                      component: "article",
                      style: "padding:0 1.25rem",
                      children: "Hallo Mira, anbei der Lieferschein für Halle 3. Viele Grüße, Jonas",
                    }),
                  ];
                },
              }),
              h(AppWorkspace.Detail, {
                id: "mail-detail",
                open: true,
                width: "sm",
                get children() {
                  return h(DetailPanel, {
                    surface: "plain",
                    get children() {
                      return h(DetailPanel.Header, { title: "Jonas Weil", subtitle: "Logistik" });
                    },
                  });
                },
              }),
            ];
          },
        }),
      ];
    },
  });

const pages: Record<string, (c: { req: { query: (key: string) => string | undefined } }) => JSX.Element> = {
  spaces: (c) => spacesPage(c.req.query("detail") !== "0", c),
  files: () => filesPage(),
  notebooks: () => notePage(),
  mail: () => mailPage(),
};
const server = new Hono().get(
  "/app/:app",
  async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("user" as never, person as never);
    await next();
  },
  ...probe.ssr((c) => {
    const id = c.req.param("app") ?? "spaces";
    const app = apps.find((entry) => entry.id === id)!;
    return () =>
      createComponent(Layout, {
        c: c as unknown as LayoutContextArg,
        fullWidth: true,
        fullPage: true,
        title: [{ title: "Start", href: "/" }, { title: app.name }],
        get children() {
          return pages[id]!(c);
        },
      });
  }),
);

let browser: Browser;
let css: string;
let controller: string;

export type FlatShellOptions = { theme?: "light" | "dark"; style?: string; touch?: boolean; fonts?: boolean };

/** Plex and the icon font as data URLs, for screenshots only: the measuring tests do not need them. */
let fontCss: string | undefined;
const fonts = async () => {
  if (fontCss !== undefined) return fontCss;
  const from = resolve(import.meta.dir, "../../../ui/src");
  const data = async (path: string) => `data:font/woff2;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
  const plex = await Promise.all(
    [400, 500, 600, 700].map(
      async (weight) =>
        `@font-face{font-family:"IBM Plex Sans";font-weight:${weight};src:url(${await data(Bun.resolveSync(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`, from))}) format("woff2")}`,
    ),
  );
  const iconsCss = Bun.resolveSync("@tabler/icons-webfont/dist/tabler-icons.min.css", from);
  const icons = (await Bun.file(iconsCss).text()).replace(/@font-face\{[^}]*\}/, "");
  const iconFont = await data(resolve(iconsCss, "../fonts/tabler-icons.woff2"));
  fontCss = `${plex.join("")}@font-face{font-family:"tabler-icons";src:url(${iconFont}) format("woff2")}${icons}`;
  return fontCss;
};

/** Server HTML with the global stylesheet; scripts and links are dropped, as the shell harnesses do. */
const html = async (path: string, options: FlatShellOptions) => {
  const markup = await (
    await server.request(path, { headers: { "Accept-Language": "de", Cookie: `theme=${options.theme ?? "light"}` } })
  ).text();
  const clean = new HTMLRewriter()
    .on('script[src], script[type="module"]', { element: (element) => void element.remove() })
    .on('link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]', { element: (element) => void element.remove() })
    .transform(markup);
  return clean.replace(
    "</head>",
    `<style>${options.fonts ? await fonts() : ""}</style><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}${options.style ?? ""}</style></head>`,
  );
};

/** Opens an invented page at a width with the shared controller attached. */
export const openFlatShell = async (width: number, path: string, options: FlatShellOptions = {}): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : width < 1024 ? 1024 : width < 1920 ? 900 : 1080 },
    hasTouch: options.touch ?? width < 1024,
    isMobile: options.touch ?? width < 768,
    colorScheme: options.theme ?? "light",
  });
  const page = await context.newPage();
  await page.setContent(await html(path, options));
  await page.addScriptTag({ content: controller });
  await page.evaluate(async () => {
    (window as unknown as { installController: () => void }).installController();
    await document.fonts.ready;
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
  });
  return page;
};

export function installFlatShellHarness(launch: typeof launchBrowser) {
  setDefaultTimeout(30_000);
  const spies: { mockRestore(): void }[] = [];
  beforeAll(async () => {
    spies.push(
      spyOn(railSnapshot, "readRailSnapshot").mockImplementation(async () => ({ ...defaultRailPreferences(), showNames: true })),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    );
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
    if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
    css = await build.outputs[0]!.text();
    const entry = resolve(import.meta.dir, "flat-shell.controller.ts");
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
