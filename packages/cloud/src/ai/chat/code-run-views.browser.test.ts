import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AiTurnBlock, AiWireEvent } from "../protocol";
import type { AiStoredMessage } from "../types";
import { cloudAiViewSummary, parseCloudAiView } from "../view-block";

// A report the model builds in code mode stays first-class: `code_run` writes `cloud.view.stats`, `cloud.view.table`
// and `cloud.view.chart` files, `present` shows them, and the `chart` tool draws beside them. Capability view blocks
// share the chat's renderers and must not change these views; the snapshot was taken before the blocks existed.

const ui = resolve(import.meta.dir, "../../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "live-turn.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-code-run-views-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Code run views harness build failed");
  return build.outputs[0]!.text();
};

/** The files `cloud.view.*` writes in the report Valentin's code run built: key figures, a framed table, a bar chart. */
const views: Record<string, unknown> = {
  "/views/revenue-at-a-glance-1a2b3c4d.view.json": {
    view: "stats",
    title: "Umsatz auf einen Blick",
    subtitle: "Januar bis Oktober 2026",
    items: [
      { label: "Umsatz", value: 184250.4, format: { style: "currency", currency: "EUR" }, sparkline: [12, 15, 14, 18, 21, 19, 22] },
      { label: "Aufträge", value: 412, delta: 38, better: "up" },
      { label: "Ø Auftrag", value: 447.21, format: { style: "currency", currency: "EUR" }, sub: "ohne Stornos" },
      { label: "Quote", value: 0.27, format: { style: "percent" }, delta: -0.02, better: "up" },
    ],
  },
  "/views/top-customers-5e6f7a8b.view.json": {
    view: "table",
    title: "Top-Kunden",
    subtitle: "nach Umsatz",
    columns: [
      { id: "customer", label: "Kunde", type: "text" },
      { id: "orders", label: "Aufträge", type: "number" },
      { id: "revenue", label: "Umsatz", type: "number", format: { style: "currency", currency: "EUR" } },
    ],
    rows: [
      { customer: "Galerie Nord", orders: 38, revenue: 24210.5 },
      { customer: "Atelier Berg", orders: 27, revenue: 18990 },
      { customer: "Haus am See", orders: 21, revenue: 12480.25 },
      { customer: "Studio Weiß", orders: 14, revenue: 8120 },
    ],
    footer: { customer: "Summe", orders: 100, revenue: 63800.75 },
  },
  "/views/revenue-by-month-9c0d1e2f.view.json": {
    view: "chart",
    kind: "bar",
    title: "Umsatz je Monat",
    subtitle: "in EUR",
    data: [
      { label: "Jul", value: 17800 },
      { label: "Aug", value: 15200 },
      { label: "Sep", value: 19950 },
      { label: "Okt", value: 21400 },
    ],
  },
};
const chartArgs = {
  kind: "bar",
  title: "Aufträge je Kanal",
  data: [
    { label: "Laden", value: 182 },
    { label: "Online", value: 154 },
    { label: "Messe", value: 76 },
  ],
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/files") {
        const file = views[url.searchParams.get("path") ?? ""];
        return file ? Response.json(file, { headers: { "X-Cloud-Ai-File-Origin": "assistant" } }) : new Response(null, { status: 404 });
      }
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin: 0"><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const emit = async (page: Page, event: AiWireEvent) => {
  await page.evaluate((value) => (window as unknown as { emit: (event: AiWireEvent) => void }).emit(value), event);
  await frames(page);
};

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const paths = Object.keys(views);
const runArgs = { code: "const stats = await cloud.view.stats(…); …" };
const run: ToolBlock = {
  id: "tool-run",
  kind: "tool",
  callId: "run",
  name: "code_run",
  args: runArgs,
  status: "completed",
  result: { result: { views: paths }, logs: [] },
};
const presented = paths.map(
  (path, index): ToolBlock => ({
    id: `tool-present-${index}`,
    kind: "tool",
    callId: `present-${index}`,
    name: "present",
    args: { path },
    status: "completed",
    result: { path, size: 900, mediaType: "application/json", view: cloudAiViewSummary(parseCloudAiView(views[path])!) },
  }),
);
const chart: ToolBlock = {
  id: "tool-chart",
  kind: "tool",
  callId: "chart",
  name: "chart",
  args: chartArgs,
  status: "completed",
  result: { displayed: true },
};

const stored = (seq: number, message: AiStoredMessage["message"]): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "chat",
  seq,
  kind: "message",
  message,
  loopId: "turn",
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-11-08T10:00:00.000Z",
});

/** What the person sees of the report: the shared view parts in order, with their words and figures. */
const report = (page: Page) =>
  page.evaluate(() => {
    const words = (node: Element | null) => (node instanceof HTMLElement ? node.innerText : "").replace(/\s+/g, " ").trim();
    const content = document.querySelector(".k2b-chat-timeline__content")!;
    return {
      parts: Array.from(
        content.querySelectorAll(
          ".k2b-stat-grid, .k2b-stat-cell, .k2b-data-table, .k2b-chart-explorer, .k2b-chart, .k2b-dashboard-frame, .cloud-blocks, .k2b-chat-decision",
        ),
      ).map((node) => [...node.classList].filter((name) => /^(k2b|cloud)-[a-z-]+$/.test(name)).join(" ")),
      tiles: Array.from(content.querySelectorAll(".k2b-stat-cell")).map(words),
      headers: Array.from(content.querySelectorAll(".k2b-data-table thead th")).map(words),
      rows: Array.from(content.querySelectorAll(".k2b-data-table tbody tr, .k2b-data-table tfoot tr")).map(words),
      charts: Array.from(content.querySelectorAll(".k2b-chart-explorer")).map((section) => ({
        title: words(section.querySelector(".k2b-chart-explorer__title")),
        svg: section.querySelectorAll(".k2b-chart__svg").length,
      })),
    };
  });

for (const view of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const)
  test(`a code run's presented stats, table and chart and the chart tool render as before, live and after a reload (${view.name})`, async () => {
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-11-08T10:13:00Z"));
      await page.goto(`http://127.0.0.1:${server.port}/`);
      let seq = 1;
      await emit(page, { ...base, seq: seq++, type: "turn_started", modelId: "m", providerModel: "m", blocks: [] });
      for (const block of [run, ...presented, chart]) await emit(page, { ...base, seq: seq++, type: "block_set", block });
      await emit(page, { ...base, seq: seq++, type: "block_delta", blockId: "text-1", blockKind: "text", delta: "Der Bericht steht." });
      // Every presented view loads its file; the report is complete once each table row and chart is drawn.
      await page.waitForFunction(
        () => document.querySelectorAll(".k2b-data-table tbody tr").length >= 4 && document.querySelectorAll(".k2b-chart__svg").length >= 2,
      );
      await frames(page);
      const live = await report(page);
      expect(live.tiles.length).toBe(4);
      expect(live.charts.map((entry) => entry.title)).toEqual(["Umsatz je Monat", "Aufträge je Kanal"]);
      // Capability view blocks and approval cards never take over a code run's report.
      expect(live.parts.some((part) => part.includes("cloud-blocks") || part.includes("k2b-chat-decision"))).toBe(false);
      expect(live).toMatchSnapshot();

      // After the turn ends and the chat reloads from stored messages, the same report stands in the same places.
      await emit(page, {
        ...base,
        seq: seq++,
        type: "turn_finished",
        status: "completed",
        error: null,
        messages: [
          stored(10, { role: "user", content: [{ type: "text", text: "Bau mir einen Umsatzbericht" }] }),
          stored(11, {
            role: "assistant",
            content: [
              { type: "tool_call", id: "run", name: "code_run", args: runArgs },
              ...paths.map((path, index) => ({ type: "tool_call" as const, id: `present-${index}`, name: "present", args: { path } })),
              { type: "tool_call", id: "chart", name: "chart", args: chartArgs },
            ],
          }),
          stored(12, { role: "tool_result", callId: "run", name: "code_run", result: run.result, isError: false }),
          ...presented.map((block, index) =>
            stored(13 + index, { role: "tool_result", callId: block.callId, name: "present", result: block.result, isError: false }),
          ),
          stored(16, { role: "tool_result", callId: "chart", name: "chart", result: { displayed: true }, isError: false }),
          stored(17, { role: "assistant", content: [{ type: "text", text: "Der Bericht steht." }] }),
        ],
      });
      await page.waitForFunction(
        () => document.querySelectorAll(".k2b-data-table tbody tr").length >= 4 && document.querySelectorAll(".k2b-chart__svg").length >= 2,
      );
      await frames(page);
      expect(await report(page)).toEqual(live);
    } finally {
      await context.close();
    }
  }, 30_000);
