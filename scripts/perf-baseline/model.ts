import { z } from "zod";

export const pageIds = ["document", "faq", "mail-mailbox", "assistant-chat", "notebooks-editor", "files", "accounts"] as const;
export type PageId = (typeof pageIds)[number];
export const pageApps: Record<PageId, string> = {
  document: "core",
  faq: "faq",
  "mail-mailbox": "mail",
  "assistant-chat": "assistant",
  "notebooks-editor": "notebooks",
  files: "filesv2",
  accounts: "accounts",
};

export function parseArgs(args: string[]) {
  const options: { help: boolean; keep: boolean; skipBuild: boolean; runs: number; pages: PageId[]; out?: string; compare?: string } = {
    help: false,
    keep: false,
    skipBuild: false,
    runs: 3,
    pages: [...pageIds],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") options.help = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--runs" || arg === "--pages" || arg === "--out" || arg === "--compare") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--runs") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
          throw new Error("--runs needs a positive integer");
        options.runs = Number(value);
      } else if (arg === "--pages") {
        options.pages = z.array(z.enum(pageIds)).min(1).parse(value.split(","));
        if (new Set(options.pages).size !== options.pages.length) throw new Error("--pages contains duplicates");
      } else if (arg === "--out") options.out = value;
      else options.compare = value;
    } else throw new Error(`Unknown flag: ${arg}`);
  }
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
export const pageResultSchema = z.object({
  id: z.enum(pageIds),
  path: z.string(),
  status: z.enum(["ok", "failed"]),
  errors: z.array(z.string()),
  notes: z.array(z.string()),
  static: staticSchema.nullable(),
  browsers: z.array(browserResultSchema),
});
export type PageResult = z.infer<typeof pageResultSchema>;
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
    transport: z.literal("https-h2-caddy"),
    runtimeImage: z.string(),
    seedVersion: z.literal(1),
  }),
  pages: z.array(pageResultSchema),
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

export function interactive(state: { initial: number; mounted: number; pendingScripts: number; quietMs: number }) {
  return state.mounted === state.initial && state.pendingScripts === 0 && state.quietMs >= 500;
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
    `Bun ${m.bunVersion} · Playwright ${m.playwrightVersion} · CPUs ${m.cpuCount} · load ${m.loadAverage.start.toFixed(1)} → ${m.loadAverage.end?.toFixed(1) ?? "—"} · ${m.runs} cold runs per profile`,
    `Browsers: ${
      Object.entries(m.browserVersions)
        .map(([name, version]) => `${name} ${version}`)
        .join(", ") || "none launched"
    }`,
    `Runtime: ${m.runtimeImage} · Seed version: ${m.seedVersion}`,
    `Origin: ${m.origin} · Transport: ${m.transport}`,
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
  lines.push(...result.errors.map((error) => `Failed: ${escape(error)}`), "");
  return lines.join("\n");
}
