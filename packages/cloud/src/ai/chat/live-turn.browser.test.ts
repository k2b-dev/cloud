import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AiWireEvent } from "../protocol";

// Whether the live turn moves while a model call waits for its retry depends on real layout, fonts and
// themes, so this measures the real timeline in a browser.
const ui = resolve(import.meta.dir, "../../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "live-turn.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-live-turn-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Live turn harness build failed");
  return build.outputs[0]!.text();
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
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const lang = url.searchParams.get("lang") ?? "en";
      const theme = url.searchParams.get("theme") ?? "light";
      return new Response(
        `<!doctype html><html lang="${lang}" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin: 0"><script src="/harness.js"></script></body></html>`,
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
const steer = async (page: Page, text: string) => {
  await page.evaluate((value) => (window as unknown as { steer: (text: string) => void }).steer(value), text);
  await frames(page);
};

/** Each activity row and paragraph with its box relative to the timeline content, so following the end does not count as movement. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector(".k2b-chat-timeline__content")!.getBoundingClientRect();
    const viewport = document.querySelector(".k2b-chat-timeline__viewport")!;
    return {
      overflowX: viewport.scrollWidth - viewport.clientWidth,
      nodes: Array.from(document.querySelectorAll(".k2b-chat-activity, .k2b-chat-message__content p")).map((node) => {
        const box = node.getBoundingClientRect();
        return {
          text: node.textContent?.trim() ?? "",
          busy: node.getAttribute("data-busy") === "true",
          box: [box.left - content.left, box.top - content.top, box.width, box.height].map(Math.round),
        };
      }),
    };
  });

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a provider retry appends one calm row without moving the live turn (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        // The work line shows a ticking clock; a fixed time keeps its text comparable between measurements.
        await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${theme === "dark" ? "de" : "en"}&theme=${theme}`);
        const label = theme === "dark" ? "Verbindung wird wiederhergestellt" : "Reconnecting";
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, {
          ...base,
          seq: 2,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "I am checking the quarterly numbers.",
        });
        await emit(page, {
          ...base,
          seq: 3,
          type: "block_set",
          block: {
            id: "tool-1",
            kind: "tool",
            callId: "call-1",
            name: "web_search",
            args: { query: "quarterly numbers" },
            status: "completed",
            result: { results: [] },
          },
        });
        const before = await layout(page);

        await emit(page, { ...base, seq: 4, type: "provider_retry" });
        const waiting = await layout(page);
        expect(waiting.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
        const row = waiting.nodes.at(-1)!;
        expect(waiting.nodes).toHaveLength(before.nodes.length + 1);
        expect(row).toMatchObject({ text: label, busy: false });
        expect(row.box[1]).toBeGreaterThanOrEqual(Math.max(...before.nodes.map(({ box }) => box[1]! + box[3]!)));
        expect(waiting.overflowX).toBeLessThanOrEqual(0);

        // The row goes; the newest text takes the status's place in the same element and nothing moves.
        await emit(page, { ...base, seq: 5, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Here is the summary." });
        const resumed = await layout(page);
        const boxes = (nodes: typeof before.nodes) => nodes.map(({ box }) => box);
        expect(boxes(resumed.nodes)).toEqual(boxes(before.nodes));
        expect(resumed.nodes.map(({ text }) => text)).not.toContain(label);
        expect(resumed.nodes.at(-1)).toMatchObject({ text: "Here is the summary." });
      } finally {
        await context.close();
      }
    }, 30_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a provider retry after a pending steer appends its row below the steer (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        // The work line shows a ticking clock; a fixed time keeps its text comparable between measurements.
        await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${theme === "dark" ? "de" : "en"}&theme=${theme}`);
        const label = theme === "dark" ? "Verbindung wird wiederhergestellt" : "Reconnecting";
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, {
          ...base,
          seq: 2,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "I am checking the quarterly numbers.",
        });
        await steer(page, "Use the newer report instead.");
        const before = await layout(page);
        expect(before.nodes.at(-1)).toMatchObject({ text: "Use the newer report instead." });

        await emit(page, { ...base, seq: 3, type: "provider_retry" });
        const waiting = await layout(page);
        expect(waiting.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
        expect(waiting.nodes).toHaveLength(before.nodes.length + 1);
        const row = waiting.nodes.at(-1)!;
        expect(row).toMatchObject({ text: label, busy: false });
        expect(row.box[1]).toBeGreaterThanOrEqual(Math.max(...before.nodes.map(({ box }) => box[1]! + box[3]!)));
        expect(waiting.overflowX).toBeLessThanOrEqual(0);

        await emit(page, { ...base, seq: 4, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Here is the summary." });
        const resumed = await layout(page);
        expect(resumed.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
        expect(resumed.nodes.map(({ text }) => text)).not.toContain(label);
        expect(resumed.nodes.at(-1)).toMatchObject({ text: "Here is the summary." });
        expect(resumed.nodes.at(-1)!.box[1]).toBe(row.box[1]!);
      } finally {
        await context.close();
      }
    }, 30_000);
