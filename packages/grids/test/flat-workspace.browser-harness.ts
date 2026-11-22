import { afterAll, beforeAll, setDefaultTimeout, setSystemTime, spyOn } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import type { launchBrowser } from "../../ui/test/browser";
import type { PublicField, PublicGridRecord, PublicTable, PublicView } from "../src/api/public-dto";
import type { PublicOkWorkspaceState } from "../src/frontend/_components/workspace/workspace-public-state-model";

// The Grids records page as a person sees it: the server-rendered Cloud layout with the global and the Grids
// stylesheets around the real `GridsWorkspace`, for one invented rental base. Scripts are dropped, so this is the first
// paint the server sends. Every name, number, and date is invented. The package's test preload registers the SSR
// plugin that turns islands into their server markup.

const { Hono } = await import("hono");
const { defineApp } = await import("../../cloud/src/_internal/define-app");
const { person } = await import("../../cloud/src/_internal/define-app.test-fixture");
const railSnapshot = await import("../../cloud/src/services/rail-snapshot");
const settingsMiddleware = await import("../../cloud/src/server/middleware/settings");
const help = await import("../../cloud/src/ssr/help");
const { defaultRailPreferences } = await import("../../cloud/src/contracts/rail-preferences");
const { default: Layout } = await import("../../cloud/src/ssr/Layout");
const { default: GridsWorkspace } = await import("../src/frontend/_components/workspace/GridsWorkspace");
const { RecordFormFields } = await import("../src/frontend/_components/records/RecordUpsertDialog");
const { Button, LocaleProvider, PanelDialog } = await import("@k2b/ui");
const { Dynamic } = await import("solid-js/web");

const probe = defineApp({
  id: "grids-flat-probe",
  name: "Grids flat probe",
  icon: "ti ti-table",
  description: "Grids flat probe",
  baseUrl: "http://grids-flat-probe:3000",
  routes: ["/app/grids"],
});
const apps = [
  {
    id: "grids",
    name: "Grids",
    icon: "ti ti-table",
    description: "Grids",
    routes: ["/app/grids"],
    nav: { href: "/app/grids", section: "primary" },
    appearance: { accent: "#008f4c", background: { from: "#00a651", to: "#22c55e" } },
  },
];

const at = "2026-11-18T09:00:00.000Z";
const table = (id: string, name: string, position: number): PublicTable => ({
  id,
  baseId: "VERLEI",
  name,
  description: null,
  icon: null,
  kind: "stored",
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position,
  disableDirectInsert: false,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
});
const tables = [
  table("GERAET", "Geräte", 0),
  table("AUSLEI", "Ausleihen", 1),
  table("KUNDEN", "Kundschaft", 2),
  table("PRUEFG", "Prüfungen", 3),
];
const geraete = tables[0]!;

const field = (id: string, name: string, type: string, position: number, config: Record<string, unknown> = {}): PublicField => ({
  id,
  tableId: geraete.id,
  name,
  description: null,
  type,
  config,
  position,
  required: position === 0,
  presentable: position === 0,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: at,
  updatedAt: at,
});
const option = (id: string, label: string, color: string) => ({ id, label, color });
const fields: PublicField[] = [
  field("BEZEIC", "Bezeichnung", "text", 0),
  field("KATEGO", "Kategorie", "select", 1, {
    options: [
      option("ton", "Ton", "cyan"),
      option("licht", "Licht", "amber"),
      option("buehne", "Bühne", "violet"),
      option("video", "Video", "rose"),
      option("zubehoer", "Zubehör", "zinc"),
    ],
  }),
  field("STANDO", "Standort", "select", 2, {
    options: [option("a", "Lager A", "zinc"), option("b", "Lager B", "zinc"), option("saal", "Saal", "zinc")],
  }),
  field("ZUSTAN", "Zustand", "select", 3, {
    options: [
      option("bereit", "Einsatzbereit", "green"),
      option("verleih", "Im Verleih", "blue"),
      option("reparatur", "Reparatur", "amber"),
      option("aus", "Ausgemustert", "zinc"),
    ],
  }),
  field("STUECK", "Stück", "number", 4, { integerOnly: true }),
  field("TAGESP", "Tagespreis", "number", 5, { decimalPlaces: 2, unit: "€", unitPosition: "suffix" }),
  field("PRUEFU", "Nächste Prüfung", "date", 6),
  field("VERANT", "Verantwortlich", "text", 7),
  field("HINWEI", "Hinweis zum Zustand", "longtext", 8),
];

const rows: Array<[string, string, string, string, number, string | null, string | null, string]> = [
  ["Lautsprecher aktiv 12″", "ton", "a", "bereit", 8, "22.00", "2027-01-14", "Jonte Kramer"],
  ["Subwoofer 18″", "ton", "a", "verleih", 2, "35.00", "2027-01-14", "Jonte Kramer"],
  ["Funkmikrofon Handsender", "ton", "a", "bereit", 6, "15.00", "2027-03-02", "Jonte Kramer"],
  ["Mischpult 16 Kanäle", "ton", "saal", "bereit", 1, "40.00", "2027-03-02", "Jonte Kramer"],
  ["LED-Scheinwerfer RGBW", "licht", "b", "bereit", 24, "6.00", "2026-11-24", "Ines Morgenroth"],
  ["Moving Head Spot", "licht", "b", "reparatur", 4, "28.00", null, "Ines Morgenroth"],
  ["Lichtpult 24 Kanäle", "licht", "saal", "bereit", 1, "30.00", "2027-05-19", "Ines Morgenroth"],
  ["Bühnenpodest 2 × 1 m", "buehne", "b", "verleih", 20, "9.00", "2027-09-08", "Felix Tannert"],
  ["Traverse 3 m", "buehne", "b", "bereit", 12, "7.50", "2027-09-08", "Felix Tannert"],
  ["Beamer 6000 Lumen", "video", "a", "bereit", 2, "60.00", "2027-02-11", "Mira Solberg"],
  ["Leinwand 3 × 2 m", "video", "a", "bereit", 2, "18.00", null, "Mira Solberg"],
  ["Kabeltrommel 25 m", "zubehoer", "a", "bereit", 10, "3.00", "2026-11-24", "Felix Tannert"],
  ["Stativ für Lautsprecher", "zubehoer", "a", "verleih", 8, "4.00", null, "Jonte Kramer"],
  ["Nebelmaschine", "licht", "b", "aus", 1, null, null, "Ines Morgenroth"],
  ["Pavillon 3 × 3 m", "buehne", "b", "bereit", 6, "25.00", null, "Felix Tannert"],
];
const record = (index: number): PublicGridRecord => {
  const [name, category, place, state, count, price, check, owner] = rows[index % rows.length]!;
  return {
    id: `G${String(index + 1).padStart(5, "0")}`,
    tableId: geraete.id,
    data: {
      BEZEIC: index < rows.length ? name : `${name} (${Math.floor(index / rows.length) + 1})`,
      KATEGO: [category],
      STANDO: [place],
      ZUSTAN: [state],
      STUECK: count,
      TAGESP: price,
      PRUEFU: check,
      VERANT: owner,
      HINWEI:
        state === "reparatur"
          ? "Zwei der vier Geräte verlieren nach etwa einer Stunde ihre Position. Sie sind seit dem 16.11. beim Hersteller."
          : null,
    },
    version: 4,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
  };
};

const view = (id: string, name: string, position: number): PublicView =>
  ({
    id,
    tableId: geraete.id,
    name,
    description: null,
    icon: null,
    source: `from Geräte`,
    ui: {},
    ownerUserId: null,
    position,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
  }) as PublicView;
const views = [view("VERLEI", "Im Verleih", 0), view("PRUEFF", "Prüfung fällig", 1)];

export type FlatWorkspaceCase = {
  /** How many records the page shows: few leave the scroll area without a scrollbar, many give it one. */
  rows?: number;
  /** The record whose detail is open beside the table. */
  selected?: number;
  empty?: boolean;
  failed?: boolean;
  /** The edit form of the selected record, as its dialog shows it, with a rejected amount. */
  form?: boolean;
  /** Sorted by name, so the sort panel stands open under the status row. */
  sorted?: boolean;
};

const workspaceState = (options: FlatWorkspaceCase): PublicOkWorkspaceState => {
  const items = options.empty ? [] : Array.from({ length: options.rows ?? 15 }, (_, index) => record(index));
  const selected = options.selected === undefined ? null : record(options.selected);
  return {
    kind: "ok",
    base: {
      id: "VERLEI",
      name: "Verleih",
      description: null,
      documentDefaults: {},
      createdBy: null,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    },
    navigation: {
      revision: 1,
      groups: [{ id: "TABELN", name: "Tabellen", entries: tables.map((entry) => ({ type: "table" as const, id: entry.id })) }],
    },
    title: [{ title: "Verleih" }],
    rememberPath: "/app/grids/VERLEI",
    adminModeRequested: false,
    editModeToggleHref: "/app/grids/VERLEI?edit=true",
    canManageBase: false,
    canCreateTables: false,
    canUseEditMode: false,
    canUseQueryWorkspace: true,
    liveCursor: null,
    catalog: {
      customApps: [],
      workflows: [],
      workflowLaunchers: [],
      workflowLevels: {},
      tables,
      tableLevels: Object.fromEntries(tables.map((entry) => [entry.id, "write"])),
      fieldsByTable: { [geraete.id]: fields },
      viewsByTable: { [geraete.id]: views },
      formsByTable: {},
      documentTemplatesByTable: {},
      documentTemplateLevels: {},
      sidebarForms: [],
      sidebarDocumentTemplates: [],
    },
    route: {
      kind: "records",
      activeTable: geraete,
      activeView: null,
      fields,
      formsForTable: [],
      canReadTable: true,
      canWriteRecords: true,
      canManageActiveTable: false,
      canEditActiveView: false,
      otherTables: tables.map((entry) => ({ id: entry.id, name: entry.name })),
      initialState: {
        query: options.sorted ? { sort: [{ fieldId: "BEZEIC", direction: "asc" }] } : {},
        cursor: null,
        selectedRecordId: selected?.id ?? null,
        search: { q: "", fieldIds: [], override: false },
        calendar: { view: "month", date: "2026-11-01" },
        cardSize: "medium",
      },
      initialData: { items, nextCursor: options.empty ? null : "next" },
      initialError: options.failed ? "Die Abfrage braucht zu lange. Der nächste Versuch startet von selbst." : null,
      initialSelectedRecord: selected,
      initialSelectedRecordDetail: selected
        ? {
            recordId: selected.id,
            relationLabels: {},
            filesByField: {},
            documents: { items: [], cursor: null, hasMore: false },
            snapshots: [],
            auditEntries: [],
            combinedOrigin: null,
            referencedBy: { items: [], nextCursor: null },
          }
        : null,
      documentTemplates: [],
      relationLabels: {},
      activeViewColumns: undefined,
      groupedExplode: false,
      activeRecordQuery: null,
      displayConfig: { mode: "table" },
      bulkSelectionLaunchers: [],
      recordActionLaunchers: [],
    },
  } as PublicOkWorkspaceState;
};

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
const caseOf = (query: (key: string) => string | undefined): FlatWorkspaceCase => ({
  rows: query("rows") ? Number(query("rows")) : undefined,
  selected: query("selected") ? Number(query("selected")) : undefined,
  empty: query("empty") === "1",
  failed: query("failed") === "1",
  form: query("form") === "1",
  sorted: query("sorted") === "1",
});

/** The record form as the edit dialog shows it; the dialog itself opens only in the browser. */
const formPreview = (index: number) => {
  const shown = record(index);
  const editable = fields.filter((entry) => entry.type !== "formula");
  return createComponent(Dynamic, {
    component: "div",
    class: "k2b-ui",
    style: "position:fixed;inset:0 0 0 auto;z-index:50;display:flex;width:min(100%,30rem);background:var(--k2b-surface)",
    get children() {
      return createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(PanelDialog, {
            get children() {
              return [
                createComponent(PanelDialog.Header, { title: `${shown.data.BEZEIC} bearbeiten`, icon: "ti ti-pencil", close: () => {} }),
                createComponent(PanelDialog.Body, {
                  get children() {
                    return createComponent(RecordFormFields, {
                      fields: editable,
                      values: { ...shown.data, TAGESP: "28,", KATEGO: shown.data.KATEGO, STANDO: shown.data.STANDO },
                      errors: { TAGESP: "Bitte einen Betrag mit zwei Nachkommastellen eingeben." },
                      onChange: () => {},
                      baseId: "VERLEI",
                      recordId: shown.id,
                    });
                  },
                }),
                createComponent(PanelDialog.Footer, {
                  get children() {
                    return [
                      createComponent(Dynamic, { component: "span" }),
                      createComponent(Dynamic, {
                        component: "div",
                        class: "flex items-center gap-2",
                        get children() {
                          return [
                            createComponent(Button, { variant: "ghost", size: "sm", children: "Abbrechen" }),
                            createComponent(Button, { variant: "primary", size: "sm", children: "Speichern" }),
                          ];
                        },
                      }),
                    ];
                  },
                }),
              ];
            },
          });
        },
      });
    },
  });
};
const server = new Hono().get(
  "/app/grids",
  async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("user" as never, person as never);
    await next();
  },
  ...probe.ssr(
    (c) => () =>
      createComponent(Layout, {
        c: c as unknown as LayoutContextArg,
        fullWidth: true,
        fullPage: true,
        title: [{ title: "Verleih" }, { title: "Geräte" }],
        get children() {
          const shown = caseOf((key) => c.req.query(key));
          const page = createComponent(GridsWorkspace, { state: workspaceState(shown) });
          return shown.form ? [page, formPreview(shown.selected ?? 5)] : page;
        },
      }),
  ),
);

let browser: Browser;
let css: string;
let controller: string;

/** Plex and the icon font as data URLs, for screenshots only: the measuring tests do not need them. */
let fontCss: string | undefined;
const fonts = async () => {
  if (fontCss !== undefined) return fontCss;
  const from = resolve(import.meta.dir, "../../ui/src");
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

export type FlatWorkspaceOptions = { theme?: "light" | "dark"; touch?: boolean; fonts?: boolean };

const html = async (path: string, options: FlatWorkspaceOptions) => {
  const markup = await (
    await server.request(path, { headers: { "Accept-Language": "de", Cookie: `theme=${options.theme ?? "light"}` } })
  ).text();
  const clean = new HTMLRewriter()
    .on('script[src], script[type="module"]', { element: (element) => void element.remove() })
    .on('link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]', { element: (element) => void element.remove() })
    .transform(markup);
  return clean.replace(
    "</head>",
    `<style>${options.fonts ? await fonts() : ""}</style><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
  );
};

/** Opens the records page at a width; `path` carries the case as a query (`?rows=40&selected=5`). */
export const openFlatWorkspace = async (width: number, path: string, options: FlatWorkspaceOptions = {}): Promise<Page> => {
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

export function installFlatWorkspaceHarness(launch: typeof launchBrowser) {
  setDefaultTimeout(30_000);
  const spies: { mockRestore(): void }[] = [];
  beforeAll(async () => {
    // The page names times relative to now; the invented records are dated around this day.
    setSystemTime(new Date("2026-11-21T09:00:00.000Z"));
    spies.push(
      spyOn(railSnapshot, "readRailSnapshot").mockImplementation(async () => ({ ...defaultRailPreferences(), showNames: false })),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    );
    const builds = await Promise.all(
      [resolve(import.meta.dir, "../../../styles.css"), resolve(import.meta.dir, "../src/styles/app.css")].map((entry) =>
        Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
      ),
    );
    for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
    css = (await Promise.all(builds.map((build) => build.outputs[0]!.text()))).join("\n");
    const entry = resolve(import.meta.dir, "flat-workspace.controller.ts");
    const bundle = await Bun.build({
      entrypoints: [entry],
      files: {
        [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(resolve(import.meta.dir, "../../ui/dist/browser/index.js"))};
window.installController = () => installAppWorkspaceController();`,
      },
      target: "browser",
      format: "iife",
    });
    if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the workspace controller.");
    controller = await bundle.outputs[0]!.text();
    // Classic scrollbars, as on Linux and Windows: a scrollbar that takes room must move nothing (system rule 21.11.).
    browser = await launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  }, 90_000);
  afterAll(async () => {
    setSystemTime();
    for (const spy of spies.splice(0)) spy.mockRestore();
    await browser?.close();
  });
}
