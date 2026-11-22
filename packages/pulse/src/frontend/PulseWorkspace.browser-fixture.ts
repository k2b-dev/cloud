import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { User } from "@k2b/cloud/contracts";
import type { ComponentProps } from "solid-js";
import type { launchBrowser } from "../../../ui/test/browser";
import type { PulseSource } from "../contracts";
import type { AlertAttention } from "../service/base-attention";
import type PulseOverview from "./PulseOverview.island";
import type { PulseWorkspaceProps } from "./workspace/types";

// Fixture data and the client bundle of the Pulse base page, shared by the browser test and screenshots.
const ui = new URL("../../../ui/", import.meta.url).pathname;
export const origin = "https://cloud.example.test";
const now = "2026-10-19T12:40:00.000Z";
// Invented account owned by this fixture; no Cloud-internal test module is needed.
const person = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
} satisfies User;
const status = (overrides: Partial<PulseSource["status"]> = {}): PulseSource["status"] => ({
  newestDataAt: "2026-10-19T12:32:00.000Z",
  throttled: false,
  throttledAt: null,
  refusedHistograms: [],
  skippedSummaries: 0,
  lastError: null,
  lastErrorAt: null,
  ...overrides,
});
const source = (id: string, name: string, overrides: Partial<PulseSource> = {}): PulseSource => ({
  id,
  baseId: "Lad001",
  kind: "metrics",
  name,
  enabled: true,
  endpointUrl: "http://shop-01:9100/metrics",
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: 60,
  metricFilters: [],
  revision: 1,
  expectEverySeconds: null,
  expectDailyBy: null,
  staleSince: null,
  status: status(),
  lastSeenAt: "2026-10-19T12:32:00.000Z",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  ...overrides,
});
export const workspaceFixture: PulseWorkspaceProps = {
  initialBaseId: "Lad001",
  initialPermissions: { write: true, admin: true },
  initialSettings: { maxRawRetentionDays: 3650, admins: ["Jana"] },
  initialBases: [
    {
      id: "Lad001",
      shortId: "Lad001",
      icon: "ti ti-chart-line",
      color: "blue",
      timezone: "UTC",
      name: "Laden",
      description: null,
      rawRetentionDays: 30,
      rollupRetentionDays: 365,
      sensitiveRetentionHours: 24,
      createdBy: null,
      deletionStartedAt: null,
      deletionFailedAt: null,
      deletionError: null,
      dataClearStartedAt: null,
      dataClearCompletedAt: null,
      dataClearFailedAt: null,
      dataClearError: null,
      memberCount: 3,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
      store: {
        state: "active",
        operation: null,
        errorCode: null,
        errorAt: null,
        writeBlockReason: null,
        profile: "normal",
        limits: {
          queriesPerHour: 600,
          valuesPerMinute: 2000,
          bytesPerMinute: 5_242_880,
          storageBytes: 5_000_000_000,
          maxSeries: 50_000,
          maxEventKinds: 2000,
          maxStateKeys: 2000,
        },
        usage: { bytes: 1_800_000_000, rows: 1_200_000, measuredAt: "2026-10-19T12:35:00.000Z" },
      },
    },
  ],
  initialRouteState: { view: "sources", sourceId: "" },
  initialSources: [
    source("Src001", "Shop-Server", { metricFilters: ["node_cpu_seconds_total", "node_filesystem_*"] }),
    source("Src002", "Shop-Bestellungen", {
      kind: "http_ingest",
      endpointUrl: null,
      scrapeIntervalSeconds: null,
      status: status({ newestDataAt: "2026-10-19T12:29:00.000Z" }),
    }),
    source("Src003", "Traefik", {
      endpointUrl: "http://traefik:8082/metrics",
      status: status({
        refusedHistograms: [{ family: "traefik_service_request_duration_seconds", reason: "missing_inf" }],
        skippedSummaries: 1,
      }),
    }),
    source("Src004", "Newsletter-Skript", {
      kind: "http_ingest",
      endpointUrl: null,
      scrapeIntervalSeconds: null,
      status: status({ newestDataAt: "2026-10-19T12:39:00.000Z", throttled: true, throttledAt: "2026-10-19T12:39:30.000Z" }),
    }),
  ],
  initialSourceScrapes: {},
  initialSourceApiKeys: {},
  initialQueryCoverage: { bases: true, baseData: true, sourceDetail: true },
  initialDateConfig: { locale: "de", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
  initialNow: now,
  initialOrigin: origin,
};

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type BrowserPage = Awaited<ReturnType<Browser["newPage"]>>;

/** Freeze before pausing so a delayed browser command cannot move the pause target into the past. */
export const pauseWorkspaceClock = async (clock: BrowserPage["clock"], time: Date) => {
  await clock.setFixedTime(time);
  await clock.pauseAt(time);
  // Keep runFor() advancing Date and timers together after the initial pause.
  await clock.setSystemTime(time);
};

// Compile the real page once during fixture setup. Per-render child processes then
// execute the bundle instead of repeatedly loading Babel and compiling the whole
// workspace graph inside their 15-second request deadline.
let snapshotBundle: Promise<string> | undefined;
const prepareWorkspaceSnapshot = () =>
  (snapshotBundle ??= (async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "pulse-snapshot-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const { createConfig } = await import("@k2b/ssr");
    const snapshot = createConfig({ dev: true, rootDir: directory });
    const entry = resolve(import.meta.dir, "PulseWorkspace.snapshot-server.ts");
    const adapter = resolve(import.meta.dir, "PulseWorkspace.snapshot-adapter.ts");
    const data = resolve(import.meta.dir, "PulseWorkspace.snapshot-data.ts");
    const page = resolve(import.meta.dir, "[baseId]/page.tsx");
    const built = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      conditions: ["node"],
      files: {
        [adapter]: `
        import { createConfig } from "@k2b/ssr";
        import { createSSRHandler } from "@k2b/ssr/hono";
        import { ssr as actual } from "../config";
        const snapshot = createConfig({ dev: true, rootDir: ${JSON.stringify(directory)},
          template: ({ body }) => "<!doctype html><html><head></head><body>" + body + "</body></html>" });
        export const ssr = Object.assign(createSSRHandler(snapshot.html), actual);
      `,
        [data]: `export const loadPulseWorkspacePageData = async (c) => ({ kind: "ok", baseName: "Laden", workspaceProps: c.get("pulseFixtureProps") });`,
        [entry]: `
        import { setSystemTime } from "bun:test";
        import { Hono } from "hono";
        import { LocaleProvider } from "@k2b/ui";
        import { createComponent } from "solid-js";
        import { renderToString } from "solid-js/web";
        import { app } from "../config";
        import Workspace from "./PulseWorkspace.island";
        import basePage from "./[baseId]/page";
        const { props, locale, withLayout, person } = JSON.parse(await Bun.stdin.text());
        setSystemTime(new Date(props.initialNow));
        if (withLayout) {
          const server = new Hono().use(async (c, next) => {
            c.set("runtime", { apps: [app.meta] });
            c.set("user", person);
            c.set("pulseFixtureProps", props);
            await next();
          }).get("/app/pulse/:baseId", ...basePage);
          const response = await server.request("/app/pulse/" + props.initialBaseId, { headers: { "Accept-Language": locale } });
          if (response.status !== 200) throw new Error("Pulse page snapshot status " + response.status);
          process.stdout.write(await response.text());
        } else {
          process.stdout.write(renderToString(() => createComponent(LocaleProvider, {
            locale, get children() { return createComponent(Workspace, props); }
          })));
        }
      `,
      },
      plugins: [
        {
          name: "pulse-snapshot-seams",
          setup(build) {
            // Same fixture seams as the runtime spies: real page, Layout, island and
            // declaration; substitute only page data and platform SSR preloads.
            build.onResolve({ filter: /^(?:\.\.\/\.\.\/config|\.\/page-data)$/ }, (args) =>
              args.importer === page ? { path: args.path === "./page-data" ? data : adapter } : undefined,
            );
          },
        },
        snapshot.plugin(),
      ],
    });
    if (!built.success) throw new AggregateError(built.logs, "Pulse server snapshot build failed");
    const path = resolve(directory, "server.mjs");
    await Bun.write(path, built.outputs[0]!);
    return path;
  })());

/** Run the compiled real server page in isolation from the browser's module conditions. */
export const renderWorkspaceSnapshot = async (props: PulseWorkspaceProps, locale: string, withLayout = false) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", await prepareWorkspaceSnapshot()], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15_000,
    stdin: new Response(JSON.stringify({ props, locale, withLayout, person })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [markup, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Pulse server snapshot failed: ${errors}`);
  return markup;
};

/** Adapt trusted, generated SSR markup for the isolated client harness; not a general HTML sanitizer. */
export const workspaceDocumentContent = (document: string) =>
  new HTMLRewriter()
    .on("script, head", { element: (element) => void element.remove() })
    .on("html, body", { element: (element) => void element.removeAndKeepContent() })
    .on('img[src="/branding/logo"]', {
      element: (element) =>
        void element.setAttribute(
          "src",
          "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Fictional Cloud fixture</title><path fill="#5267c4" d="M7 19a5 5 0 0 1-1-9.9A7 7 0 0 1 19.8 10 4.5 4.5 0 0 1 19.5 19Z"/></svg>',
            ),
        ),
    })
    .on('solid-island[data-file="PulseWorkspace.island.tsx"]', { element: (element) => void element.setAttribute("id", "root") })
    .onDocument({ doctype: (doctype) => void doctype.remove() })
    .transform(document);

let workspaceHarness: ReturnType<typeof compileWorkspaceHarness> | undefined;
// Every caller supplies its own snapshot; only the immutable client and styles are shared.
export const buildWorkspaceHarness = () => (workspaceHarness ??= compileWorkspaceHarness());

const compileWorkspaceHarness = async () => {
  await prepareWorkspaceSnapshot();
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./PulseWorkspace.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pulse-workspace-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Pulse workspace harness failed");
  const bundle = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const result of built) if (!result.success) throw new AggregateError(result.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((result) => result.outputs[0]!.text()));
  // Icons and the Plex face load like in the Cloud shell; fonts are inlined so the page needs no server.
  const inlineFonts = async (sheet: string) => {
    const path = fileURLToPath(import.meta.resolve(sheet));
    // Plex ships one face per script; German and English need the Latin ones only.
    let text = (await Bun.file(path).text()).replace(/@font-face\{[^}]*\}/g, (face) =>
      face.includes("plex") && !face.includes("-latin-") ? "" : face,
    );
    for (const match of new Set(text.match(/\.\/[^)"'?]+\.woff2(?:\?[^)"']*)?/g) ?? [])) {
      const font = match.replace(/\?.*$/, "");
      text = text.replaceAll(
        match,
        `data:font/woff2;base64,${Buffer.from(await Bun.file(resolve(dirname(path), font)).arrayBuffer()).toString("base64")}`,
      );
    }
    return text;
  };
  const fonts = await Promise.all(["@k2b/ui/icons/tabler.css", "@k2b/ui/fonts/plex.css"].map(inlineFonts));
  const css = ["@layer properties, theme, base, components, utilities;", ...fonts, appCss, globalCss].join("\n");
  return (
    props: PulseWorkspaceProps,
    locale = "de",
    dark = false,
    overview?: ComponentProps<typeof PulseOverview>,
    mount?: { serverHtml: string; deferMount: boolean; pageDocument?: boolean },
  ) => {
    const content = mount?.pageDocument
      ? workspaceDocumentContent(mount.serverHtml)
      : `<div class="cloud-app-canvas relative flex h-dvh w-full overflow-hidden" data-app-id="pulse" data-layout-full-page="true">` +
        `<main class="layout-content-main flex min-h-0 min-w-0 flex-1 flex-col"><solid-island id="root">${mount?.serverHtml ?? ""}</solid-island></main></div>`;
    return (
      `<!doctype html><html lang="${locale}" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui">${content}` +
      `<script>window.__pulse=${JSON.stringify({ locale, props, overview, deferMount: mount?.deferMount })}</script><script>${bundle}</script></body></html>`
    );
  };
};

// Flat base page: one fixture per state of the concept (gesund, Fehler, leer, kein Zugriff, Daten, Nutzung,
// Speicher weg, nur Lesen, SQL). Invented bases, sources and people.
const flatBase = (id: string, name: string, icon: string, color: string) => ({
  ...workspaceFixture.initialBases[0]!,
  id,
  shortId: id,
  name,
  icon,
  color,
  timezone: "Europe/Berlin",
  createdAt: "2026-10-19T07:12:00.000Z",
});
export const flatBases = [
  flatBase("Btr001", "Betrieb", "ti ti-server", "teal"),
  flatBase("Web001", "Website", "ti ti-world", "violet"),
  flatBase("Ger001", "Geräte", "ti ti-devices", "orange"),
  flatBase("Lag001", "Lager", "ti ti-package", "blue"),
];
const fresh = (at: string) => status({ newestDataAt: at });
export const healthySources: PulseSource[] = [
  source("Src101", "web-01", { baseId: "Btr001", status: fresh("2026-10-19T12:39:39.000Z"), lastSeenAt: "2026-10-19T12:39:39.000Z" }),
  source("Src102", "db-01", { baseId: "Btr001", status: fresh("2026-10-19T12:39:26.000Z"), lastSeenAt: "2026-10-19T12:39:26.000Z" }),
  source("Src103", "Traefik", { baseId: "Btr001", status: fresh("2026-10-19T12:39:51.000Z"), lastSeenAt: "2026-10-19T12:39:51.000Z" }),
  source("Src104", "Backup-Prüfung", {
    baseId: "Btr001",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    expectDailyBy: "06:00",
    todayCount: 14,
    status: fresh("2026-10-19T03:12:00.000Z"),
    lastSeenAt: "2026-10-19T03:12:00.000Z",
  }),
];
export const troubledSources: PulseSource[] = [
  source("Src201", "Website-Server", {
    baseId: "Web001",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    todayCount: 9204,
    status: {
      ...fresh("2026-10-19T12:01:00.000Z"),
      rejected: { last24h: 312, lastReason: "„value“ ist Text statt Zahl", lastAt: "2026-10-19T12:39:42.000Z" },
    },
    lastSeenAt: "2026-10-19T12:39:42.000Z",
  }),
  source("Src202", "Shop-Backend", {
    baseId: "Web001",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    expectEverySeconds: 900,
    staleSince: "2026-10-19T10:20:00.000Z",
    todayCount: 312,
    status: fresh("2026-10-19T10:05:00.000Z"),
    lastSeenAt: "2026-10-19T10:05:00.000Z",
  }),
  source("Src203", "Kurzlinks", {
    baseId: "Web001",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    todayCount: 2180,
    status: fresh("2026-10-19T12:39:20.000Z"),
  }),
  source("Src204", "Webserver-Metriken", { baseId: "Web001", status: fresh("2026-10-19T12:39:38.000Z") }),
];
const firedAlert: AlertAttention = {
  reference: "Alt201",
  name: "Kontaktanfragen zu niedrig",
  state: "firing",
  severity: "critical",
  since: "2026-10-19T12:30:00.000Z",
  lastCheckedAt: "2026-10-19T12:38:00.000Z",
  errorCode: null,
  key: "contact_form_sent",
  value: 0,
  comparison: "below",
  threshold: 2,
};
/** A base on Sources with the attention the server read: fired alerts and the data store state. */
const flat = (
  baseId: string,
  sources: PulseSource[],
  alerts: AlertAttention[] = [],
  storeDownSince: string | null = null,
): PulseWorkspaceProps => ({
  ...workspaceFixture,
  initialBaseId: baseId,
  initialBases: flatBases,
  initialSources: sources,
  initialRouteState: { view: "sources", sourceId: "" },
  initialCreator: "Lena Berg",
  initialAttention: { readAt: now, store: { unavailable: storeDownSince !== null, since: storeDownSince }, alerts },
});
/** The one key of "Website-Server", in its detail and in Usage. */
export const flatKeys: ResourceApiKey[] = [
  {
    id: "00000000-0000-4000-8000-000000000301",
    serviceAccountId: "00000000-0000-4000-8000-000000000201",
    name: "pk_…3f9a",
    kind: "api_token" as const,
    status: "active" as const,
    tokenPrefix: "pk_3f9a",
    scopes: ["write"],
    expiresAt: null,
    lastUsedAt: "2026-10-19T12:39:42.000Z",
    createdBy: null,
    createdAt: "2026-10-02T08:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    permission: "write" as const,
  },
];

export const flatStates = {
  healthy: flat("Btr001", healthySources),
  error: {
    ...flat("Web001", troubledSources, [firedAlert]),
    initialRouteState: { view: "sources", sourceId: "Src201" },
    // The same key the Usage tab lists for this source.
    initialSourceApiKeys: { Src201: flatKeys },
  } satisfies PulseWorkspaceProps,
  alert: {
    ...flat("Web001", troubledSources, [firedAlert]),
    initialRouteState: { view: "sources", sourceId: "", alertId: "Alt201" },
  } satisfies PulseWorkspaceProps,
  /** An old dashboard link led to the base: the notice cell stands at the top of Sources. */
  dashboardsRemoved: { ...flat("Btr001", healthySources), initialNotice: "dashboards-removed" } satisfies PulseWorkspaceProps,
  empty: flat("Lag001", []),
  noAccess: {
    ...flat("Web001", []),
    initialBases: flatBases.filter((base) => base.id !== "Web001"),
    initialAccess: { denied: true, managers: ["Anna Roth", "Jonas Keller"] },
    initialPermissions: { write: false, admin: false },
    initialAttention: undefined,
  } satisfies PulseWorkspaceProps,
  // The instance store is unreachable since 12:05; the base store itself is still active.
  storeDown: flat("Btr001", healthySources, [], "2026-10-19T12:05:00.000Z"),
  readOnly: { ...flat("Btr001", healthySources), initialPermissions: { write: false, admin: false } } satisfies PulseWorkspaceProps,
  data: {
    ...flat("Web001", troubledSources),
    initialRouteState: { view: "data", sourceId: "" },
    // The server reads the attention for Sources only.
    initialAttention: undefined,
  } satisfies PulseWorkspaceProps,
  usage: {
    ...flat("Web001", troubledSources),
    initialRouteState: { view: "usage", sourceId: "" },
    // The server reads the attention for Sources only.
    initialAttention: undefined,
  } satisfies PulseWorkspaceProps,
  sql: {
    ...flat("Web001", troubledSources),
    initialRouteState: { view: "sql", sourceId: "", sql: "" },
    // The server reads the attention for Sources only.
    initialAttention: undefined,
  } satisfies PulseWorkspaceProps,
};

/** The data catalog of "Website": event kinds with fields, metrics and no states. `many` adds rows for the scrollbar. */
export const flatSchema = (kind: string | null, many = false) => {
  const fields = [
    { key: "path", type: "string", types: ["string"], present: 9204, fillRate: 1 },
    { key: "referrer", type: "string", types: ["string"], present: 5614, fillRate: 0.61 },
    { key: "device", type: "string", types: ["string"], present: 9204, fillRate: 1 },
    { key: "value", type: "number", types: ["number"], present: 9204, fillRate: 1 },
    ...(many
      ? Array.from({ length: 30 }, (_, index) => ({
          key: `extra_${index + 1}`,
          type: "string",
          types: ["string"],
          present: 10,
          fillRate: 0.1,
        }))
      : []),
  ] as const;
  const rows: [string, string, string, string][] = [
    ["12:39:12", "/kontakt", "mobil", "suche.example"],
    ["12:39:09", "/", "desktop", ""],
    ["12:38:58", "/sammlung/vasen", "mobil", "suche.example"],
    ["12:38:41", "/", "mobil", ""],
    ["12:38:37", "/kontakt", "desktop", "newsletter"],
  ];
  const event = (name: string) => ({
    kind: name,
    firstSeenAt: "2026-10-01T08:00:00.000Z",
    lastSeenAt: "2026-10-19T12:39:12.000Z",
    sampledRows: 9204,
    fields: [...fields],
    fieldsTruncated: false,
    samples:
      kind === name
        ? rows.map(([time, path, device, referrer], index) => ({
            id: `evt-${index}`,
            ts: `2026-10-19T${time}.000Z`,
            value: 1,
            sourceId: "Src201",
            actorId: "",
            sessionId: "",
            correlationId: "",
            resourceKey: "",
            dimensions: null,
            attributes: { path, device, ...(referrer ? { referrer } : {}), value: 1 },
            attributesTruncated: false,
          }))
        : null,
  });
  const events = [
    "page_view",
    "short_link_open",
    "contact_form_sent",
    "problem",
    ...(many ? Array.from({ length: 24 }, (_, index) => `kind_${index + 1}`) : []),
  ];
  return {
    baseId: "Web001",
    generatedAt: now,
    kind,
    truncated: false,
    events: { total: events.length, items: events.map(event) },
    metrics: {
      total: 2,
      items: ["http_requests_total", "http_request_duration_seconds"].map((name) => ({
        name,
        type: name.endsWith("total") ? "counter" : "gauge",
        unit: null,
        seriesCount: 12,
        lastSampleAt: "2026-10-19T12:39:38.000Z",
        dimensions: [{ key: "route", values: 8 }],
        samples: null,
      })),
    },
    states: { total: 0, items: [] },
  };
};

/** Base members and source keys for the Usage tab. */
export const flatAccess = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    principal: { type: "service_account", serviceAccountId: "00000000-0000-4000-8000-000000000201" },
    permission: "read",
    createdAt: "2026-10-01T08:00:00.000Z",
    displayName: "Shop-Auswertung",
    serviceAccountKind: "standalone",
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    principal: { type: "user", userId: "00000000-0000-4000-8000-000000000202" },
    permission: "admin",
    createdAt: "2026-10-01T08:00:00.000Z",
    displayName: "Lena Berg",
  },
];
