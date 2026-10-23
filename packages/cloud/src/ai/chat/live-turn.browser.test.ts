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
    // MapView's lazy worker uses import.meta; keep the shared chat harness a module.
    format: "esm",
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
/**
 * Waits until no transition runs in a subtree. Reduced motion shortens every transition to 0.01 ms rather than removing
 * it, so a typography switch still runs as one, and WebKit can hold its start or a mixed value for more than two frames.
 */
const settled = (page: Page, selector: string) =>
  page.waitForFunction(
    (query) =>
      document
        .querySelector(query)!
        .getAnimations({ subtree: true })
        .filter((animation) => animation.timeline === document.timeline)
        .every((animation) => animation.playState !== "running"),
    selector,
  );
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
  for (const { theme, failureCode } of [
    { theme: "light", failureCode: "model_unavailable" },
    { theme: "dark", failureCode: "model_unavailable" },
    { theme: "light", failureCode: "tool_failed" },
    { theme: "dark", failureCode: "tool_failed" },
  ] as const)
    test(`a failed turn keeps its results in place and ends with its reason and Continue (${failureCode}, ${view.name}, ${theme})`, async () => {
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
        const failedStep = failureCode === "tool_failed";
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
        await emit(page, {
          ...base,
          seq: 3,
          type: "block_set",
          block: {
            ...read,
            status: failedStep ? "failed" : "completed",
            result: failedStep ? "Read failed" : "id,total",
            isError: failedStep,
          },
        });
        await emit(page, { ...base, seq: 4, type: "block_set", block: { ...shown, status: "completed", result: { displayed: true } } });
        await emit(page, {
          ...base,
          seq: 5,
          type: "block_delta",
          blockId: "text-1",
          blockKind: "text",
          delta: "Now I build the report.",
        });
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
          error: failedStep ? "A step failed, and the model stopped without an answer." : "The model service did not answer.",
          messages: [
            request,
            stored(11, {
              role: "assistant",
              content: [
                ...(failedStep ? [{ type: "text" as const, text: "Now I build the report." }] : []),
                { type: "tool_call", id: "read", name: "read_file", args: read.args },
                { type: "tool_call", id: "card", name: "card", args: card },
              ],
            }),
            stored(12, {
              role: "tool_result",
              callId: "read",
              name: "read_file",
              result: failedStep ? "Read failed" : "id,total",
              isError: failedStep,
            }),
            stored(13, { role: "tool_result", callId: "card", name: "card", result: { displayed: true }, isError: false }),
            stored(
              14,
              { role: "assistant", content: failedStep ? [] : [{ type: "text", text: "Now I build the report." }] },
              { loopDoneReason: "error", meta: { turnError: { code: failureCode } }, createdAt: "2026-10-07T10:00:00.000Z" },
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
        expect(text).toContain(
          failedStep
            ? de
              ? "Ein Schritt ist fehlgeschlagen, und das Modell hat danach nicht geantwortet."
              : "A step failed, and the model stopped without an answer."
            : de
              ? "Der KI-Dienst hat nicht geantwortet."
              : "The model service did not answer.",
        );
        expect(
          await page.evaluate(() => document.querySelector(".ai-turn")?.lastElementChild === document.querySelector(".ai-turn__notice")),
        ).toBe(true);
        expect(await page.getByRole("button", { name: de ? "Weiterarbeiten" : "Continue", exact: true }).isVisible()).toBe(true);
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
    test(`a pending question collapses to its outcome line in place, also when the turn ends (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
        timezoneId: "Europe/Berlin",
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
        const card = ".ai-turn__action .k2b-chat-decision__card";
        await settled(page, ".ai-turn");
        const cardBox = (await viewportBox(page, card))!;
        const workBox = await viewportBox(page, ".ai-turn-work");
        const textBox = await viewportBox(page, ".ai-turn__text");
        // Card v4: the old message is the question, Cloud says why, and there is no box around it.
        expect(await page.locator(`${card} .k2b-chat-decision__sentence`).innerText()).toBe("Send the offer to Jana Berger.");
        expect(await page.locator(`${card} .k2b-chat-decision__reason`).innerText()).toBe(
          de ? "Ich frage, weil Mail hier jedes Mal fragt." : "I'm asking because Mail always asks for this.",
        );
        expect(await page.$eval(card, (node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        expect(await page.$eval(card, (node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
        const approve = page.locator(`${card} .k2b-chat-decision__answer`).first();
        const decline = page.locator(`${card} .k2b-chat-decision__answer`).nth(1);
        const approveBox = (await approve.boundingBox())!;
        const declineBox = (await decline.boundingBox())!;
        expect(await approve.innerText()).toBe(de ? "E-Mail senden" : "Send email");
        expect(approveBox.height).toBeGreaterThanOrEqual(44);
        expect(declineBox.y).toBe(approveBox.y);
        if (view.touch) {
          // Phones let the two answers share the row.
          const answers = (await page.locator(`${card} .k2b-chat-decision__answers`).boundingBox())!;
          expect(approveBox.width + declineBox.width).toBeGreaterThan(answers.width - 12);
        }
        expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

        // Approving collapses the card at once to its outcome line in its place, with focus on it; nothing above moves.
        await approve.click();
        await settled(page, ".ai-turn");
        expect(await page.evaluate(() => (window as unknown as { approvals: unknown[] }).approvals)).toEqual([
          { callId: "send", approved: true },
        ]);
        expect(await page.locator(card).count()).toBe(0);
        const receipt = ".ai-turn__action .k2b-chat-outcome";
        const current = `${receipt} .k2b-chat-outcome__text[data-current="true"]`;
        const receiptBox = (await viewportBox(page, receipt))!;
        expect(receiptBox[1]).toBe(cardBox[1]);
        expect(receiptBox[3]).toBeLessThanOrEqual(48);
        expect(await viewportBox(page, ".ai-turn-work")).toEqual(workBox);
        expect(await viewportBox(page, ".ai-turn__text")).toEqual(textBox);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-chat-outcome"))).toBe(true);
        expect(await page.locator(current).innerText()).toBe(de ? "Wird ausgeführt: E-Mail senden" : "Running: Send email");

        // The turn reports the decision and the outcome: only the line's words change, by 0 px.
        const at = "2026-10-07T10:23:45.000Z";
        const sent = de ? "E-Mail an Jana Berger gesendet" : "Email to Jana Berger sent";
        await emit(page, { ...base, seq: 6, type: "block_set", block: { ...send, status: "running", approved: true } });
        expect(await page.locator(current).innerText()).toBe(de ? "Wird ausgeführt: E-Mail senden" : "Running: Send email");
        expect(await viewportBox(page, receipt)).toEqual(receiptBox);
        await emit(page, {
          ...base,
          seq: 7,
          type: "block_set",
          block: { ...send, status: "completed", approved: true, result: { summary: sent }, at },
        });
        expect(await page.locator(current).innerText()).toBe(`${sent}12:23`);
        expect(await viewportBox(page, receipt)).toEqual(receiptBox);
        await emit(page, {
          ...base,
          seq: 8,
          type: "block_delta",
          blockId: "text-2",
          blockKind: "text",
          delta: "Done. Jana Berger has the offer.",
        });
        const settledBoxes = {
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
              { meta: { toolOutcomes: { send: "approved" } }, createdAt: at },
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
        expect(await page.locator(current).innerText()).toBe(`${sent}12:23`);
        expect(await viewportBox(page, ".ai-turn-work")).toEqual(settledBoxes.work);
        expect(await viewportBox(page, ".ai-turn__text")).toEqual(settledBoxes.text);
        expect(await viewportBox(page, receipt)).toEqual(settledBoxes.receipt);
      } finally {
        await context.close();
      }
    }, 60_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  test(`a live text turns quiet in place when a step starts after it, and nothing moves (${view.name})`, async () => {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      isMobile: view.touch,
      hasTouch: view.touch,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
      await page.goto(`http://127.0.0.1:${server.port}/?lang=en&theme=light`);
      const presentation = {
        kind: "capability" as const,
        appId: "mail",
        appName: "Mail",
        appIcon: "ti ti-mail",
        title: "Send email",
        capabilityKind: "action" as const,
      };
      const send = { id: "tool-send", kind: "tool" as const, callId: "send", name: "mail__action__send", args: {}, presentation };
      const write = { id: "tool-write", kind: "tool" as const, callId: "write", name: "write_file", args: { path: "/app.js" } };
      const status = "Good news: the chart API also returns the totals per month. Now I write the app files for the dashboard.";
      const place = ".ai-turn__text";
      const receipt = ".ai-turn__action .k2b-chat-outcome";
      const style = async (selector: string) => {
        await settled(page, selector);
        return page.$eval(`${selector} .assistant-markdown-block`, (node) => {
          const computed = getComputedStyle(node);
          return { color: computed.color, fontSize: computed.fontSize, lineHeight: computed.lineHeight };
        });
      };
      await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
      await emit(page, {
        ...base,
        seq: 2,
        type: "block_delta",
        blockId: "text-1",
        blockKind: "text",
        delta: "I check the chart API first.",
      });
      await emit(page, {
        ...base,
        seq: 3,
        type: "block_set",
        block: { ...send, status: "completed", approved: true, result: { summary: "Email to Jana Berger sent" } },
      });
      await emit(page, { ...base, seq: 4, type: "block_delta", blockId: "text-2", blockKind: "text", delta: status });

      // Trailing, the text may be the answer: answer typography, above the receipt in place 4.
      const answerStyle = await style(place);
      expect(await page.locator(place).innerText()).toBe(status);
      expect(answerStyle.fontSize).toBe("14px");
      const before = {
        work: await viewportBox(page, ".ai-turn-work"),
        text: await viewportBox(page, place),
        receipt: await viewportBox(page, receipt),
      };

      // A step starts after it: the same element reads as a status, together with the work line's new step, and keeps its
      // place, so the receipt below does not move.
      await emit(page, { ...base, seq: 5, type: "block_set", block: { ...write, status: "running" } });
      expect(await page.locator(".ai-turn-work > summary").innerText()).toContain("app.js");
      expect(await page.locator(place).innerText()).toBe(status);
      expect(await page.locator(`${place}.ai-turn__text--status`).count()).toBe(1);
      const statusStyle = await style(place);
      expect(statusStyle.fontSize).toBe("12px");
      expect(statusStyle.color).not.toBe(answerStyle.color);
      expect(await viewportBox(page, ".ai-turn-work")).toEqual(before.work);
      expect(await viewportBox(page, place)).toEqual(before.text);
      expect(await viewportBox(page, receipt)).toEqual(before.receipt);
      expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);

      // It looks like the intermediate texts in the expanded work, but keeps the answer's line height, so a status and the
      // text that replaces it line up instead of jumping by a few pixels at every switch.
      await page.locator(".ai-turn-work > summary").click();
      await page.locator(".ai-turn-steps__text").first().waitFor();
      const stepStyle = await style(".ai-turn-steps__text");
      expect([stepStyle.color, stepStyle.fontSize]).toEqual([statusStyle.color, statusStyle.fontSize]);
      // 12 px at line height 1.55; WebKit reports it as 18.599998px.
      expect(Number.parseFloat(stepStyle.lineHeight)).toBeCloseTo(18.6, 2);
      expect(statusStyle.lineHeight).toBe(answerStyle.lineHeight);
    } finally {
      await context.close();
    }
  }, 30_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  test(`a status that first shows quietly after a reload keeps its height as the answer, so the turn's end moves nothing (${view.name})`, async () => {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      isMobile: view.touch,
      hasTouch: view.touch,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
      await page.goto(`http://127.0.0.1:${server.port}/?lang=en&theme=light`);
      const presentation = {
        kind: "capability" as const,
        appId: "mail",
        appName: "Mail",
        appIcon: "ti ti-mail",
        title: "Send email",
        capabilityKind: "action" as const,
      };
      const read = { id: "tool-read", kind: "tool" as const, callId: "read", name: "read_file", args: { path: "/chart.json" } };
      const send = { id: "tool-send", kind: "tool" as const, callId: "send", name: "mail__action__send", args: {}, presentation };
      const text = [
        "## Monthly totals",
        "The chart API returns the totals per month, so the dashboard needs no second request for the summary row.",
        "- January and February are complete.\n- March still misses the last week.",
        "I send the summary to Jana Berger now, so she has it before the planning meeting.",
      ].join("\n\n");
      const sent = "Email to Jana Berger sent";
      const place = ".ai-turn__text";
      const receipt = ".ai-turn__action .k2b-chat-outcome";
      // The chat opens while the action after the text runs: the text never showed as the answer before it is quiet.
      await emit(page, {
        ...base,
        seq: 1,
        type: "turn_started",
        modelProfileId: "m",
        providerModel: "m",
        blocks: [
          { ...read, status: "completed", result: "{}" },
          { id: "text-1", kind: "text", text },
          { ...send, status: "running", approved: true },
        ],
      });
      const request = storedMessage(10, "turn", { role: "user", content: [{ type: "text", text: "Summarize the chart for Jana" }] });
      await emit(page, { ...base, seq: 2, type: "message_saved", message: request });
      expect(await page.locator(`${place}.ai-turn__text--status`).count()).toBe(1);
      await settled(page, place);
      const before = { text: await viewportBox(page, place), receipt: await viewportBox(page, receipt) };

      // The turn ends without another text: the status becomes the final message in answer typography within the height
      // its place already kept, so the receipt below stays where it is.
      await emit(page, {
        ...base,
        seq: 3,
        type: "block_set",
        block: { ...send, status: "completed", approved: true, result: { summary: sent } },
      });
      expect(await viewportBox(page, receipt)).toEqual(before.receipt);
      await emit(page, {
        ...base,
        seq: 4,
        type: "turn_finished",
        status: "completed",
        error: null,
        messages: [
          request,
          storedMessage(11, "turn", {
            role: "assistant",
            content: [{ type: "tool_call", id: "read", name: "read_file", args: read.args }],
          }),
          storedMessage(12, "turn", { role: "tool_result", callId: "read", name: "read_file", result: "{}", isError: false }),
          storedMessage(
            13,
            "turn",
            {
              role: "assistant",
              content: [
                { type: "text", text },
                { type: "tool_call", id: "send", name: "mail__action__send", args: {} },
              ],
            },
            { meta: { toolPresentations: { send: presentation } } },
          ),
          storedMessage(
            14,
            "turn",
            { role: "tool_result", callId: "send", name: "mail__action__send", result: { summary: sent }, isError: false },
            { meta: { toolOutcomes: { send: "approved" } }, loopDoneReason: "stop", createdAt: "2026-10-07T10:00:00.000Z" },
          ),
        ],
      });
      expect(await page.locator(`${place}.ai-turn__text--status`).count()).toBe(0);
      await settled(page, place);
      expect(await page.$eval(`${place} .assistant-markdown-block`, (node) => getComputedStyle(node).fontSize)).toBe("14px");
      expect(await page.locator(`${receipt} .k2b-chat-outcome__text[data-current="true"]`).innerText()).toBe(`${sent}10:00`);
      expect(await viewportBox(page, place)).toEqual(before.text);
      expect(await viewportBox(page, receipt)).toEqual(before.receipt);
    } finally {
      await context.close();
    }
  }, 30_000);

test("a streaming answer without steps reserves no height, so it reflows live when its Markdown settles", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?lang=en&theme=light`);
    await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
    const words = "The quarterly numbers grew in every region, and the strongest month was March.".split(" ");
    for (const [index, word] of words.entries()) {
      await emit(page, {
        ...base,
        seq: index + 2,
        type: "block_delta",
        blockId: "text-1",
        blockKind: "text",
        delta: `${index ? " " : ""}${word}`,
      });
      expect(await page.locator(".ai-turn__text").evaluate((node: HTMLElement) => node.style.minHeight)).toBe("");
    }
  } finally {
    await context.close();
  }
}, 30_000);

for (const width of [390, 320])
  test(`a long action title wraps inside its answer on a phone instead of pushing it out of the card (${width} px)`, async () => {
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
      const card = ".ai-turn__action .k2b-chat-decision__card";
      await settled(page, ".ai-turn");
      const boxes = await page.evaluate((query) => {
        const box = (selector: string) => document.querySelector(`${query} ${selector}`)!.getBoundingClientRect();
        const answers = Array.from(document.querySelectorAll(`${query} .k2b-chat-decision__answer`)).map((node) =>
          node.getBoundingClientRect(),
        );
        return {
          card: box("").right,
          answers: answers.map((answer) => ({ left: answer.left, right: answer.right })),
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, card);
      // A long answer wraps inside its button instead of leaving the card.
      for (const answer of boxes.answers) {
        expect(answer.left).toBeGreaterThanOrEqual(0);
        expect(answer.right).toBeLessThanOrEqual(boxes.card + 0.5);
      }
      expect(boxes.document).toBeLessThanOrEqual(0);
      expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);
      // The sentence reads the title in full, and the answer names it.
      expect(await page.locator(`${card} .k2b-chat-decision__sentence`).innerText()).toContain(title);
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

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  test(`a code run's website question offers the chat, and its receipts show each full URL with one-click revoke (${view.name})`, async () => {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      isMobile: view.touch,
      hasTouch: view.touch,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
      await page.goto(`http://127.0.0.1:${server.port}/?lang=en&theme=light`);
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=5m&includePrePost=false";
      const run = { id: "tool-run", kind: "tool" as const, callId: "run-approval-0", name: "code_run", args: { code: "…" } };
      await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
      await emit(page, {
        ...base,
        seq: 2,
        type: "block_set",
        block: {
          ...run,
          status: "awaiting_approval",
          approval: {
            message: `External HTTP request: GET ${url}`,
            allowAlways: false,
            allowChat: true,
            website: "https://query1.finance.yahoo.com",
          },
        },
      });
      const card = ".ai-turn__action .k2b-chat-decision__card";
      expect(await page.locator(card).innerText()).toContain(url);
      // The quiet third answer remembers this website for the chat; Always is no longer offered.
      expect(await page.locator(card).innerText()).not.toContain("Always approve");
      await page.getByRole("button", { name: "Yes, and allow this website in this chat", exact: true }).click();
      await frames(page);
      expect(await page.evaluate(() => (window as unknown as { approvals: unknown[] }).approvals)).toEqual([
        { callId: "run-approval-0", approved: true, remember: "chat" },
      ]);

      // The run finishes with a request the approval let through: the work line holds its receipt.
      await emit(page, {
        ...base,
        seq: 3,
        type: "block_set",
        block: {
          ...run,
          callId: "run",
          status: "completed",
          approved: true,
          result: { status: "ok" },
          receipts: [{ method: "GET", url }],
        },
      });
      const work = page.locator(".ai-turn-work > summary");
      if ((await work.count()) > 0 && !(await page.$eval(".ai-turn-work", (node) => (node as HTMLDetailsElement).open)))
        await work.first().click();
      await page.getByText(url).waitFor();
      const revoke = page.getByRole("button", { name: "Revoke the approval for query1.finance.yahoo.com", exact: true });
      const before = (await revoke.boundingBox())!;
      await revoke.click();
      await frames(page);
      expect(await page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)).toEqual(["https://query1.finance.yahoo.com"]);
      // Revoking keeps the button in place, disabled, so the row does not move.
      const after = (await revoke.boundingBox())!;
      expect([after.x, after.y]).toEqual([before.x, before.y]);
      expect(await revoke.isDisabled()).toBe(true);
      expect((await layout(page)).overflowX).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `/tmp/ai-website-receipt-${view.name}.png` });
    } finally {
      await context.close();
    }
  }, 60_000);

for (const view of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`the expanded work sits flush with the work line and folds one file read in parts into one row (${view.name}, ${theme})`, async () => {
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
        // A Project file path, long enough that a phone cuts it short.
        const path = "/project/reports/2026/quarterly-products-export-final.csv";
        const calls = [
          { callId: "tools", name: "load_tools", args: { names: ["files"] }, result: { loaded: ["files"] } },
          { callId: "skill", name: "load_skill", args: { name: "reports" }, result: { loaded: true } },
          ...[0, 16_384, 32_768].map((offset, part) => ({
            callId: `read-${part}`,
            name: "read_file",
            args: { path, offset, length: 16_384 },
            result: { content: "id,name", nextOffset: offset + 16_384 },
          })),
          { callId: "search", name: "web_search", args: { query: "product price index" }, result: { results: [] } },
          { callId: "write", name: "write_file", args: { path: "/report.md", content: "# Report" }, result: { path: "/report.md" } },
        ];
        const request = storedMessage(10, "turn", { role: "user", content: [{ type: "text", text: "Summarize the products" }] });
        await emit(page, { ...base, seq: 1, type: "turn_started", modelProfileId: "m", providerModel: "m", blocks: [] });
        await emit(page, { ...base, seq: 2, type: "message_saved", message: request });
        let seq = 3;
        for (const [index, call] of calls.entries()) {
          if (index === 2)
            await emit(page, {
              ...base,
              seq: seq++,
              type: "block_delta",
              blockId: "text-1",
              blockKind: "text",
              delta: "I read the file in parts.",
            });
          await emit(page, {
            ...base,
            seq: seq++,
            type: "block_set",
            block: {
              id: `tool-${call.callId}`,
              kind: "tool",
              callId: call.callId,
              name: call.name,
              args: call.args,
              status: "completed",
              result: call.result,
            },
          });
        }
        await emit(page, { ...base, seq: seq++, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Here is the report." });

        /** Left edges of the work line and of every row and paragraph it shows when open, relative to the timeline content. */
        const rows = () =>
          page.evaluate(() => {
            const content = document.querySelector(".k2b-chat-timeline__content")!.getBoundingClientRect();
            const viewport = document.querySelector(".k2b-chat-timeline__viewport")!;
            const left = (node: Element) => Math.round(node.getBoundingClientRect().left - content.left);
            const work = document.querySelector(".ai-turn-work")!;
            return {
              overflowX: viewport.scrollWidth - viewport.clientWidth,
              line: left(work.querySelector(":scope > summary .k2b-chat-activity__leading")!),
              rows: Array.from(work.querySelectorAll(".ai-turn-steps > :is(details, div)")).map((node) => {
                const leading = node.querySelector(
                  ":scope > summary .k2b-chat-activity__leading, :scope > .k2b-chat-activity__row .k2b-chat-activity__leading",
                );
                const box = node.getBoundingClientRect();
                return {
                  text: (node.querySelector(":scope > summary") ?? node).textContent?.trim() ?? "",
                  left: leading ? left(leading) : left(node),
                  box: [box.left - content.left, box.top - content.top, box.width, box.height].map(Math.round),
                };
              }),
            };
          });
        const workBefore = await viewportBox(page, ".ai-turn-work > summary");
        await page.locator(".ai-turn-work > summary").click();
        await frames(page);
        expect(await viewportBox(page, ".ai-turn-work > summary")).toEqual(workBefore);
        const live = await rows();
        // Housekeeping, the intermediate text, the three reads as one row, the search, and the write.
        expect(live.rows).toHaveLength(5);
        expect(live.rows.map(({ left }) => left)).toEqual(live.rows.map(() => live.line));
        expect(live.overflowX).toBeLessThanOrEqual(0);
        const repeat = live.rows[2]!.text;
        expect(repeat).toContain(de ? "Datei lesen" : "Read file");
        expect(repeat).toContain(de ? "3-mal" : "3 times");
        // The counts of the folded rows are never cut, also where a phone cuts the target short.
        const counts = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".ai-turn-work .ai-turn-steps > details > summary")).flatMap((summary) => {
            const count = summary.querySelector(".k2b-chat-activity__trailing");
            const target = summary.querySelector(".k2b-chat-activity__copy small");
            if (!count) return [];
            const row = summary.getBoundingClientRect();
            const box = count.getBoundingClientRect();
            return [
              {
                text: count.textContent?.trim() ?? "",
                inside: box.left >= row.left && box.right <= row.right,
                cut: count.scrollWidth > count.clientWidth,
                targetCut: target ? target.scrollWidth > target.clientWidth : false,
              },
            ];
          }),
        );
        expect(counts.map(({ text, inside, cut }) => ({ text, inside, cut }))).toEqual([
          { text: de ? "2 Schritte" : "2 steps", inside: true, cut: false },
          { text: de ? "3-mal" : "3 times", inside: true, cut: false },
        ]);
        if (view.name === "phone") expect(counts[1]!.targetCut).toBe(true);
        await page.screenshot({ path: `/tmp/ai-work-flush-${view.name}-${theme}.png` });

        // The row opens in place to its three reads at the same left edge; nothing above it moves, and closing it restores the list.
        const repeatSummary = page.locator(".ai-turn-work .ai-turn-steps > details").nth(1).locator(":scope > summary");
        await repeatSummary.click();
        await frames(page);
        const opened = await rows();
        // The row grows downwards only: its own top, left, and width and every row above it stay.
        const top = (rows: typeof live.rows) => rows.slice(0, 3).map(({ box }) => box.slice(0, 3));
        expect(top(opened.rows)).toEqual(top(live.rows));
        const parts = opened.rows.filter(({ text }) => text.includes(path)).slice(1);
        expect(parts).toHaveLength(3);
        expect(parts.map(({ left }) => left)).toEqual([live.line, live.line, live.line]);
        expect(opened.overflowX).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `/tmp/ai-work-repeat-open-${view.name}-${theme}.png` });
        await repeatSummary.click();
        await frames(page);
        expect((await rows()).rows).toEqual(live.rows);

        // The turn ends: its history shows the same rows in the same places.
        await emit(page, {
          ...base,
          seq: seq++,
          type: "turn_finished",
          status: "completed",
          error: null,
          messages: [
            request,
            storedMessage(11, "turn", {
              role: "assistant",
              content: calls.slice(0, 2).map((call) => ({ type: "tool_call" as const, id: call.callId, name: call.name, args: call.args })),
            }),
            ...calls.slice(0, 2).map((call, index) =>
              storedMessage(12 + index, "turn", {
                role: "tool_result",
                callId: call.callId,
                name: call.name,
                result: call.result,
                isError: false,
              }),
            ),
            storedMessage(14, "turn", {
              role: "assistant",
              content: [
                { type: "text", text: "I read the file in parts." },
                ...calls.slice(2).map((call) => ({ type: "tool_call" as const, id: call.callId, name: call.name, args: call.args })),
              ],
            }),
            ...calls.slice(2).map((call, index) =>
              storedMessage(15 + index, "turn", {
                role: "tool_result",
                callId: call.callId,
                name: call.name,
                result: call.result,
                isError: false,
              }),
            ),
            storedMessage(
              20,
              "turn",
              { role: "assistant", content: [{ type: "text", text: "Here is the report." }] },
              { loopDoneReason: "stop", createdAt: "2026-10-07T10:00:00.000Z" },
            ),
          ],
        });
        await frames(page);
        const history = await rows();
        expect(history.rows.map(({ text, left }) => ({ text, left }))).toEqual(live.rows.map(({ text, left }) => ({ text, left })));
      } finally {
        await context.close();
      }
    }, 60_000);
