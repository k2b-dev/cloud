import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { aggregate, metricsSchema, staticSchema } from "../../../../scripts/perf-baseline/model";
import { pageChangesSchema, renderPageChanges } from "./page-change-model";

export const engines = ["chromium", "webkit"] as const;
export type Engine = (typeof engines)[number];
export const browserProfiles = ["desktop", "phone"] as const;

/**
 * One scenario list for every engine and profile. Each interaction loads `start` in its own
 * page to TTI, then times one user action until the named DOM state is painted.
 */
export const interactions = [
  {
    id: "mailbox-switch",
    trace: true,
    start: "Mailbox A's Inbox",
    action: "Click mailbox B in the sidebar (phone: inside the opened app menu)",
    end: "B's first Inbox row is in the viewport, the pathname is B's mailbox, its workspace island has mounted and the list is not busy",
  },
  {
    id: "folder-switch",
    trace: true,
    start: "Inbox",
    action: "Click the fixture's first custom folder in the navigation (phone: inside the opened app menu)",
    end: "The list heading names that folder and its first conversation row is in the viewport",
  },
  {
    id: "conversation-open",
    start: "The fixture's first custom folder, where no live arrivals land",
    action: "Click its first conversation whose newest message has a body",
    end: "The reader shows the body of the conversation's newest message in the viewport (HTML: after its frame reported its height)",
  },
  {
    id: "conversation-open-large",
    start: "An exact subject search for the fixture's largest thread (Project correspondence 0), verified on page 1 before each sample",
    action: "Click the largest thread's conversation row (180 messages by default; the reader loads the newest 100)",
    end: "The reader shows the body of the thread's newest message in the viewport (HTML: after its frame reported its height)",
  },
  {
    id: "list-scroll",
    start: "Inbox",
    action: "Scroll the conversation list to its end",
    end: "The first row of page 2 is appended to the list",
  },
  {
    id: "search-submit",
    start: "Mailbox",
    action: "Type the fixture's rare word into the search field and press Enter (timer starts at the Enter keydown)",
    end: "The heading names the search and its first result row is in the viewport",
  },
  {
    id: "live-arrival",
    start: "Inbox with a ready live subscription",
    action: "A new message is ingested through ingestEnvelope (t0 = commit acknowledgement)",
    end: "The new message's row is in the viewport",
  },
  {
    id: "compose-open",
    start: "Mailbox",
    action: "Click Compose (phone: inside the opened app menu)",
    end: "The message body editor is mounted, visible, enabled and writable",
  },
] as const;
export type InteractionId = (typeof interactions)[number]["id"];
export const interactionIds = interactions.map((interaction) => interaction.id);
export const loadPages = ["mailbox", "compose"] as const;
export type LoadPage = (typeof loadPages)[number];

export function parseBrowsers(value: string): Engine[] {
  const list = z.array(z.enum(engines)).min(1).parse(value.split(","));
  if (new Set(list).size !== list.length) throw new Error("--browser contains duplicates");
  return list;
}

export function parseInteractions(value: string): InteractionId[] {
  if (value === "none") return [];
  const list = z.array(z.enum(interactionIds)).min(1).parse(value.split(","));
  if (new Set(list).size !== list.length) throw new Error("--interactions contains duplicates");
  return list;
}
export function parseLoads(value: string): LoadPage[] {
  if (value === "none") return [];
  const list = z.array(z.enum(loadPages)).min(1).parse(value.split(","));
  if (new Set(list).size !== list.length) throw new Error("--loads contains duplicates");
  return list;
}

const ms = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const distributionSchema = z.object({ median: z.number(), min: z.number(), max: z.number() });

export const loadSampleSchema = metricsSchema.extend({
  /** HTML body download time, responseEnd - responseStart, ms. */
  documentTransferMs: ms,
  /** Latest end of an initial island's clear-and-render, page ms. */
  islandMountEndMs: ms,
  /** Union of the initial islands' clear-and-render windows until TTI, ms. */
  islandRenderMs: ms,
  /** Chromium only; WebKit has no long-task API. */
  longTaskCount: count.nullable(),
  longTaskMs: ms.nullable(),
});
export type LoadSample = z.infer<typeof loadSampleSchema>;
const loadMetricNames = loadSampleSchema.keyof().options;

export const traceSchema = z.object({
  /** Main-thread task time (RunTask) between navigation and TTI. */
  busyMs: ms,
  islandRenderMs: ms,
  styleLayoutMs: ms,
  parseCompileMs: ms,
  islandRenderShare: ms,
  styleLayoutShare: ms,
  parseCompileShare: ms,
});
export type TraceBreakdown = z.infer<typeof traceSchema>;

const engineStatus = {
  browser: z.enum(engines),
  profile: z.enum(browserProfiles),
  status: z.enum(["ok", "failed", "skipped"]),
  reason: z.string().nullable(),
};
export const loadProfileSchema = z.object({
  ...engineStatus,
  documentEncoding: z.array(z.string()),
  samples: z.array(loadSampleSchema),
  metrics: z.record(z.string(), distributionSchema.nullable()).nullable(),
  /** One extra traced Chromium load, excluded from samples because tracing slows the page. */
  trace: traceSchema.nullable(),
  traceError: z.string().nullable(),
});
export type LoadProfile = z.infer<typeof loadProfileSchema>;
export const loadPageSchema = z.object({
  id: z.enum(loadPages),
  path: z.string(),
  errors: z.array(z.string()),
  static: staticSchema.nullable(),
  profiles: z.array(loadProfileSchema),
});

export const interactionRequestSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1),
  status: z.number().int().nullable(),
  encoding: z.string().nullable(),
  /** Known encoded response body and header bytes; unavailable sizes contribute 0. */
  bytes: count,
  /** The browser's error text when the request failed, for example when a navigation cancelled it. */
  failure: z.string().nullable(),
  /** Request timing excludes connection setup; unavailable for failures and older results. */
  serverMs: ms.optional(),
  transferMs: ms.optional(),
  encodedBytes: count.optional(),
});
export const interactionSampleSchema = z.object({
  durationMs: ms,
  requests: z.array(interactionRequestSchema),
  apiRequests: count,
  apiBytes: count,
  totalBytes: count,
  /** Document navigation or the destination mailbox workspace fetch. */
  mainRequest: interactionRequestSchema.optional(),
});
export type InteractionSample = z.infer<typeof interactionSampleSchema>;
const interactionMetricsSchema = z.object({
  durationMs: z.object({ median: ms, p95: ms, min: ms, max: ms }),
  apiRequests: ms,
  apiBytes: ms,
  serverMs: ms.optional(),
  transferMs: ms.optional(),
  encodedBytes: ms.optional(),
});
export const interactionTraceSchema = traceSchema.extend({
  totalMs: ms,
  scriptMs: ms,
  otherMs: ms,
  scriptShare: ms,
  otherShare: ms,
  mainRequest: interactionRequestSchema.optional(),
});
export type InteractionTrace = z.infer<typeof interactionTraceSchema>;
export const interactionProfileSchema = z.object({
  ...engineStatus,
  samples: z.array(interactionSampleSchema),
  metrics: interactionMetricsSchema.nullable(),
  trace: interactionTraceSchema.nullable().optional(),
  traceError: z.string().nullable().optional(),
});
export type InteractionProfile = z.infer<typeof interactionProfileSchema>;
export const interactionResultSchema = z.object({
  id: z.enum(interactionIds as [InteractionId, ...InteractionId[]]),
  profiles: z.array(interactionProfileSchema),
});
export type InteractionResult = z.infer<typeof interactionResultSchema>;

export const browserSectionSchema = z.object({
  engines: z.array(z.enum(engines)),
  versions: z.record(z.string(), z.string()),
  playwrightVersion: z.string(),
  runs: z.number().int().positive(),
  pages: z.array(loadPageSchema),
  interactions: z.array(interactionResultSchema),
  errors: z.array(z.string()),
  pageChanges: pageChangesSchema.nullable().optional(),
});
export type BrowserSection = z.infer<typeof browserSectionSchema>;

/** Builds one sample; the API share counts requests to /api/. */
export function interactionSample(
  durationMs: number,
  requests: z.infer<typeof interactionRequestSchema>[],
  targetPath?: string,
): InteractionSample {
  const api = requests.filter((request) => request.path.startsWith("/api/"));
  return interactionSampleSchema.parse({
    durationMs: Number(durationMs.toFixed(1)),
    requests,
    apiRequests: api.length,
    apiBytes: api.reduce((sum, request) => sum + request.bytes, 0),
    totalBytes: requests.reduce((sum, request) => sum + request.bytes, 0),
    ...(targetPath ? { mainRequest: mainInteractionRequest(requests, targetPath) } : {}),
  });
}

export function mainInteractionRequest(requests: z.infer<typeof interactionRequestSchema>[], targetPath: string) {
  const workspace = `/api/mail/mailboxes/${targetPath.split("/").at(-1)}`;
  return requests.find((request) => {
    const path = request.path.split("?")[0];
    return (
      request.failure === null &&
      request.method === "GET" &&
      ((request.type === "document" && path === targetPath) ||
        ((request.type === "fetch" || request.type === "xhr") &&
          (path === `${workspace}/workspace-route` || path === `${workspace}/workspace-list`)))
    );
  });
}

/** Chromium can report -1 for a cached body. Keep that measurement unavailable instead of rejecting the sample. */
export function interactionRequestSizes(sizes: { responseBodySize: number; responseHeadersSize: number } | null) {
  const body = sizes?.responseBodySize;
  const headers = sizes?.responseHeadersSize;
  return {
    bytes: Math.max(0, body ?? 0) + Math.max(0, headers ?? 0),
    ...(body !== undefined && body >= 0 ? { encodedBytes: body } : {}),
  };
}

export function interactionRequestTiming(timing: { requestStart: number; responseStart: number; responseEnd: number }) {
  if (timing.requestStart < 0 || timing.responseStart < timing.requestStart || timing.responseEnd < timing.responseStart) return {};
  return { serverMs: timing.responseStart - timing.requestStart, transferMs: timing.responseEnd - timing.responseStart };
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function summarizeInteraction(samples: InteractionSample[]): z.infer<typeof interactionMetricsSchema> {
  if (!samples.length) throw new Error("Cannot summarize an interaction without samples");
  const durations = samples.map((sample) => sample.durationMs).toSorted((a, b) => a - b);
  const round = (n: number) => Number(n.toFixed(1));
  return {
    durationMs: {
      median: round(median(durations)),
      p95: round(percentile(durations, 0.95)),
      min: round(durations[0]!),
      max: round(durations.at(-1)!),
    },
    apiRequests: median(samples.map((sample) => sample.apiRequests)),
    apiBytes: median(samples.map((sample) => sample.apiBytes)),
    ...Object.fromEntries(
      (["serverMs", "transferMs", "encodedBytes"] as const).flatMap((key) => {
        const values = samples.flatMap((sample) => (sample.mainRequest?.[key] === undefined ? [] : [sample.mainRequest[key]]));
        return values.length ? [[key, median(values)]] : [];
      }),
    ),
  };
}
export function summarizeLoads(samples: LoadSample[]) {
  return Object.fromEntries(loadMetricNames.map((name) => [name, aggregate(samples.map((sample) => sample[name]))]));
}

type Interval = [number, number];
/** Total length of the union of intervals clipped to [from, to]. */
export function unionLength(intervals: Interval[], from: number, to: number) {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of intervals
    .map(([a, b]): Interval => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])) {
    if (a >= end) {
      total += b - a;
      end = b;
    } else if (b > end) {
      total += b - end;
      end = b;
    }
  }
  return total;
}

export function islandRenderMs(timing: { mountStarts: number[]; mountTimes: number[]; tti: number }) {
  if (timing.mountStarts.length !== timing.mountTimes.length) throw new Error("Island mount starts and ends differ in length");
  return unionLength(
    timing.mountStarts.map((start, i): Interval => [start, timing.mountTimes[i]!]),
    0,
    timing.tti,
  );
}

export const syncMark = "cloud-mail-perf-sync";
const styleLayoutEvents = new Set(["UpdateLayoutTree", "RecalculateStyles", "RecalcStyle", "Layout", "ParseAuthorStyleSheet"]);
const parseCompileEvent = /^(v8\.(compile|parse|produce|deserialize)|V8\.(Compile|Parse)|CompileScript$|CompileCode$)/;
const traceEventSchema = z.looseObject({
  name: z.string(),
  cat: z.string().optional(),
  ph: z.string(),
  pid: z.number(),
  tid: z.number(),
  ts: z.number(),
  dur: z.number().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Splits the renderer main thread's work between navigation and TTI from a Chromium trace.
 * `markTimeMs` is the page time of the `syncMark` user-timing mark, which aligns trace
 * microseconds with page milliseconds and identifies the page's main thread.
 */
export function traceBreakdown(
  trace: unknown,
  timing: { markTimeMs: number; tti: number; mountStarts: number[]; mountTimes: number[] },
): TraceBreakdown {
  const raw = z.union([z.array(z.unknown()), z.object({ traceEvents: z.array(z.unknown()) })]).parse(trace);
  const events = (Array.isArray(raw) ? raw : raw.traceEvents).flatMap((event) => {
    const parsed = traceEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const mark = events.find((event) => event.name === syncMark && (event.cat ?? "").includes("blink.user_timing"));
  if (!mark) throw new Error(`Trace has no ${syncMark} user-timing mark`);
  // Page time t ms is trace time offset + t * 1000 µs.
  const offset = mark.ts - timing.markTimeMs * 1000;
  const toPage = (ts: number) => (ts - offset) / 1000;
  const main = events.filter((event) => event.pid === mark.pid && event.tid === mark.tid && event.ph === "X" && event.dur !== undefined);
  const intervals = (predicate: (name: string) => boolean) =>
    main.filter((event) => predicate(event.name)).map((event): Interval => [toPage(event.ts), toPage(event.ts + event.dur!)]);
  const busy = unionLength(
    intervals((name) => name === "RunTask" || name === "ThreadControllerImpl::RunTask"),
    0,
    timing.tti,
  );
  if (busy <= 0) throw new Error("Trace has no main-thread tasks before TTI");
  const island = islandRenderMs(timing);
  const style = unionLength(
    intervals((name) => styleLayoutEvents.has(name)),
    0,
    timing.tti,
  );
  const compile = unionLength(
    intervals((name) => parseCompileEvent.test(name)),
    0,
    timing.tti,
  );
  const round = (n: number) => Number(n.toFixed(1));
  const share = (n: number) => Number((n / busy).toFixed(4));
  return traceSchema.parse({
    busyMs: round(busy),
    islandRenderMs: round(island),
    styleLayoutMs: round(style),
    parseCompileMs: round(compile),
    islandRenderShare: share(island),
    styleLayoutShare: share(style),
    parseCompileShare: share(compile),
  });
}

/** Epoch times keep the action, mounts and sync mark comparable across documents. */
export function interactionTraceBreakdown(
  trace: unknown,
  timing: {
    markTimeMs: number;
    actionAt: number;
    hitAt: number;
    mountWindows: Interval[];
    frameIds: string[];
  },
): InteractionTrace {
  const raw = z.object({ traceEvents: z.array(z.unknown()) }).parse(trace);
  const events = raw.traceEvents.flatMap((value) => {
    const parsed = traceEventSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const mark = events.find((event) => event.name === syncMark && (event.cat ?? "").includes("blink.user_timing"));
  if (!mark) throw new Error(`Trace has no ${syncMark} user-timing mark`);
  const actionTraceUs = mark.ts + (timing.actionAt - timing.markTimeMs) * 1000;
  const pagePids = new Set<number>();
  const frameSchema = z.object({ frame: z.string(), processId: z.number(), parent: z.string().optional() });
  const frames = events.flatMap((event) => {
    const data = event.args?.data;
    if (event.name === "TracingStartedInBrowser") {
      const parsed = z.object({ frames: z.array(frameSchema) }).safeParse(data);
      return parsed.success ? parsed.data.frames : [];
    }
    if (event.name === "FrameCommittedInBrowser") {
      const parsed = frameSchema.safeParse(data);
      return parsed.success ? [parsed.data] : [];
    }
    return [];
  });
  const pageFrames = new Set(timing.frameIds);
  let added = true;
  while (added) {
    added = false;
    for (const frame of frames)
      if (frame.parent && pageFrames.has(frame.parent) && !pageFrames.has(frame.frame)) {
        pageFrames.add(frame.frame);
        added = true;
      }
  }
  for (const frame of frames) if (pageFrames.has(frame.frame)) pagePids.add(frame.processId);
  // The mark identifies the original renderer; frame commits identify a replacement renderer.
  pagePids.add(mark.pid);
  const threads = new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain" && pagePids.has(event.pid))
      .map((event) => `${event.pid}:${event.tid}`),
  );
  threads.add(`${mark.pid}:${mark.tid}`);
  const totals = { busyMs: 0, islandRenderMs: 0, styleLayoutMs: 0, parseCompileMs: 0, scriptMs: 0, otherMs: 0 };
  const scriptEvent = /^(EvaluateScript|EvaluateModule|FunctionCall|EventDispatch|v8\.run|V8\.Execute)$/;
  const spans = events
    .filter((event) => threads.has(`${event.pid}:${event.tid}`) && event.ph === "X" && event.dur !== undefined)
    .map((event) => ({
      name: event.name,
      start: Math.max(timing.actionAt, timing.actionAt + (event.ts - actionTraceUs) / 1000),
      end: Math.min(timing.hitAt, timing.actionAt + (event.ts + event.dur! - actionTraceUs) / 1000),
    }))
    .filter((span) => span.end > span.start);
  type Category = "busyMs" | "islandRenderMs" | "parseCompileMs" | "styleLayoutMs" | "scriptMs";
  const edges: { time: number; key: Category; delta: number }[] = [];
  const add = (start: number, end: number, key: Category) => {
    start = Math.max(start, timing.actionAt);
    end = Math.min(end, timing.hitAt);
    if (end > start) edges.push({ time: start, key, delta: 1 }, { time: end, key, delta: -1 });
  };
  for (const span of spans) {
    const key =
      span.name === "RunTask" || span.name === "ThreadControllerImpl::RunTask"
        ? "busyMs"
        : parseCompileEvent.test(span.name)
          ? "parseCompileMs"
          : styleLayoutEvents.has(span.name)
            ? "styleLayoutMs"
            : scriptEvent.test(span.name)
              ? "scriptMs"
              : null;
    if (key) add(span.start, span.end, key);
  }
  for (const [start, end] of timing.mountWindows) add(start, end, "islandRenderMs");
  const active = { busyMs: 0, islandRenderMs: 0, parseCompileMs: 0, styleLayoutMs: 0, scriptMs: 0 };
  let previous = timing.actionAt;
  for (const edge of edges.sort((a, b) => a.time - b.time)) {
    const duration = edge.time - previous;
    if (active.busyMs > 0) {
      totals.busyMs += duration;
      // Disjoint attribution: the mount window owns its nested JS/layout/compile work.
      const key =
        active.islandRenderMs > 0
          ? "islandRenderMs"
          : active.parseCompileMs > 0
            ? "parseCompileMs"
            : active.styleLayoutMs > 0
              ? "styleLayoutMs"
              : active.scriptMs > 0
                ? "scriptMs"
                : "otherMs";
      totals[key] += duration;
    }
    active[edge.key] += edge.delta;
    previous = edge.time;
  }
  if (totals.busyMs <= 0) throw new Error("Trace has no page main-thread tasks in the interaction window");
  const shares = Object.fromEntries(
    (["islandRender", "styleLayout", "parseCompile", "script", "other"] as const).map((key) => [
      `${key}Share`,
      Number((totals[`${key}Ms`] / totals.busyMs).toFixed(4)),
    ]),
  );
  return interactionTraceSchema.parse({
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value.toFixed(1))])),
    ...shares,
    totalMs: Number((timing.hitAt - timing.actionAt).toFixed(1)),
  });
}

const fmt = (value: number | null | undefined, digits = 0) =>
  value === undefined || value === null ? "—" : value.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct = (value: number | null | undefined) => (value === undefined || value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const kb = (bytes: number | null | undefined) => (bytes === undefined || bytes === null ? "—" : `${(bytes / 1024).toFixed(1)} KB`);
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderBrowserSummary(section: BrowserSection) {
  const lines = [
    "## Browser: page loads",
    "",
    `Engines: ${section.engines.join(", ")} (${Object.entries(section.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join(", ")}); Playwright ${section.playwrightVersion}; ${section.runs} cold loads per engine and profile.`,
    "Local emulation, not real phones: Chromium phone runs at 4x CPU slowdown with 150 ms latency and 1.6 Mbit/s; WebKit is unthrottled. Times are medians in ms.",
    "",
  ];
  for (const page of section.pages) {
    lines.push(`### ${page.id}: \`${page.path}\``, "");
    if (page.static) {
      const js = page.static.js;
      lines.push(
        `Static: eager JS ${kb(js.eager.brotli)} brotli in ${js.eager.modules} modules; lazy JS ${kb(js.lazy.brotli)} brotli in ${js.lazy.modules} modules; CSS ${kb(page.static.css.brotli)}; HTML ${kb(page.static.html.brotli)}; ${page.static.islands} islands; props ${kb(page.static.propsBytes)}.`,
        "",
      );
    }
    for (const error of page.errors) lines.push(`- Error: ${cell(error)}`);
    lines.push(
      "| Engine / profile | FCP | LCP | TTI | Island mount end | Island render | Long tasks (n / ms) | TBT | JS transfer | Document transfer | Trace: busy / island / style+layout / parse+compile |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const profile of page.profiles) {
      const m = (name: string) => profile.metrics?.[name]?.median;
      const status = profile.status === "ok" ? "" : ` **${profile.status.toUpperCase()}**`;
      const trace = profile.trace
        ? `${fmt(profile.trace.busyMs)} ms / ${pct(profile.trace.islandRenderShare)} / ${pct(profile.trace.styleLayoutShare)} / ${pct(profile.trace.parseCompileShare)}`
        : profile.traceError
          ? `error: ${cell(profile.traceError.slice(0, 200))}`
          : "—";
      lines.push(
        `| ${profile.browser} ${profile.profile}${status} | ${fmt(m("fcpMs"))} | ${fmt(m("lcpMs"))} | ${fmt(m("ttiMs"))} | ${fmt(m("islandMountEndMs"))} | ${fmt(m("islandRenderMs"))} | ${fmt(m("longTaskCount"))} / ${fmt(m("longTaskMs"))} | ${fmt(m("totalBlockingTimeMs"))} | ${kb(m("jsBytes"))} | ${fmt(m("documentTransferMs"))} ms, ${kb(m("documentBytes"))} ${cell(profile.documentEncoding.join("/") || "—")} | ${trace} |`,
      );
      if (profile.reason) lines.push(`| ↳ reason: ${cell(profile.reason.slice(0, 500))} | | | | | | | | | | |`);
    }
    lines.push("");
  }
  lines.push(
    "## Browser: interactions",
    "",
    "Each sample loads the start page in its own cold page to TTI, then times from the input event (or the ingest commit) to the frame that paints the end state. Requests are those started in that window.",
    "",
  );
  for (const definition of interactions) {
    const result = section.interactions.find((item) => item.id === definition.id);
    if (!result) continue;
    lines.push(
      `### ${definition.id}`,
      "",
      `Start: ${definition.start}. Action: ${definition.action}. End: ${definition.end}.`,
      "",
      "| Engine / profile | Median | p95 | Min / max | API requests | API bytes |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const profile of result?.profiles ?? []) {
      const status = profile.status === "ok" ? "" : ` **${profile.status.toUpperCase()}**`;
      const d = profile.metrics?.durationMs;
      lines.push(
        `| ${profile.browser} ${profile.profile}${status} | ${fmt(d?.median)} | ${fmt(d?.p95)} | ${fmt(d?.min)} / ${fmt(d?.max)} | ${fmt(profile.metrics?.apiRequests)} | ${kb(profile.metrics?.apiBytes)} |`,
      );
      if (profile.reason) lines.push(`| ↳ reason: ${cell(profile.reason.slice(0, 500))} | | | | | |`);
    }
    if (result.profiles.some((profile) => profile.samples.some((sample) => sample.mainRequest))) {
      lines.push(
        "",
        "| Engine / profile | Main request server | Transfer | Encoded body | Encoding |",
        "| --- | ---: | ---: | ---: | --- |",
      );
      for (const profile of result.profiles)
        lines.push(
          `| ${profile.browser} ${profile.profile} | ${fmt(profile.metrics?.serverMs)} | ${fmt(profile.metrics?.transferMs)} | ${kb(profile.metrics?.encodedBytes)} | ${[...new Set(profile.samples.flatMap((sample) => (sample.mainRequest?.encoding ? [sample.mainRequest.encoding] : [])))].join("/") || "—"} |`,
        );
    }
    const requests = result?.profiles.find((profile) => profile.samples.length)?.samples.at(-1)?.requests ?? [];
    if (requests.length)
      lines.push(
        "",
        `Requests in the last ${result?.profiles.find((profile) => profile.samples.length)?.browser} sample: ${requests
          .map((request) => `${request.method} ${request.path.split("?")[0]} ${kb(request.bytes)} ${request.encoding ?? "—"}`)
          .join("; ")}.`,
      );
    lines.push("");
  }
  const traced = section.interactions.flatMap((entry) =>
    entry.profiles.filter((profile) => profile.trace || profile.traceError).map((profile) => ({ id: entry.id, profile })),
  );
  if (traced.length) {
    lines.push(
      "## Interaction breakdown",
      "",
      "One extra Chromium sample per opted-in interaction and profile; excluded from timing samples. Total is elapsed ms; busy time is the union of page main-thread tasks; categories are disjoint ms (share of busy task time). Island render owns work inside mount windows; server and transfer are the main request in the traced sample.",
      "",
      "| Interaction | Profile | Total | Server time | Transfer | JS | Parse/compile | Island render | Style/layout | Other |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const { id, profile } of traced) {
      const t = profile.trace;
      const part = (ms: number | undefined, share: number | undefined) => `${fmt(ms)} (${pct(share)})`;
      lines.push(
        `| ${id} | ${profile.browser} ${profile.profile} | ${fmt(t?.totalMs)} | ${fmt(t?.mainRequest?.serverMs)} | ${fmt(t?.mainRequest?.transferMs)} | ${part(t?.scriptMs, t?.scriptShare)} | ${part(t?.parseCompileMs, t?.parseCompileShare)} | ${part(t?.islandRenderMs, t?.islandRenderShare)} | ${part(t?.styleLayoutMs, t?.styleLayoutShare)} | ${part(t?.otherMs, t?.otherShare)} |`,
      );
      if (profile.traceError) lines.push(`Trace error (${id}, ${profile.profile}): ${cell(profile.traceError)}`, "");
    }
    lines.push("");
  }
  for (const error of section.errors) lines.push(`- Browser error: ${cell(error)}`);
  if (section.pageChanges) lines.push(...renderPageChanges(section.pageChanges));
  return lines;
}

/** Every measured time in a Mail result, by a stable id that bottleneck candidates reference. */
export function timeMetrics(result: {
  scenarios: {
    id: string;
    status: string;
    metrics: Record<string, { median: number; p95: number }> | null;
    database: { msPerRun: number } | null;
  }[];
  browser?: BrowserSection | null;
}) {
  const index = new Map<string, number>();
  for (const scenario of result.scenarios) {
    if (scenario.status !== "ok") continue;
    for (const key of ["totalMs", "ttfbMs", "liveMs", "visibleMs"]) {
      const value = scenario.metrics?.[key];
      if (value) {
        index.set(`server.${scenario.id}.${key}.median`, value.median);
        index.set(`server.${scenario.id}.${key}.p95`, value.p95);
      }
    }
    if (scenario.database) index.set(`server.${scenario.id}.dbMsPerRun`, scenario.database.msPerRun);
  }
  for (const page of result.browser?.pages ?? [])
    for (const profile of page.profiles) {
      if (profile.status !== "ok") continue;
      for (const key of [
        "fcpMs",
        "lcpMs",
        "ttiMs",
        "totalBlockingTimeMs",
        "islandMountEndMs",
        "islandRenderMs",
        "longTaskMs",
        "documentTransferMs",
      ]) {
        const value = profile.metrics?.[key]?.median;
        if (typeof value === "number") index.set(`load.${page.id}.${profile.browser}.${profile.profile}.${key}`, value);
      }
      if (profile.trace)
        for (const key of ["busyMs", "islandRenderMs", "styleLayoutMs", "parseCompileMs"] as const)
          index.set(`trace.${page.id}.${profile.browser}.${profile.profile}.${key}`, profile.trace[key]);
    }
  for (const interaction of result.browser?.interactions ?? [])
    for (const profile of interaction.profiles)
      if (profile.status === "ok" && profile.metrics) {
        index.set(`interaction.${interaction.id}.${profile.browser}.${profile.profile}.median`, profile.metrics.durationMs.median);
        index.set(`interaction.${interaction.id}.${profile.browser}.${profile.profile}.p95`, profile.metrics.durationMs.p95);
        for (const key of ["serverMs", "transferMs"] as const) {
          const value = profile.metrics[key];
          if (value !== undefined) index.set(`interaction.${interaction.id}.${profile.browser}.${profile.profile}.${key}`, value);
        }
        if (profile.trace)
          for (const key of ["totalMs", "busyMs", "scriptMs", "parseCompileMs", "islandRenderMs", "styleLayoutMs", "otherMs"] as const)
            index.set(`interactionTrace.${interaction.id}.${profile.browser}.${profile.profile}.${key}`, profile.trace[key]);
      }
  for (const profile of result.browser?.pageChanges?.profiles ?? []) {
    if (profile.status !== "ok" || !profile.samples.length) continue;
    for (const key of ["clickToMainMs", "clickToFirstActionMs", "panelContextMs"] as const) {
      const values = profile.samples.flatMap((sample) => (sample[key] === null ? [] : [sample[key]]));
      if (values.length)
        index.set(`pageChange.${profile.id}.${profile.browser}.${profile.profile}.${profile.cache}.${key}`, median(values));
    }
  }
  return index;
}

export const bottleneckCandidateSchema = z.object({
  title: z.string().min(1),
  /** Repository-relative `path:line` of the code that owns the cost. */
  location: z.string(),
  /** The complete source line, with surrounding whitespace removed. */
  anchor: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), "Anchor must be one non-empty source line"),
  /** A key of timeMetrics(result); its value from this run ranks the candidate. */
  metric: z.string().min(1),
  evidence: z.string().min(1),
  slice: z.string().min(1),
});
export type BottleneckCandidate = z.infer<typeof bottleneckCandidateSchema>;

/**
 * Validates candidates against the repository and this run, then ranks them by the
 * measured time of their metric. Refuses a blank or changed source line, a candidate without a real file:line or
 * without a measured number, fewer than `top` candidates, and a list that mixes
 * server and browser metrics.
 */
export function rankBottlenecks(metrics: Map<string, number>, candidates: unknown, repository: string, top = 5) {
  const list = z.array(bottleneckCandidateSchema).parse(candidates);
  const ranked = list.map((candidate) => {
    const match = /^([^\s:]+):(\d+)$/.exec(candidate.location);
    if (!match) throw new Error(`Bottleneck "${candidate.title}" needs a file:line location, got "${candidate.location}"`);
    const [, file, line] = match;
    if (isAbsolute(file!) || normalize(file!).startsWith(".."))
      throw new Error(`Bottleneck "${candidate.title}" location must be repository-relative`);
    const path = join(repository, file!);
    if (!existsSync(path)) throw new Error(`Bottleneck "${candidate.title}" location does not exist: ${file}`);
    const lines = readFileSync(path, "utf8").split("\n");
    if (Number(line) < 1 || Number(line) > lines.length)
      throw new Error(`Bottleneck "${candidate.title}" line ${line} is outside ${file} (${lines.length} lines)`);
    const source = lines[Number(line) - 1]!.trim();
    if (!source) throw new Error(`Bottleneck "${candidate.title}" location points to a blank line: ${candidate.location}`);
    if (source !== candidate.anchor)
      throw new Error(
        `Bottleneck "${candidate.title}" source anchor no longer matches ${candidate.location}; check the code and update the reference`,
      );
    const value = metrics.get(candidate.metric);
    if (value === undefined || !Number.isFinite(value))
      throw new Error(`Bottleneck "${candidate.title}" has no measured number in this run for ${candidate.metric}`);
    return { ...candidate, value };
  });
  if (ranked.length < top) throw new Error(`Need at least ${top} bottleneck candidates, got ${ranked.length}`);
  // A server request time and a throttled browser time do not measure the same thing; one list ranks one family.
  if (new Set(ranked.map((entry) => entry.metric.startsWith("server."))).size > 1)
    throw new Error("Bottleneck candidates mix server and browser metrics; rank one metric family at a time");
  return ranked.toSorted((a, b) => b.value - a.value).slice(0, top);
}

export function renderBottlenecks(ranked: ReturnType<typeof rankBottlenecks>) {
  return [
    `## Top ${ranked.length} bottlenecks`,
    "",
    "Ranked by the measured time of each entry's metric in this run.",
    "",
    "| # | Bottleneck | Measured | Metric | Location | Evidence | Planned slice |",
    "| ---: | --- | ---: | --- | --- | --- | --- |",
    ...ranked.map(
      (entry, i) =>
        `| ${i + 1} | ${cell(entry.title)} | ${fmt(entry.value)} ms | \`${entry.metric}\` | \`${entry.location}\` | ${cell(entry.evidence)} | ${cell(entry.slice)} |`,
    ),
    "",
  ].join("\n");
}
