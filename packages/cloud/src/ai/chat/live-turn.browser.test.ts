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
        const view = { id: "tool-view", kind: "tool" as const, callId: "view", name: "view_image", args: { path } };
        await emit(page, { ...base, seq: 5, type: "block_set", block: { ...view, status: "running" } });
        const label = de ? "Bild ansehen" : "View image";
        // While the turn runs, both steps share one group; the step is the innermost activity that names it.
        await page.locator(".ai-turn-steps .k2b-chat-activity").first().locator("summary").first().click();
        const step = page.locator(".ai-turn-steps .k2b-chat-activity", { hasText: label }).last();
        await step.locator("summary").click();
        await frames(page);
        // A reader who opened the step while it ran keeps the step and its input in place when the image arrives.
        const opened = async () => {
          const { nodes } = await layout(page);
          const index = nodes.findLastIndex((node) => node.text.includes(label));
          const region = await step.getByRole("region").evaluate((node) => {
            const content = document.querySelector(".k2b-chat-timeline__content")!.getBoundingClientRect();
            const box = node.getBoundingClientRect();
            return [box.left - content.left, box.top - content.top].map(Math.round);
          });
          return { above: nodes.slice(0, index + 1).map(({ box }) => box.slice(0, 2)), region };
        };
        const running = await opened();
        await emit(page, {
          ...base,
          seq: 6,
          type: "block_set",
          block: {
            ...view,
            status: "completed",
            result: { path, mediaType: "image/png", description: "A budget table whose totals row sits lower than its label." },
          },
        });
        expect(await opened()).toEqual(running);
        await emit(page, { ...base, seq: 7, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "I fix the totals row." });
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
        // The button is named for opening the image and described by what the step saw in it.
        expect(
          await thumbnail.evaluate((button) => document.getElementById(button.getAttribute("aria-describedby") ?? "")?.getAttribute("alt")),
        ).toBe("A budget table whose totals row sits lower than its label.");
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

        await thumbnail.click();
        expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([path]);
      } finally {
        await context.close();
      }
    }, 30_000);

const storedMessage = (
  seq: number,
  loopId: string,
  message: AiStoredMessage["message"],
  patch: Partial<AiStoredMessage> = {},
): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "chat",
  seq,
  kind: "message",
  message,
  loopId,
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

/** A box relative to the viewport, so anything that scrolls the conversation counts as movement. */
const viewportBox = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const node = document.querySelector(query);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return [box.left, box.top, box.width, box.height].map(Math.round);
  }, selector);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`the live work line opens on a press across a clock tick, Enter, and Space, and stays put and open (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        const de = theme === "dark";
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${de ? "de" : "en"}&theme=${theme}`);
        let seq = 1;
        await emit(page, { ...base, seq: seq++, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        // Earlier turns fill the conversation, so it scrolls and follows its end.
        for (let index = 0; index < 5; index++) {
          const user = storedMessage(100 + index * 2, `old-${index}`, {
            role: "user",
            content: [{ type: "text", text: `Question ${index}` }],
          });
          const answer = storedMessage(101 + index * 2, `old-${index}`, {
            role: "assistant",
            content: [{ type: "text", text: "A longer earlier answer that takes a few lines in the conversation. ".repeat(6) }],
          });
          await emit(page, { ...base, seq: seq++, type: "message_saved", message: user });
          await emit(page, { ...base, seq: seq++, type: "message_saved", message: answer });
        }
        const request = storedMessage(200, "turn", { role: "user", content: [{ type: "text", text: "Build the report" }] });
        await emit(page, { ...base, seq: seq++, type: "message_saved", message: request });
        await emit(page, {
          ...base,
          seq: seq++,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "I load the skill first.",
        });
        const step = (index: number, status: "running" | "completed") => ({
          id: `tool-${index}`,
          kind: "tool" as const,
          callId: `call-${index}`,
          name: index < 3 ? "load_skill" : index % 2 ? "read_file" : "code_run",
          args: { path: `/data/part-${index}.csv` },
          status,
          ...(status === "completed" ? { result: "ok" } : {}),
        });
        for (let index = 1; index <= 8; index++)
          await emit(page, { ...base, seq: seq++, type: "block_set", block: step(index, "completed") });
        await emit(page, {
          ...base,
          seq: seq++,
          type: "block_delta",
          blockId: "text-2",
          blockKind: "text",
          delta: "The data is clean. Now I compute.",
        });
        await emit(page, { ...base, seq: seq++, type: "block_set", block: step(9, "running") });

        const summary = ".ai-turn-work > summary";
        const isOpen = () =>
          page.$eval(".ai-turn-work", (node) => (node as HTMLDetailsElement).open && node.querySelector(".ai-turn-steps") !== null);
        const before = await viewportBox(page, summary);
        // A press on the ticking clock that spans a tick still opens the line.
        // The clock re-renders every second, so its box is read in one go inside the page.
        const meta = await page.evaluate(() => {
          const box = document.querySelector(".ai-turn-work .ai-turn-work__meta")!.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        await page.mouse.move(meta.x, meta.y);
        await page.mouse.down();
        await page.waitForTimeout(1100);
        await page.mouse.up();
        await frames(page);
        await frames(page);
        expect(await isOpen()).toBe(true);
        expect(await viewportBox(page, summary)).toEqual(before);
        // One indent below the work line: no second summary, and steps sit at the same left edge as the texts.
        expect(await page.locator(".ai-turn-steps .ai-turn-steps").count()).toBe(0);

        // New steps, a new status, and a waiting approval stream in: the line stays open and where it was.
        await emit(page, { ...base, seq: seq++, type: "block_set", block: step(9, "completed") });
        await emit(page, { ...base, seq: seq++, type: "block_delta", blockId: "think-1", blockKind: "thinking", delta: "Checking totals" });
        await emit(page, {
          ...base,
          seq: seq++,
          type: "block_delta",
          blockId: "text-3",
          blockKind: "text",
          delta: "Totals match. I send the report.",
        });
        await emit(page, {
          ...base,
          seq: seq++,
          type: "block_set",
          block: {
            ...step(10, "running"),
            name: "code_run",
            status: "awaiting_approval",
            approval: { message: "Run", allowAlways: false },
          },
        });
        await frames(page);
        expect(await isOpen()).toBe(true);
        expect(await viewportBox(page, summary)).toEqual(before);
        expect(await page.locator(".ai-turn-work > summary").innerText()).toContain(
          de ? "Wartet auf deine Freigabe" : "Waiting for your approval",
        );

        // The keyboard toggles it in every state.
        await page.locator(summary).focus();
        for (const key of ["Enter", "Enter", " ", " "]) {
          const open = await isOpen();
          await page.keyboard.press(key);
          await frames(page);
          expect(await isOpen()).toBe(!open);
          expect(await viewportBox(page, summary)).toEqual(before);
        }
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    }, 60_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a pending approval is a calm card that becomes its receipt in place, also when the turn ends (${view.name}, ${theme})`, async () => {
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
        const presentation = {
          kind: "capability" as const,
          appId: "mail",
          appName: "Mail",
          appIcon: "ti ti-mail",
          title: de ? "E-Mail senden" : "Send email",
          capabilityKind: "action" as const,
        };
        const args = { draftId: "draft-118" };
        const send = { id: "tool-send", kind: "tool" as const, callId: "send", name: "mail__action__send", args, presentation };
        const read = { id: "tool-read", kind: "tool" as const, callId: "read", name: "read_file", args: { path: "/offer.pdf" } };
        const request = storedMessage(10, "turn", { role: "user", content: [{ type: "text", text: "Send the offer to Jana Berger" }] });
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, { ...base, seq: 2, type: "message_saved", message: request });
        await emit(page, { ...base, seq: 3, type: "block_set", block: { ...read, status: "completed", result: "pdf" } });
        await emit(page, {
          ...base,
          seq: 4,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "The offer is ready. I need your approval to send it.",
        });
        await emit(page, {
          ...base,
          seq: 5,
          type: "block_set",
          block: {
            ...send,
            status: "awaiting_approval",
            approval: {
              allowAlways: false,
              review: {
                message: "Send the offer to Jana Berger.",
                details: [
                  { label: de ? "An" : "To", value: "Jana Berger <jana.berger@example.com>" },
                  { label: de ? "Betreff" : "Subject", value: "Your offer for the website relaunch" },
                  {
                    label: de ? "Text" : "Body",
                    value: "Dear Ms Berger,\n\nthank you for the good conversation on Monday.",
                    display: "block",
                  },
                ],
              },
            },
          },
        });
        const card = ".ai-turn__action .ai-approval";
        const cardBox = (await viewportBox(page, card))!;
        const workBox = await viewportBox(page, ".ai-turn-work");
        const textBox = await viewportBox(page, ".ai-turn__text");
        expect(await page.locator(card).innerText()).toContain(
          de ? "Wird erst nach deiner Freigabe ausgeführt" : "Runs only after you approve it",
        );
        // No heavy border: the tint alone sets the card apart.
        expect(await page.$eval(card, (node) => getComputedStyle(node).borderTopColor)).toBe("rgba(0, 0, 0, 0)");
        const [term, value] = await page.$$eval(`${card} dl > *`, (nodes) =>
          nodes.slice(0, 2).map((node) => {
            const box = node.getBoundingClientRect();
            return [Math.round(box.left), Math.round(box.top)];
          }),
        );
        const reject = (await page.getByRole("button", { name: de ? "Ablehnen" : "Reject", exact: true }).boundingBox())!;
        const approve = page.locator(`${card} .k2b-split-button`);
        const approveBox = (await approve.boundingBox())!;
        if (view.touch) {
          // Phones stack each field under its label, and the decision buttons share the width.
          expect(value![0]).toBe(term![0]);
          expect(value![1]).toBeGreaterThan(term![1]!);
          const actions = (await page.locator(`${card} .ai-approval__actions`).boundingBox())!;
          expect(reject.y).toBe(approveBox.y);
          expect(reject.width).toBeGreaterThan(actions.width * 0.35);
          expect(approveBox.width).toBeGreaterThan(actions.width * 0.35);
          expect(reject.width + approveBox.width).toBeGreaterThan(actions.width - 12);
        } else {
          expect(value![0]).toBeGreaterThan(term![0]!);
          expect(value![1]).toBe(term![1]);
        }
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

        // Approving turns the card into a one-line receipt at its place, with focus on it; nothing above moves.
        await page.locator(`${card} .k2b-split-button__primary`).click();
        await frames(page);
        expect(await page.evaluate(() => (window as unknown as { approvals: unknown[] }).approvals)).toEqual([
          { callId: "send", approved: true },
        ]);
        expect(await page.locator(card).count()).toBe(0);
        const receipt = ".ai-turn__action .ai-turn-receipt";
        const receiptBox = (await viewportBox(page, receipt))!;
        expect(receiptBox[1]).toBe(cardBox[1]);
        expect(receiptBox[3]).toBeLessThanOrEqual(32);
        expect(await viewportBox(page, ".ai-turn-work")).toEqual(workBox);
        expect(await viewportBox(page, ".ai-turn__text")).toEqual(textBox);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("ai-turn__action"))).toBe(true);
        expect(await page.locator(receipt).innerText()).toBe(de ? "Wird ausgeführt: E-Mail senden" : "Running: Send email");

        // The turn reports the decision and the outcome: only the receipt's words change.
        const sent = de ? "E-Mail an Jana Berger gesendet" : "Email to Jana Berger sent";
        await emit(page, { ...base, seq: 6, type: "block_set", block: { ...send, status: "running", approved: true } });
        await emit(page, {
          ...base,
          seq: 7,
          type: "block_set",
          block: { ...send, status: "completed", approved: true, result: { summary: sent } },
        });
        expect(await page.locator(receipt).innerText()).toBe(sent);
        expect(await viewportBox(page, receipt)).toEqual(receiptBox);
        await emit(page, {
          ...base,
          seq: 8,
          type: "block_delta",
          blockId: "text-2",
          blockKind: "text",
          delta: "Done. Jana Berger has the offer.",
        });
        const settled = {
          work: await viewportBox(page, ".ai-turn-work"),
          receipt: await viewportBox(page, receipt),
          text: await viewportBox(page, ".ai-turn__text"),
        };

        // The turn ends: its history puts every place where the live turn had it.
        await emit(page, {
          ...base,
          seq: 9,
          type: "turn_finished",
          status: "completed",
          error: null,
          messages: [
            request,
            storedMessage(
              11,
              "turn",
              {
                role: "assistant",
                content: [
                  { type: "text", text: "The offer is ready. I need your approval to send it." },
                  { type: "tool_call", id: "read", name: "read_file", args: read.args },
                  { type: "tool_call", id: "send", name: "mail__action__send", args },
                ],
              },
              { meta: { toolPresentations: { send: presentation } } },
            ),
            storedMessage(12, "turn", { role: "tool_result", callId: "read", name: "read_file", result: "pdf", isError: false }),
            storedMessage(
              13,
              "turn",
              { role: "tool_result", callId: "send", name: "mail__action__send", result: { summary: sent }, isError: false },
              { meta: { toolOutcomes: { send: "approved" } } },
            ),
            storedMessage(
              14,
              "turn",
              { role: "assistant", content: [{ type: "text", text: "Done. Jana Berger has the offer." }] },
              { loopDoneReason: "stop", createdAt: "2026-10-07T10:00:00.000Z" },
            ),
          ],
        });
        await frames(page);
        expect(await page.locator(receipt).innerText()).toBe(sent);
        expect(await viewportBox(page, ".ai-turn-work")).toEqual(settled.work);
        expect(await viewportBox(page, ".ai-turn__text")).toEqual(settled.text);
        expect(await viewportBox(page, receipt)).toEqual(settled.receipt);
      } finally {
        await context.close();
      }
    }, 60_000);

for (const width of [390, 320])
  test(`a long action title shortens the approve button on a phone instead of pushing it out of the card (${width} px)`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/?lang=de&theme=light`);
      const title = "Lokale Anwendungseinstellungen aktualisieren";
      await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
      await emit(page, {
        ...base,
        seq: 2,
        type: "block_set",
        block: {
          id: "tool-settings",
          kind: "tool",
          callId: "settings",
          name: "settings__action__update",
          args: {},
          status: "awaiting_approval",
          presentation: {
            kind: "capability",
            appId: "settings",
            appName: "Einstellungen",
            appIcon: "ti ti-settings",
            title,
            capabilityKind: "action",
          },
          approval: { allowAlways: false, message: "Einstellungen: " + title },
        },
      });
      const card = ".ai-turn__action .ai-approval";
      const boxes = await page.evaluate((query) => {
        const box = (selector: string) => document.querySelector(`${query} ${selector}`)!.getBoundingClientRect();
        const label = document.querySelector<HTMLElement>(`${query} .k2b-split-button__primary .k2b-button__label`)!;
        return {
          card: box("").right,
          menu: box(".k2b-split-button__menu-trigger").right,
          reject: box(".ai-approval__actions > .k2b-button").left,
          truncated: label.scrollWidth > label.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, card);
      expect(boxes.menu).toBeLessThanOrEqual(boxes.card);
      expect(boxes.reject).toBeGreaterThanOrEqual(0);
      expect(boxes.truncated).toBe(true);
      expect(boxes.document).toBeLessThanOrEqual(0);
      expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);
      // The title reads in full above, and the button keeps it as its name.
      expect(await page.locator(`${card} .ai-approval__title`).innerText()).toContain(title);
      expect(await page.getByRole("button", { name: title, exact: true }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 30_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "small phone", width: 320, height: 640, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a chart takes its full size when its call is known and keeps it while the turn ends (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
        const german = theme === "dark";
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${german ? "de" : "en"}&theme=${theme}`);
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, {
          ...base,
          seq: 2,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "I am charting the orders.",
        });
        const chart = {
          id: "tool-chart",
          kind: "tool" as const,
          callId: "chart",
          name: "chart",
          status: "running" as const,
        };
        // The model still writes the arguments: no frame yet, so no empty frame can change its size later.
        await emit(page, { ...base, seq: 3, type: "block_set", block: chart });
        expect(await page.locator(".k2b-chart-explorer").count()).toBe(0);

        const args = {
          kind: "bar",
          title: "Orders per region",
          subtitle: "Q3 2026",
          data: [
            { label: "North", value: 1_250_000 },
            { label: "South", value: 980_000.5 },
            { label: "East", value: 410_250 },
            { label: "West", value: 720_000 },
          ],
        };
        await emit(page, { ...base, seq: 4, type: "block_set", block: { ...chart, args } });
        const section = page.locator(".k2b-chart-explorer");
        const viewport = page.locator(".k2b-chart-explorer__viewport");
        const shown = { section: await section.boundingBox(), viewport: await viewport.boundingBox() };
        expect(shown.viewport!.height).toBe(288);

        await emit(page, {
          ...base,
          seq: 5,
          type: "block_set",
          block: { ...chart, args, status: "completed", result: { displayed: true } },
        });
        await emit(page, {
          ...base,
          seq: 6,
          type: "block_delta",
          blockId: "text-2",
          blockKind: "text",
          delta: "North leads with 1.25 million orders.",
        });
        expect({ section: await section.boundingBox(), viewport: await viewport.boundingBox() }).toEqual(shown);
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

        // The section is named by its title, and the chart can be explored by keyboard.
        expect(await page.getByRole("region", { name: "Orders per region" }).count()).toBe(1);
        expect(await page.locator(".k2b-chart[tabindex='0']").count()).toBe(1);
        expect(await page.getByRole("button", { name: german ? "Daten kopieren" : "Copy data" }).count()).toBe(1);
        // Tick labels stay inside the chart, also for long values on a phone.
        const ticks = await page.evaluate(() => {
          const frame = document.querySelector(".k2b-chart__svg")!.getBoundingClientRect();
          return Array.from(document.querySelectorAll(".k2b-chart__svg .stdlib-chart-tick-label")).map((label) => {
            const box = label.getBoundingClientRect();
            return { left: box.left - frame.left, right: frame.right - box.right };
          });
        });
        expect(ticks.length).toBeGreaterThan(0);
        for (const tick of ticks) {
          expect(tick.left).toBeGreaterThanOrEqual(-1);
          expect(tick.right).toBeGreaterThanOrEqual(-1);
        }

        // The data table replaces the chart in the same height.
        await page.getByRole("button", { name: german ? "Diagrammansicht" : "Chart view" }).click();
        await page.getByRole("menuitemradio", { name: german ? "Tabelle" : "Table" }).click();
        await frames(page);
        expect(await page.locator(".k2b-chart-explorer__viewport table").count()).toBe(1);
        const table = await page.locator(".k2b-chart-explorer__viewport").innerText();
        for (const label of ["North", "South", "East", "West", german ? "1.250.000" : "1,250,000"]) expect(table).toContain(label);
        expect({ section: await section.boundingBox(), viewport: await viewport.boundingBox() }).toEqual(shown);
      } finally {
        await context.close();
      }
    }, 30_000);
