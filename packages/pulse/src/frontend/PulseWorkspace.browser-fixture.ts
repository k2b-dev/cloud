import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { User } from "@k2b/cloud/contracts";
import type { ComponentProps } from "solid-js";
import type { launchBrowser } from "../../../ui/test/browser";
import type { PulseSource } from "../contracts";
import type { Overview } from "../overview-contracts";
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

export const baseOverviewFixture: Overview = {
  baseId: "Lad001",
  name: "Laden",
  timezone: "Europe/Berlin",
  readAt: now,
  storeUnavailable: false,
  sources: { total: 4, current: 3 },
  attention: {
    total: 1,
    nextOffset: null,
    items: [
      {
        id: "alert-Alt001",
        kind: "alert",
        reference: "Alt001",
        name: "Antwortzeit",
        state: "firing",
        severity: "warn",
        since: "2026-10-19T12:30:00.000Z",
        lastCheckedAt: now,
        errorCode: null,
        key: "shop",
        value: 254,
        comparison: "above",
        threshold: 200,
        newestDataAt: null,
        expectEverySeconds: null,
        expectDailyBy: null,
      },
    ],
  },
  numbers: [
    { name: "CPU-Auslastung", value: 42, unit: "%", detail: "↓ 4 % zur Vorwoche", detailTone: "success" },
    { name: "Antwortzeit", value: 254, unit: "ms", detail: "↑ 12 % zur Vorwoche", detailTone: "warning" },
    { name: "Bestellungen heute", value: 128, unit: "", detail: "↑ 8 % zur Vorwoche", detailTone: "success" },
    { name: "Umsatz heute", value: 12480, unit: "€", detail: "↑ 6 % zur Vorwoche", detailTone: "success" },
  ].map((number, index) => ({
    queryId: `Num00${index}`,
    name: number.name,
    revision: 1,
    status: "ready",
    errorCode: null,
    lastAttemptAt: now,
    nextRefreshAt: "2026-10-19T12:45:00.000Z",
    lastGood: {
      evaluatedAt: now,
      windowFrom: "2026-10-18T12:40:00.000Z",
      windowTo: now,
      data: {
        ...number,
        valueAt: now,
        detailTone: number.detailTone === "warning" ? "warning" : "success",
        truncated: false,
        points: [0.7, 0.8, 0.75, 0.9, 0.85, 1].map((factor, step) => ({
          x: Date.parse(now) - (5 - step) * 300_000,
          y: number.value * factor,
        })),
      },
    },
  })),
  activity: {
    nextCursor: null,
    items: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        at: "2026-10-19T12:30:00.000Z",
        kind: "query_saved",
        actor: { kind: "user", id: "Person1", name: "Jana" },
        data: { name: "Umsatz heute" },
      },
    ],
  },
};

export const overviewWorkspaceFixture: PulseWorkspaceProps = {
  ...workspaceFixture,
  initialRouteState: { view: "overview", sourceId: "" },
  initialOverview: { data: baseOverviewFixture, error: null },
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
