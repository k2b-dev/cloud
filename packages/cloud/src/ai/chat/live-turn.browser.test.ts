import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AiWireEvent } from "../protocol";
import type { AiStoredMessage } from "../types";

// Whether the live turn moves while it reconnects depends on real layout, fonts and themes, so this
// measures the real timeline in a browser.
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
      // A tall screenshot that arrives late, so a thumbnail that sized itself by its image would move the rows below it.
      if (url.pathname === "/files")
        return Bun.sleep(400).then(
          () =>
            new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="1200"><rect width="390" height="1200" fill="#e4e4e7"/><rect x="24" y="24" width="342" height="64" fill="#a1a1aa"/></svg>',
              { headers: { "content-type": "image/svg+xml" } },
            ),
        );
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
const reconnect = async (page: Page, on: boolean) => {
  await page.evaluate((value) => (window as unknown as { reconnect: (on: boolean) => void }).reconnect(value), on);
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
    test(`the work line says in place that the turn reconnects, and nothing moves (${view.name}, ${theme})`, async () => {
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
        const boxes = (nodes: typeof before.nodes) => nodes.map(({ box }) => box);
        const expectCalmLine = (nodes: typeof before.nodes) => {
          expect(nodes[0]!.text.startsWith(label)).toBe(true);
          expect(nodes[0]!.busy).toBe(false);
          expect(nodes.filter(({ text }) => text.includes(label))).toHaveLength(1);
        };

        // A model call waits for its retry: the work line changes its label in place.
        await emit(page, { ...base, seq: 4, type: "provider_retry" });
        const retrying = await layout(page);
        expect(boxes(retrying.nodes)).toEqual(boxes(before.nodes));
        expectCalmLine(retrying.nodes);
        expect(retrying.overflowX).toBeLessThanOrEqual(0);

        // The newest text takes the status's place in the same element and nothing moves.
        await emit(page, { ...base, seq: 5, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Here is the summary." });
        const resumed = await layout(page);
        expect(boxes(resumed.nodes)).toEqual(boxes(before.nodes));
        expect(resumed.nodes.map(({ text }) => text).join(" ")).not.toContain(label);
        expect(resumed.nodes.at(-1)).toMatchObject({ text: "Here is the summary." });

        // The stream loses its connection and gets it back: the same line says so, and again nothing moves.
        await reconnect(page, true);
        const offline = await layout(page);
        expect(boxes(offline.nodes)).toEqual(boxes(resumed.nodes));
        expectCalmLine(offline.nodes);
        expect(offline.overflowX).toBeLessThanOrEqual(0);
        await reconnect(page, false);
        const online = await layout(page);
        expect(online.nodes).toEqual(resumed.nodes);
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

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a failed turn keeps its results in place and ends with its reason and Continue (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
        const de = theme === "dark";
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${de ? "de" : "en"}&theme=${theme}`);
        const card = { title: "Revenue Q1–Q3", value: "1.2 M", caption: "Gross, without refunds" };
        const read = { id: "tool-read", kind: "tool" as const, callId: "read", name: "read_file", args: { path: "/orders.csv" } };
        const shown = { id: "tool-card", kind: "tool" as const, callId: "card", name: "card", args: card };
        const stored = (seq: number, message: AiStoredMessage["message"], patch: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
          id: `m${seq}`,
          shortId: `m${seq}`,
          conversationId: "chat",
          seq,
          kind: "message",
          message,
          loopId: "turn",
          modelProfileId: null,
          providerModel: null,
          usage: null,
          stopReason: null,
          loopAggregate: null,
          loopDoneReason: null,
          compactedAt: null,
          meta: null,
          createdAt: "2026-10-07T09:56:00.000Z",
          ...patch,
        });
        const request = stored(10, { role: "user", content: [{ type: "text", text: "Build the revenue report" }] });
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        // The person's message is in the chat before the turn ends, as the controller keeps it.
        await emit(page, { ...base, seq: 2, type: "message_saved", message: request });
        await emit(page, { ...base, seq: 3, type: "block_set", block: { ...read, status: "completed", result: "id,total" } });
        await emit(page, { ...base, seq: 4, type: "block_set", block: { ...shown, status: "completed", result: { displayed: true } } });
        await emit(page, { ...base, seq: 5, type: "block_delta", blockId: "text-1", blockKind: "text", delta: "Now I build the report." });
        const box = (selector: string) =>
          page.evaluate((query) => {
            const content = document.querySelector(".k2b-chat-timeline__content")!.getBoundingClientRect();
            const node = document.querySelector(query);
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return [rect.left - content.left, rect.top - content.top, rect.width, rect.height].map(Math.round);
          }, selector);
        const workBefore = await box(".ai-turn-work");
        const resultBefore = await box(".ai-turn > :nth-child(2)");
        await emit(page, {
          ...base,
          seq: 6,
          type: "turn_finished",
          status: "failed",
          error: "The model service did not answer.",
          messages: [
            request,
            stored(11, {
              role: "assistant",
              content: [
                { type: "tool_call", id: "read", name: "read_file", args: read.args },
                { type: "tool_call", id: "card", name: "card", args: card },
              ],
            }),
            stored(12, { role: "tool_result", callId: "read", name: "read_file", result: "id,total", isError: false }),
            stored(13, { role: "tool_result", callId: "card", name: "card", result: { displayed: true }, isError: false }),
            stored(
              14,
              { role: "assistant", content: [{ type: "text", text: "Now I build the report." }] },
              { loopDoneReason: "error", meta: { turnError: { code: "model_unavailable" } }, createdAt: "2026-10-07T10:00:00.000Z" },
            ),
          ],
        });
        // The work line and the result stay where they were; the status folds away and the notice ends the turn.
        expect(await box(".ai-turn-work")).toEqual(workBefore);
        expect(await box(".ai-turn > :nth-child(2)")).toEqual(resultBefore);
        const notice = await box(".ai-turn__notice");
        expect(notice).not.toBeNull();
        expect(notice![1]!).toBeGreaterThanOrEqual(resultBefore![1]! + resultBefore![3]!);
        expect(notice![0]! + notice![2]!).toBeLessThanOrEqual(Math.ceil(view.width));
        const text = await page.locator(".ai-turn__notice").innerText();
        expect(text).toContain(de ? "Die Antwort wurde abgebrochen." : "The answer was interrupted.");
        expect(await page.locator(".ai-turn-work").innerText()).toContain(de ? "4 Min. gearbeitet" : "Worked 4 min");
        expect(await page.locator(".k2b-chat-timeline__content").innerText()).not.toContain("Now I build the report.");
        expect(
          await page.evaluate(() => {
            const viewport = document.querySelector(".k2b-chat-timeline__viewport")!;
            return viewport.scrollWidth - viewport.clientWidth;
          }),
        ).toBeLessThanOrEqual(0);

        await page.getByRole("button", { name: de ? "Weiterarbeiten" : "Continue" }).click();
        expect(await page.evaluate(() => (window as unknown as { continued: string[] }).continued)).toEqual([
          de ? "Mach an der Stelle weiter, an der du aufgehört hast." : "Continue where you left off.",
        ]);
      } finally {
        await context.close();
      }
    }, 30_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`an app check shows its outcome and the screenshot it looked at without moving the steps (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
        const de = theme === "dark";
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${de ? "de" : "en"}&theme=${theme}`);
        const check = { id: "tool-check", kind: "tool" as const, callId: "check", name: "code_check", args: { id: "budget" } };
        const issues = [
          { severity: "error", kind: "layout", message: "Row is misaligned" },
          { severity: "warning", kind: "layout", message: "Value is cut off" },
        ];
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, { ...base, seq: 2, type: "block_set", block: { ...check, status: "running" } });
        expect(await page.locator(".ai-turn-work summary").innerText()).toContain(de ? "Prüft die App" : "Checking the app");
        await page.locator(".ai-turn-work > summary").click();
        await frames(page);
        // Without its shimmer, a busy label keeps a visible text colour, in the work line and in the steps below it.
        const fills = await page.$$eval(".ai-turn-work strong", (labels) =>
          labels.map((label) => getComputedStyle(label).webkitTextFillColor),
        );
        expect(fills.length).toBeGreaterThanOrEqual(2);
        expect(fills).not.toContain("rgba(0, 0, 0, 0)");
        const before = await layout(page);

        // The outcome arrives in the step's own row: in words and with its own icon, and nothing moves.
        await emit(page, {
          ...base,
          seq: 3,
          type: "block_set",
          block: { ...check, status: "completed", result: { passed: false, issues } },
        });
        const checked = await layout(page);
        expect(checked.nodes.map(({ box }) => box)).toEqual(before.nodes.map(({ box }) => box));
        const row = page.locator(".ai-turn-steps .k2b-chat-activity").first();
        expect(await row.innerText()).toContain(de ? "App-Prüfung" : "App check");
        expect(await row.innerText()).toContain(de ? "1 Befund · 1 Warnung" : "1 finding · 1 warning");
        expect(await row.locator(".ti-alert-triangle").count()).toBe(1);
        expect(checked.overflowX).toBeLessThanOrEqual(0);

        // The screenshot step shows the image in a box that is fixed before the image arrives.
        const path = "/checks/3f9a/desktop.png";
        await emit(page, {
          ...base,
          seq: 4,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "Looking at the screenshot.",
        });
        await emit(page, {
          ...base,
          seq: 5,
          type: "block_set",
          block: {
            id: "tool-view",
            kind: "tool",
            callId: "view",
            name: "view_image",
            args: { path },
            status: "completed",
            result: { path, mediaType: "image/png", description: "A budget table whose totals row sits lower than its label." },
          },
        });
        await emit(page, { ...base, seq: 6, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "I fix the totals row." });
        const step = page.locator(".ai-turn-steps .k2b-chat-activity", { hasText: de ? "Bild ansehen" : "View image" });
        await step.locator("summary").click();
        const thumbnail = page.getByRole("button", { name: de ? "Bild desktop.png öffnen" : "Open image desktop.png" });
        await thumbnail.waitFor();
        const loading = await layout(page);
        const size = await thumbnail.boundingBox();
        await page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>(".ai-step-image img");
          return Boolean(image?.complete && image.naturalWidth > 0);
        });
        await frames(page);
        expect((await layout(page)).nodes).toEqual(loading.nodes);
        expect(await thumbnail.boundingBox()).toEqual(size);
        expect(size!.width).toBeLessThanOrEqual(192);
        expect(size!.height).toBeLessThanOrEqual(128);
        expect(await thumbnail.locator("img").getAttribute("alt")).toBe("A budget table whose totals row sits lower than its label.");
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

        await thumbnail.click();
        expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([path]);
      } finally {
        await context.close();
      }
    }, 30_000);
