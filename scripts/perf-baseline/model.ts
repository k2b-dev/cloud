import { z } from "zod";

export const defaultPageIds = [
  "document",
  "faq",
  "mail-mailbox",
  "assistant-chat",
  "notebooks-editor",
  "files",
  "accounts",
  "spaces",
] as const;
export const pageIds = [...defaultPageIds, "pwa"] as const;
export type PageId = (typeof pageIds)[number];
export const pageApps: Record<PageId, string[]> = {
  document: ["core"],
  faq: ["faq"],
  "mail-mailbox": ["mail"],
  "assistant-chat": ["assistant"],
  "notebooks-editor": ["notebooks"],
  files: ["filesv2"],
  accounts: ["accounts"],
  spaces: ["spaces"],
  pwa: ["pwa", "spaces"],
};

export function parseArgs(args: string[]) {
  const options: {
    help: boolean;
    panel: boolean;
    keep: boolean;
    skipBuild: boolean;
    runs: number;
    pages: PageId[];
    out?: string;
    compare?: string;
    origin?: string;
    rttMs?: number;
  } = {
    help: false,
    panel: false,
    keep: false,
    skipBuild: false,
    runs: 3,
    pages: [...defaultPageIds],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") options.help = true;
    else if (arg === "--panel") options.panel = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--runs" || arg === "--pages" || arg === "--out" || arg === "--compare" || arg === "--origin" || arg === "--rtt") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--runs") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
          throw new Error("--runs needs a positive integer");
        options.runs = Number(value);
      } else if (arg === "--pages") {
        options.pages = z.array(z.enum(pageIds)).min(1).parse(value.split(","));
        if (new Set(options.pages).size !== options.pages.length) throw new Error("--pages contains duplicates");
      } else if (arg === "--origin") {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
          throw new Error("--origin needs an HTTPS origin without path, query, hash or credentials");
        options.origin = url.origin;
      } else if (arg === "--rtt") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) throw new Error("--rtt needs an integer from 1 to 1000 ms");
        options.rttMs = Number(value);
      } else if (arg === "--out") options.out = value;
      else options.compare = value;
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  if (options.panel && (args.includes("--pages") || options.compare))
    throw new Error("--panel cannot be combined with --pages or --compare");
  if (options.panel) options.pages = [];
  if (options.origin && (options.pages.length !== 1 || options.pages[0] !== "pwa" || options.skipBuild || options.keep))
    throw new Error("--origin requires --pages pwa exactly and rejects --skip-build and --keep");
  return options;
}

export const bytesSchema = z.object({
  raw: z.number().int().nonnegative(),
  gzip: z.number().int().nonnegative(),
  brotli: z.number().int().nonnegative(),
});
export type Bytes = z.infer<typeof bytesSchema>;
const bundleSchema = bytesSchema.extend({ modules: z.number().int().nonnegative() });
export const staticSchema = z.object({
  html: bytesSchema,
  islands: z.number().int().nonnegative(),
  islandEntries: z.number().int().nonnegative(),
  propsBytes: z.number().int().nonnegative(),
  propsShare: z.number().nonnegative(),
  js: z.object({ eager: bundleSchema, lazy: bundleSchema }),
  css: bundleSchema,
});
export type StaticMetrics = z.infer<typeof staticSchema>;
const nullableMetric = z.number().finite().nonnegative().nullable();
export const metricsSchema = z.object({
  documentBytes: nullableMetric,
  jsBytes: nullableMetric,
  cssBytes: nullableMetric,
  otherBytes: nullableMetric,
  documentRequests: nullableMetric,
  jsRequests: nullableMetric,
  cssRequests: nullableMetric,
  otherRequests: nullableMetric,
  requests: nullableMetric,
  fcpMs: nullableMetric,
  lcpMs: nullableMetric,
  cls: nullableMetric,
  ttiMs: nullableMetric,
  lastLongTaskEndMs: nullableMetric,
  totalBlockingTimeMs: nullableMetric,
});
export type Metrics = z.infer<typeof metricsSchema>;
export const metricNames = metricsSchema.keyof().options;
const distributionSchema = z.object({ median: z.number(), min: z.number(), max: z.number() });
export const aggregatesSchema = z.record(metricsSchema.keyof(), distributionSchema.nullable());
export const browserResultSchema = z.object({
  browser: z.enum(["chromium", "webkit"]),
  profile: z.enum(["desktop", "phone"]),
  status: z.enum(["ok", "failed", "skipped"]),
  reason: z.string().nullable(),
  cpuThrottle: z.number().nullable(),
  network: z.object({ latencyMs: z.number(), downloadBytesPerSecond: z.number(), uploadBytesPerSecond: z.number() }).nullable(),
  transferSource: z.enum(["cdp.encodedDataLength", "playwright.request.sizes"]),
  contentEncoding: z.object({ js: z.array(z.string()), css: z.array(z.string()) }),
  samples: z.array(metricsSchema),
  metrics: aggregatesSchema.nullable(),
});
export type BrowserResult = z.infer<typeof browserResultSchema>;
export const pwaProfileIds = ["iphone", "ipad-portrait", "ipad-landscape", "ipad-split-view", "monitor", "phone"] as const;
export const pwaStepIds = [
  "launch-first",
  "launch-warm",
  "relaunch-start-url",
  "launch-expired",
  "launch-timezone",
  "tab-start-spaces",
  "tab-spaces-start",
  "tab-start-settings",
  "tab-settings-start",
  "history-back",
  "history-forward",
  "language-de",
  "language-en",
  "theme-light",
  "theme-dark",
  "theme-system",
  "rename",
  "check-off",
] as const;
export const assetCacheStates = ["cache", "revalidated", "network", "unknown"] as const;
export type AssetCacheState = (typeof assetCacheStates)[number];
export const pwaAssetSchema = z.object({
  path: z.string(),
  kind: z.enum(["script", "css", "font", "image", "other"]),
  state: z.enum(assetCacheStates),
  transferSize: nullableMetric,
  encodedBodySize: nullableMetric,
  status: z.number().int().nullable(),
  repeat: z.boolean(),
});
export const pwaDocumentSchema = z.object({
  path: z.string(),
  status: z.number().int().nullable(),
  requestStartMs: z.number().finite().nullable(),
  responseStartMs: z.number().finite().nullable(),
  responseEndMs: z.number().finite().nullable(),
  workerStartMs: z.number().finite().nullable(),
  transferSize: nullableMetric,
  serverTiming: z.array(z.object({ name: z.string(), durationMs: z.number().finite().nonnegative() })),
});
const pwaTimings = {
  pressedMs: nullableMetric,
  titleMs: nullableMetric,
  contentMs: nullableMetric,
  mountedMs: nullableMetric,
  selectedMs: nullableMetric,
  doneMs: nullableMetric,
};
export const pwaStepSchema = z.object({
  id: z.enum(pwaStepIds),
  finalPath: z.string().startsWith("/pwa/"),
  run: z.number().int().positive(),
  round: z.union([z.literal(1), z.literal(2)]),
  serviceWorker: z.enum(["allowed", "blocked"]),
  ...pwaTimings,
  titleFrame: z.boolean().nullable(),
  persisted: z.boolean().nullable(),
  documents: z.array(pwaDocumentSchema),
  assets: z.array(pwaAssetSchema),
});
export type PwaStep = z.infer<typeof pwaStepSchema>;
export type PwaAsset = z.infer<typeof pwaAssetSchema>;
export type PwaDocument = z.infer<typeof pwaDocumentSchema>;
const pwaDistribution = distributionSchema.nullable();
export const pwaSummaryRowSchema = z.object({
  id: z.enum(pwaStepIds),
  round: pwaStepSchema.shape.round,
  serviceWorker: pwaStepSchema.shape.serviceWorker,
  samples: z.number().int().nonnegative(),
  documents: pwaDistribution,
  pressedMs: pwaDistribution,
  titleMs: pwaDistribution,
  contentMs: pwaDistribution,
  mountedMs: pwaDistribution,
  selectedMs: pwaDistribution,
  doneMs: pwaDistribution,
  responseEndMs: pwaDistribution,
  serverMs: pwaDistribution,
  revalidated: pwaDistribution,
  downloaded: pwaDistribution,
  repeatedRequests: pwaDistribution,
  persisted: z.number().min(0).max(1).nullable(),
});
export type PwaSummaryRow = z.infer<typeof pwaSummaryRowSchema>;
export const pwaProfileResultSchema = z.object({
  profile: z.enum(pwaProfileIds),
  browser: z.enum(["chromium", "webkit"]),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  deviceScaleFactor: z.number().positive(),
  cpuThrottle: z.number().nullable(),
  network: browserResultSchema.shape.network,
  status: z.enum(["ok", "failed", "skipped"]),
  reason: z.string().nullable(),
  steps: z.array(pwaStepSchema),
  summary: z.array(pwaSummaryRowSchema),
});
export type PwaProfileResult = z.infer<typeof pwaProfileResultSchema>;
export const pwaResultSchema = z.object({
  origin: z.enum(["local", "remote"]),
  rttMs: z.number().int().positive().nullable(),
  deviceName: z.string(),
  notes: z.array(z.string()),
  profiles: z.array(pwaProfileResultSchema),
});
export type PwaResult = z.infer<typeof pwaResultSchema>;

export function assetCacheState(entry: { transferSize: number | undefined; status: number | null }): AssetCacheState {
  if (entry.status === 304) return "revalidated";
  if (entry.transferSize === undefined) return "unknown";
  return entry.transferSize === 0 ? "cache" : "network";
}

export function summarizePwa(steps: PwaStep[]): PwaSummaryRow[] {
  const rows: PwaSummaryRow[] = [];
  for (const id of pwaStepIds)
    for (const round of [1, 2] as const)
      for (const serviceWorker of ["allowed", "blocked"] as const) {
        const samples = steps.filter((step) => step.id === id && step.round === round && step.serviceWorker === serviceWorker);
        if (!samples.length) continue;
        // Unsupported observations stay null; mixed samples aggregate only their non-null values.
        const metric = (read: (step: PwaStep) => number | null) => {
          const values = samples.map(read).filter((value) => value !== null);
          return values.length ? aggregate(values) : null;
        };
        const persisted = samples.map((step) => step.persisted).filter((value) => value !== null);
        rows.push({
          id,
          round,
          serviceWorker,
          samples: samples.length,
          documents: metric((step) => step.documents.length),
          pressedMs: metric((step) => step.pressedMs),
          titleMs: metric((step) => step.titleMs),
          contentMs: metric((step) => step.contentMs),
          mountedMs: metric((step) => step.mountedMs),
          selectedMs: metric((step) => step.selectedMs),
          doneMs: metric((step) => step.doneMs),
          responseEndMs: metric((step) => step.documents.at(-1)?.responseEndMs ?? null),
          serverMs: metric((step) => {
            const last = step.documents.at(-1);
            return last ? last.serverTiming.reduce((sum, entry) => sum + entry.durationMs, 0) : null;
          }),
          revalidated: metric((step) => step.assets.filter((asset) => asset.state === "revalidated").length),
          downloaded: metric((step) => step.assets.filter((asset) => asset.state === "network").length),
          repeatedRequests: metric((step) => step.assets.filter((asset) => asset.repeat && asset.state !== "cache").length),
          persisted: persisted.length ? persisted.filter(Boolean).length / persisted.length : null,
        });
      }
  return rows;
}

export function cacheGate(result: PwaResult) {
  return result.profiles
    .filter((profile) => profile.browser === "webkit")
    .map((profile) => {
      const assets = profile.steps
        .filter((step) => step.id === "launch-warm" || step.id === "relaunch-start-url" || step.id.startsWith("tab-"))
        .flatMap((step) => step.assets)
        .filter((asset) => asset.repeat && asset.state !== "cache" && (asset.path.startsWith("/public/") || asset.path.includes("/_ssr/")));
      return {
        profile: profile.profile,
        revalidated: assets.filter((asset) => asset.state === "revalidated").length,
        downloaded: assets.filter((asset) => asset.state === "network").length,
        unknown: assets.filter((asset) => asset.state === "unknown").length,
        examples: [...new Set(assets.map((asset) => asset.path))].slice(0, 5),
      };
    });
}

export const pageResultSchema = z.object({
  pwa: pwaResultSchema.optional(),
  id: z.enum(pageIds),
  path: z.string(),
  status: z.enum(["ok", "failed"]),
  errors: z.array(z.string()),
  notes: z.array(z.string()),
  static: staticSchema.nullable(),
  browsers: z.array(browserResultSchema),
});
export type PageResult = z.infer<typeof pageResultSchema>;
/** Median limits: Doherty for desktop lag, RAIL for phone opening. */
export const desktopPanelThresholdMs = 400;
export const phonePanelThresholdMs = 1_000;
export const panelBorderlineShare = 0.1;
export const panelNavigationIds = ["spaces", "mail", "notebooks", "spaces-to-mail"] as const;
export const panelLayouts = ["column", "drawer", "sheet"] as const;
export const panelSegments = ["hostWaitMs", "frameStartMs", "providerSsrMs", "providerClientMs"] as const;
export type PanelSegment = (typeof panelSegments)[number];
const panelNumber = z.number().finite().nullable();
export const panelSampleMetricsSchema = z.object({
  panelContentMs: panelNumber,
  navigationGapMs: panelNumber,
  assignToContentMs: panelNumber,
  openToContentMs: panelNumber,
  hostTtiMs: z.number().finite(),
  hostLcpMs: panelNumber,
  panelLagMs: panelNumber,
  hostWaitMs: z.number().finite(),
  frameStartMs: z.number().finite(),
  providerSsrMs: z.number().finite(),
  providerClientMs: z.number().finite(),
  providerReadyMs: z.number().finite(),
  providerTtfbMs: z.number().finite().nonnegative(),
  providerDocumentBytes: z.number().int().nonnegative(),
  providerIslandRenderMs: z.number().finite().nonnegative(),
});
export const panelSampleSchema = panelSampleMetricsSchema
  .extend({ contentHeading: z.enum(["view", "start"]) })
  .superRefine((sample, context) => {
    const total = sample.panelContentMs ?? sample.openToContentMs;
    if (total === null || (sample.panelContentMs !== null && sample.openToContentMs !== null))
      context.addIssue({ code: "custom", message: "Panel sample needs exactly one main duration" });
    else if (Math.abs(panelSegments.reduce((sum, key) => sum + sample[key], 0) - total) > 1)
      context.addIssue({ code: "custom", message: "Panel split does not sum to the main duration" });
  });
export type PanelSample = z.infer<typeof panelSampleSchema>;
export const panelAggregatesSchema = z.record(panelSampleMetricsSchema.keyof(), distributionSchema.nullable());
export const panelProfileSchema = z.object({
  browser: z.enum(["chromium", "webkit"]),
  layout: z.enum(panelLayouts),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    deviceScaleFactor: z.number(),
    isMobile: z.boolean(),
    hasTouch: z.boolean(),
  }),
  cpuThrottle: z.number().nullable(),
  network: browserResultSchema.shape.network,
  status: z.enum(["ok", "failed", "skipped"]),
  reason: z.string().nullable(),
  samples: z.array(panelSampleSchema),
  aggregates: panelAggregatesSchema.nullable(),
  dominantSegment: z.enum(panelSegments).nullable(),
});
export type PanelProfile = z.infer<typeof panelProfileSchema>;
export const panelNavigationSchema = z.object({
  id: z.enum(panelNavigationIds),
  from: z.string(),
  to: z.string(),
  crossApp: z.boolean(),
  heading: z.enum(["view", "start"]),
  /** The heading the from page shows; desktop waits for it before the measured navigation. */
  fromHeading: z.enum(["view", "start"]),
  status: z.enum(["ok", "failed"]),
  errors: z.array(z.string()),
  providerStatic: staticSchema.nullable(),
  profiles: z.array(panelProfileSchema),
});
export type PanelNavigation = z.infer<typeof panelNavigationSchema>;
const panelWorstSchema = z.object({
  navigation: z.enum(panelNavigationIds),
  browser: z.enum(["chromium", "webkit"]),
  layout: z.enum(panelLayouts),
  medianMs: z.number(),
});
export const panelVerdictSchema = z.object({
  verdict: z.enum(["not slow", "slow", "incomplete"]),
  borderline: z.boolean(),
  desktopWorst: panelWorstSchema.nullable(),
  phoneWorst: panelWorstSchema.nullable(),
  reasons: z.array(z.string()),
  dominantSegment: z.enum(panelSegments).nullable(),
});
export const panelSchema = z.object({
  navigations: z.array(panelNavigationSchema),
  observations: z.array(
    z.object({
      engine: z.enum(["chromium", "webkit"]),
      switch: z.enum(["view", "folder"]),
      panelReloaded: z.boolean().nullable(),
      note: z.string(),
    }),
  ),
  verdict: panelVerdictSchema,
});
export type PanelResult = z.infer<typeof panelSchema>;

export function aggregatePanel(samples: PanelSample[]) {
  return panelAggregatesSchema.parse(
    Object.fromEntries(panelSampleMetricsSchema.keyof().options.map((key) => [key, aggregate(samples.map((s) => s[key]))])),
  );
}

export function medianPanelSample(samples: PanelSample[], layout: PanelProfile["layout"]) {
  const key = layout === "sheet" ? "openToContentMs" : "panelContentMs";
  if (!samples.length || samples.some((sample) => sample[key] === null)) throw new Error(`Missing ${key} sample`);
  const sample = [...samples].sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0))[Math.floor((samples.length - 1) / 2)];
  if (!sample) throw new Error("No median sample");
  return sample;
}

/**
 * Round boundaries, then subtract: the split always sums to the rounded total. A MutationObserver reports an
 * inserted iframe after the inserting task, so a frame whose navigation already started is bounded by that start.
 */
export function panelSplit(anchor: number, iframeSeen: number, frameNavigation: number, responseStart: number, hit: number) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = [anchor, Math.min(iframeSeen, frameNavigation), frameNavigation, responseStart, hit].map(
    Math.round,
  );
  const split = { hostWaitMs: b - a, frameStartMs: c - b, providerSsrMs: d - c, providerClientMs: e - d };
  if (Math.abs(Object.values(split).reduce((sum, value) => sum + value, 0) - (e - a)) > 1)
    throw new Error("Panel split does not sum to content time");
  return split;
}
export function dominantPanelSegment(samples: Pick<PanelSample, PanelSegment>[]): PanelSegment | null {
  if (!samples.length) return null;
  const totals = panelSegments.map((key) => ({ key, total: samples.reduce((sum, sample) => sum + sample[key], 0) }));
  return totals.sort((a, b) => b.total - a.total)[0]?.key ?? null;
}

export function panelVerdict(panel: Pick<PanelResult, "navigations">): PanelResult["verdict"] {
  const reasons: string[] = [];
  const missing: string[] = [];
  let desktopWorst: z.infer<typeof panelWorstSchema> | null = null;
  let phoneWorst: z.infer<typeof panelWorstSchema> | null = null;
  const splits: PanelSample[] = [];
  for (const id of panelNavigationIds) {
    const navigation = panel.navigations.find((item) => item.id === id);
    for (const browser of ["chromium", "webkit"] as const)
      for (const layout of panelLayouts) {
        if (browser === "chromium" && layout === "sheet") continue;
        const label = `${id} / ${browser} / ${layout}`;
        const profile = navigation?.profiles.find((row) => row.browser === browser && row.layout === layout);
        const metric = layout === "sheet" ? "openToContentMs" : "panelLagMs";
        const medianMs = profile?.aggregates?.[metric]?.median;
        if (!navigation || !profile || profile.status !== "ok" || medianMs == null || !profile.samples.length) {
          missing.push(
            `${label}: ${profile?.reason ?? profile?.status ?? "missing"}${navigation?.errors.length ? `; ${navigation.errors.join("; ")}` : ""}`,
          );
          continue;
        }
        splits.push(medianPanelSample(profile.samples, layout));
        const row = { navigation: id, browser, layout, medianMs };
        if (layout === "sheet") {
          if (!phoneWorst || medianMs > phoneWorst.medianMs) phoneWorst = row;
        } else if (!desktopWorst || medianMs > desktopWorst.medianMs) desktopWorst = row;
        const limit = layout === "sheet" ? phonePanelThresholdMs : desktopPanelThresholdMs;
        if (medianMs > limit) reasons.push(`${label}: median ${metric} ${medianMs} ms > ${limit} ms`);
      }
  }
  const borderline = [
    [desktopWorst, desktopPanelThresholdMs],
    [phoneWorst, phonePanelThresholdMs],
  ] as const;
  return {
    verdict: missing.length ? "incomplete" : reasons.length ? "slow" : "not slow",
    borderline: borderline.some(([row, limit]) => row !== null && Math.abs(row.medianMs - limit) <= panelBorderlineShare * limit),
    desktopWorst,
    phoneWorst,
    reasons: [...missing, ...reasons],
    dominantSegment: dominantPanelSegment(splits),
  };
}

export function renderPanelSummary(panel: PanelResult) {
  const v = panel.verdict;
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  const worst = (row: typeof v.desktopWorst) => (row ? `${row.medianMs} ms (${row.navigation} / ${row.browser} / ${row.layout})` : "—");
  const lines = [
    "## Panel after navigation",
    "",
    `Verdict: **${v.verdict}** · desktop lag ≤ ${desktopPanelThresholdMs} ms (Doherty) · WebKit sheet opening ≤ ${phonePanelThresholdMs} ms (RAIL) · borderline: ${v.borderline ? "yes" : "no"}.`,
    `Worst desktop: ${worst(v.desktopWorst)}. Worst phone: ${worst(v.phoneWorst)}.`,
    `Dominant segment: ${v.dominantSegment ?? "—"}. F10 removes in-app document loads only; cross-app loads and provider cost remain.`,
    "",
  ];
  for (const nav of panel.navigations) {
    lines.push(
      `### ${nav.id}: ${nav.from} → ${nav.to}`,
      "",
      `Expected heading: ${nav.heading}. ${nav.crossApp ? "Cross-app navigation." : "In-app navigation."}`,
      "",
      "| Browser / layout | Content / opening ms | Host TTI ms | Panel lag ms | Navigation gap ms | Assign → content ms | Median-sample split ms (%) | Dominant segment | Provider TTFB ms | Provider document B | Provider eager JS br B / islands | Provider island render ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: |",
    );
    for (const row of nav.profiles) {
      const metric = (key: keyof z.infer<typeof panelSampleMetricsSchema>) => {
        const d = row.aggregates?.[key];
        return d ? `${d.median} (${d.min}–${d.max})` : "—";
      };
      let split = "—";
      if (row.status === "ok" && row.samples.length) {
        const sample = medianPanelSample(row.samples, row.layout);
        const total = sample.panelContentMs ?? sample.openToContentMs ?? 0;
        split = panelSegments.map((key) => `${key}: ${sample[key]} (${total ? Math.round((100 * sample[key]) / total) : 0}%)`).join("; ");
      }
      lines.push(
        `| ${row.browser} / ${row.layout}${row.status === "ok" ? "" : `: ${row.status}`} | ${metric(row.layout === "sheet" ? "openToContentMs" : "panelContentMs")} | ${metric("hostTtiMs")} | ${metric("panelLagMs")} | ${metric("navigationGapMs")} | ${metric("assignToContentMs")} | ${split} | ${row.dominantSegment ?? "—"} | ${metric("providerTtfbMs")} | ${metric("providerDocumentBytes")} | ${nav.providerStatic ? `${nav.providerStatic.js.eager.brotli} / ${nav.providerStatic.islands}` : "—"} | ${metric("providerIslandRenderMs")} |`,
      );
    }
    lines.push(
      "",
      ...nav.errors.map((e) => `Failed: ${escape(e)}`),
      ...nav.profiles.filter((row) => row.reason).map((row) => `${row.browser} / ${row.layout}: ${escape(row.reason ?? "")}`),
      "",
    );
  }
  lines.push(
    "Mail observations:",
    "",
    ...panel.observations.map(
      (o) =>
        `- ${o.engine} ${o.switch}: panel ${o.panelReloaded === null ? "reload unknown" : o.panelReloaded ? "reloaded" : "preserved"}. ${escape(o.note)}`,
    ),
    "",
    ...v.reasons.map(escape),
    "",
  );
  return lines.join("\n");
}

export const resultSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({
    commit: z.string(),
    dirty: z.boolean(),
    timestamp: z.string(),
    bunVersion: z.string(),
    playwrightVersion: z.string(),
    browserVersions: z.record(z.string(), z.string()),
    cpuCount: z.number().int().positive(),
    /** One-minute host load average when the run started and ended; high values make timings noisy. */
    loadAverage: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative().nullable() }),
    runs: z.number().int().positive(),
    origin: z.string(),
    transport: z.enum(["https-h2-caddy", "remote"]),
    runtimeImage: z.string(),
    seedVersion: z.number().int().positive(),
    rttMs: z.number().int().positive().nullable().default(null),
  }),
  pages: z.array(pageResultSchema),
  panel: panelSchema.optional(),
  errors: z.array(z.string()),
});
export type Result = z.infer<typeof resultSchema>;

export function aggregate(values: (number | null)[], digits = 0): z.infer<typeof distributionSchema> | null {
  if (!values.length) throw new Error("Cannot aggregate an empty run");
  if (values.every((value) => value === null)) return null;
  const numbers: number[] = [];
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) throw new Error("Mixed null/non-finite metric samples");
    numbers.push(value);
  }
  numbers.sort((a, b) => a - b);
  const middle = Math.floor(numbers.length / 2);
  const upper = numbers[middle];
  const min = numbers[0];
  const max = numbers.at(-1);
  if (upper === undefined || min === undefined || max === undefined) throw new Error("Empty metric");
  const lower = numbers[middle - 1] ?? upper;
  const round = (n: number) => Number(n.toFixed(digits));
  return { median: round(numbers.length % 2 ? upper : (lower + upper) / 2), min: round(min), max: round(max) };
}

export function aggregateMetrics(samples: Metrics[]) {
  return aggregatesSchema.parse(
    Object.fromEntries(
      metricNames.map((name) => [
        name,
        aggregate(
          samples.map((sample) => sample[name]),
          name === "cls" ? 4 : 0,
        ),
      ]),
    ),
  );
}

export function interactive(state: { initial: number; mounted: number; pendingScripts: number; untimedScripts: number; quietMs: number }) {
  return state.mounted === state.initial && state.pendingScripts === 0 && state.untimedScripts === 0 && state.quietMs >= 500;
}

export function timeToInteractive(timing: {
  fcp: number | null;
  mountTimes: number[];
  scriptUrls: string[];
  resources: { name: string; responseEnd: number }[];
  longtasks: { start: number; duration: number }[];
}) {
  let end = timing.fcp ?? 0;
  for (const time of timing.mountTimes) end = Math.max(end, time);
  for (const url of timing.scriptUrls) {
    const entries = timing.resources.filter((entry) => entry.name === url);
    if (!entries.length) throw new Error(`Missing resource timing for observed script: ${url}`);
    for (const entry of entries) end = Math.max(end, entry.responseEnd);
  }
  for (const task of timing.longtasks) end = Math.max(end, task.start + task.duration);
  return end;
}

export function cumulativeLayoutShift(shifts: { start: number; value: number }[] | null) {
  if (shifts === null) return null;
  let maximum = 0;
  let sum = 0;
  let start = 0;
  let previous: number | null = null;
  for (const shift of [...shifts].sort((a, b) => a.start - b.start)) {
    if (previous === null || shift.start - previous > 1000 || shift.start - start > 5000) {
      start = shift.start;
      sum = 0;
    }
    sum += shift.value;
    maximum = Math.max(maximum, sum);
    previous = shift.start;
  }
  return maximum;
}

export function failedRequestError(resourceType: string, url: string, errorText: string | undefined) {
  if (!["document", "script", "stylesheet"].includes(resourceType)) return null;
  return `${resourceType} request failed: ${new URL(url).pathname} (${errorText ?? "unknown network error"})`;
}

export function longTaskMetrics(tasks: { start: number; duration: number }[], fcp: number | null, tti: number) {
  return {
    lastLongTaskEndMs: tasks.length ? Math.round(Math.max(...tasks.map((task) => task.start + task.duration))) : 0,
    totalBlockingTimeMs:
      fcp === null
        ? null
        : Math.round(
            tasks.reduce(
              (total, task) => total + Math.max(0, Math.min(task.start + task.duration, tti) - Math.max(task.start, fcp) - 50),
              0,
            ),
          ),
  };
}

export function decodeAttribute(value: string) {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original: string, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? original;
    const code = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === "x" ? 2 : 1), entity[1]?.toLowerCase() === "x" ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

/** Reads markup with Bun's HTML parser, never evaluates serialized seroval props. */
export async function inspectHtml(html: string, documentUrl: string) {
  const ids = new Set<string>();
  const modules = new Set<string>();
  const lazyModules = new Set<string>();
  const css = new Set<string>();
  const moduleSources: string[] = [];
  let islands = 0;
  let propsBytes = 0;
  let base = documentUrl;
  const reference = (value: string) => {
    const url = new URL(decodeAttribute(value), base);
    if (url.origin !== new URL(documentUrl).origin) throw new Error(`External asset cannot be measured from build output: ${url.origin}`);
    return url.pathname;
  };
  let module = false;
  let source = "";
  await new HTMLRewriter()
    .on("base[href]", {
      element(e) {
        base = new URL(decodeAttribute(e.getAttribute("href") ?? ""), documentUrl).href;
      },
    })
    .on("solid-island, solid-client", {
      element(e) {
        islands++;
        const id = e.getAttribute("data-id");
        if (!id) throw new Error("Island without data-id");
        ids.add(id);
        propsBytes += Buffer.byteLength(decodeAttribute(e.getAttribute("data-props") ?? "{}"));
      },
    })
    .on("script", {
      element(e) {
        module = e.getAttribute("type") === "module";
        source = "";
        const src = e.getAttribute("src");
        if (module && src) modules.add(reference(src));
        e.onEndTag(() => {
          if (module && !src) moduleSources.push(source);
          module = false;
        });
      },
      text(t) {
        if (module) source += t.text;
      },
    })
    .on('link[rel="stylesheet"][href]', {
      element(e) {
        css.add(reference(e.getAttribute("href") ?? ""));
      },
    })
    .transform(new Response(html))
    .text();
  const islandEntries = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: "js" });
  for (const text of moduleSources) {
    // SSR's initial dynamic import is an eager page dependency, not lazy extra.
    const prefix = /const p=("(?:\\.|[^"\\])*")/.exec(text)?.[1];
    if (prefix && text.includes("e.dataset.id")) {
      const path = z.string().parse(JSON.parse(prefix));
      for (const id of ids) islandEntries.add(reference(`${path}/${id}.js`));
    }
    for (const item of scanner.scanImports(text))
      if (item.path) (item.kind === "dynamic-import" ? lazyModules : modules).add(reference(item.path));
  }
  if (islands && !islandEntries.size) throw new Error("Unsupported SSR island loader: cannot resolve initial entry URLs");
  for (const entry of islandEntries) modules.add(entry);
  return {
    islands,
    islandEntries: [...islandEntries].sort(),
    propsBytes,
    propsShare: html.length ? propsBytes / Buffer.byteLength(html) : 0,
    modules: [...modules].sort(),
    lazyModules: [...lazyModules].sort(),
    css: [...css].sort(),
  };
}

export type Imports = { eager: string[]; lazy: string[] };
export function closure(entries: string[], graph: ReadonlyMap<string, Imports>, lazyEntries: string[] = []) {
  const walk = (roots: string[], includeLazy: boolean) => {
    const visited = new Set<string>();
    const queue = [...roots];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === undefined || visited.has(id)) continue;
      const item = graph.get(id);
      if (!item) throw new Error(`Missing module in import closure: ${id}`);
      visited.add(id);
      queue.push(...item.eager, ...(includeLazy ? item.lazy : []));
    }
    return visited;
  };
  const eager = walk(entries, false);
  const all = walk([...entries, ...lazyEntries], true);
  return { eager: [...eager].sort(), lazy: [...all].filter((id) => !eager.has(id)).sort() };
}

export function assetPath(path: string, apps: string[]) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Unsupported asset URL: ${path}`);
  const segments = path.split(/[?#]/)[0]?.split("/").slice(1).map(decodeURIComponent) ?? [];
  if (segments.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error(`Unsafe asset path: ${path}`);
  const ssrIndex = segments.indexOf("_ssr");
  if (ssrIndex >= 0) {
    const app = ssrIndex === 0 ? "core" : segments[ssrIndex - 1];
    const file = segments.slice(ssrIndex + 1);
    if (app && apps.includes(app) && file.length === 2) return { app, file: `_ssr/${file[1]}` };
  }
  const app = segments[1];
  if (segments[0] === "public" && app && apps.includes(app)) return { app, file: segments.join("/") };
  if (segments[0] === "public" && apps.includes("core")) return { app: "core", file: segments.join("/") };
  throw new Error(`No build output for asset: ${path}`);
}

export function validatePage(status: number, expected: string, actual: string, html: string) {
  const target = new URL(expected);
  const resolved = new URL(actual);
  if (status !== 200) throw new Error(`Page returned HTTP ${status}`);
  if (resolved.origin !== target.origin || resolved.pathname !== target.pathname || resolved.search !== target.search)
    throw new Error(`Target redirected to ${resolved.pathname}${resolved.search}`);
  if (!/<html[\s>]/i.test(html) || /Bad Gateway|upstream unavailable|no app registered for this path/i.test(html))
    throw new Error("Target is not a rendered application page");
  if (
    /<form[^>]+action=["'][^"']*\/(?:api\/)?auth\/(?:login|admin-login)/i.test(html) ||
    /(?:AdminLoginForm|PasswordLoginForm|LocalLoginForm)/.test(html) ||
    /<title>[^<]*(?:sign in|login|anmelden)/i.test(html)
  )
    throw new Error("Target rendered a sign-in page");
}

export function sortedJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b, "en"))
          .map(([key, item]) => [key, sort(item)]),
      );
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function renderSummary(result: Result, old?: Result) {
  const m = result.metadata;
  const lines = [
    "# Production performance baseline",
    "",
    `Commit: ${m.commit}${m.dirty ? " (dirty)" : ""} · UTC: ${m.timestamp}`,
    `Bun ${m.bunVersion} · Playwright ${m.playwrightVersion} · CPUs ${m.cpuCount} · load ${m.loadAverage.start.toFixed(1)} → ${m.loadAverage.end?.toFixed(1) ?? "—"} · ${m.runs} ${result.pages.some((page) => page.id === "pwa") ? "runs" : "cold runs"} per profile`,
    `Bun ${m.bunVersion} · Playwright ${m.playwrightVersion} · CPUs ${m.cpuCount} · load ${m.loadAverage.start.toFixed(1)} → ${m.loadAverage.end?.toFixed(1) ?? "—"} · ${m.runs} ${result.panel ? "warm navigation" : "cold"} runs per profile`,
    `Browsers: ${
      Object.entries(m.browserVersions)
        .map(([name, version]) => `${name} ${version}`)
        .join(", ") || "none launched"
    }`,
    `Runtime: ${m.runtimeImage} · Seed version: ${m.seedVersion}`,
    `Origin: ${m.origin} · Transport: ${m.transport}`,
    result.pages.some((page) => page.id === "pwa")
      ? "Session: paired mobile app; administrator used for pairing"
      : "Session: throwaway administrator",
    "",
    "Bytes and milliseconds are integers; all browser values below are medians. JS/CSS Brotli columns are build sizes, not measured transfers. Transfers include the encoding the browser negotiated.",
    "",
  ];
  if (
    old &&
    (old.metadata.seedVersion !== m.seedVersion || old.metadata.runs !== m.runs || old.metadata.playwrightVersion !== m.playwrightVersion)
  )
    lines.push("Comparison uses different run counts, seeds, or Playwright versions; interpret deltas with care.", "");
  const cell = (value: number | null | undefined) => (value == null ? "—" : String(value));
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const page of result.pages) {
    const reasons: string[] = [];
    lines.push(`## ${page.id} — ${page.path}`, "");
    if (page.pwa) {
      const pwa = page.pwa;
      lines.push(
        `Origin: ${pwa.origin} · RTT: ${cell(pwa.rttMs)} ms · Device: ${escape(pwa.deviceName)}`,
        "",
        ...pwa.notes.map(escape),
        "",
      );
      for (const profile of pwa.profiles) {
        lines.push(`### ${profile.browser} / ${profile.profile} — ${profile.status}`, "");
        if (profile.reason) lines.push(escape(profile.reason), "");
        lines.push(
          "| Step | Round | SW | Docs | Pressed | Title | Content | Mounted | Selected | Done | Doc end | Server | 304 | Downloads | Re-requests | bfcache |",
          "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        );
        for (const row of profile.summary) {
          const metrics = [
            row.documents,
            row.pressedMs,
            row.titleMs,
            row.contentMs,
            row.mountedMs,
            row.selectedMs,
            row.doneMs,
            row.responseEndMs,
            row.serverMs,
            row.revalidated,
            row.downloaded,
            row.repeatedRequests,
          ];
          lines.push(
            `| ${row.id} | ${row.round} | ${row.serviceWorker} | ${metrics.map((value) => cell(value?.median)).join(" | ")} | ${row.persisted === null ? "—" : `${Math.round(row.persisted * 100)}%`} |`,
          );
        }
        for (const step of profile.steps.filter((step) => step.id === "relaunch-start-url"))
          lines.push(
            `Relaunch through start_url (run ${step.run}, SW ${step.serviceWorker}): ${escape(step.finalPath)}; visible after ${cell(step.doneMs)} ms.`,
          );
        lines.push("");
      }
      for (const gate of cacheGate(pwa)) {
        const count = gate.revalidated + gate.downloaded + gate.unknown;
        lines.push(
          `WebKit ${gate.profile}: ${count} re-requested /public or /_ssr assets on tab switches and relaunches${count ? ` (${gate.revalidated} revalidated, ${gate.downloaded} downloaded, ${gate.unknown} unknown): ${gate.examples.map(escape).join(", ")}` : ""}`,
        );
      }
      lines.push("", ...page.notes.map(escape), ...page.errors.map((error) => `Failed: ${escape(error)}`), "");
      continue;
    }
    if (page.static) {
      const s = page.static;
      lines.push(
        "| Eager JS br (B) | Lazy JS br (B) | CSS br (B) | Islands / entries | Props (KiB) |",
        "| ---: | ---: | ---: | ---: | ---: |",
        `| ${s.js.eager.brotli} | ${s.js.lazy.brotli} | ${s.css.brotli} | ${s.islands} / ${s.islandEntries} | ${(s.propsBytes / 1024).toFixed(1)} |`,
        "",
      );
    }
    lines.push(
      `| Browser / profile | JS transfer (B) | CSS transfer (B) | Requests | FCP (ms) | TTI (ms) | CLS |${old ? " Δ TTI (ms) |" : ""}`,
      `| --- | ---: | ---: | ---: | ---: | ---: | ---: |${old ? " ---: |" : ""}`,
    );
    for (const browser of page.browsers) {
      const metric = (key: keyof Metrics) => browser.metrics?.[key]?.median;
      const previous = old?.pages
        .find((item) => item.id === page.id)
        ?.browsers.find((item) => item.browser === browser.browser && item.profile === browser.profile && item.status === "ok")?.metrics
        ?.ttiMs?.median;
      const tti = metric("ttiMs");
      const delta = browser.status === "ok" && tti != null && previous != null ? `${tti - previous >= 0 ? "+" : ""}${tti - previous}` : "—";
      if (browser.status === "ok")
        lines.push(
          `| ${browser.browser} / ${browser.profile} | ${cell(metric("jsBytes"))} | ${cell(metric("cssBytes"))} | ${cell(metric("requests"))} | ${cell(metric("fcpMs"))} | ${cell(tti)} | ${metric("cls")?.toFixed(4) ?? "—"} |${old ? ` ${delta} |` : ""}`,
        );
      else lines.push(`| ${browser.browser} / ${browser.profile}: ${browser.status} | — | — | — | — | — | — |${old ? " — |" : ""}`);
      if (browser.reason) reasons.push(`${browser.browser} / ${browser.profile}: ${escape(browser.reason)}`);
    }
    lines.push("", ...reasons, "", ...page.notes.map(escape), ...page.errors.map((error) => `Failed: ${escape(error)}`), "");
  }
  if (result.panel) lines.push(renderPanelSummary(result.panel));
  lines.push(...result.errors.map((error) => `Failed: ${escape(error)}`), "");
  return lines.join("\n");
}
