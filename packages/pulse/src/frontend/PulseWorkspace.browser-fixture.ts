import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "solid-js";
import type { PulseSource } from "../contracts";
import type PulseOverview from "./PulseOverview.island";
import type { PulseWorkspaceProps } from "./workspace/types";

// Fixture data and the client bundle of the Pulse base page, shared by the browser test and screenshots.
const ui = new URL("../../../ui/", import.meta.url).pathname;
export const origin = "https://cloud.example.test";
const now = "2026-10-19T12:40:00.000Z";
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

export const buildWorkspaceHarness = async () => {
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
  return (props: PulseWorkspaceProps, locale = "de", dark = false, overview?: ComponentProps<typeof PulseOverview>) =>
    `<!doctype html><html lang="${locale}" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" data-app-id="pulse">` +
    `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div id="root"></div></main></div>` +
    `<script>window.__pulse=${JSON.stringify({ locale, props, overview })}</script><script>${bundle}</script></body></html>`;
};
