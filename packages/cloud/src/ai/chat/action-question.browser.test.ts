import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../../ui/test/browser";

// The server render of the same card, for the first-frame comparison below.
const ssrRoot = mkdtempSync(resolve(tmpdir(), "cloud-action-question-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: ssrRoot });
Bun.plugin(plugin());
process.once("exit", () => rmSync(ssrRoot, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { AiReaderTimeZoneProvider } = await import("./action-sentences");
const { AiChatActionsProvider } = await import("./message-actions");
const { AiTurnView } = await import("./turn-view");
const { layoutAiTurn } = await import("./turn-layout");
const { createAiToolDisclosureState } = await import("./tool-disclosure");
const { actionFixtures } = await import("./action-question.fixtures");

// Card v4 questions in the real turn view: how they sit at desktop, phone, and panel widths, in both themes, what the
// keyboard reaches, and that sending moves nothing. Layout depends on the real engine, so this runs in a browser.
const ui = resolve(import.meta.dir, "../../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "action-question.browser-harness.tsx")],
    target: "browser",
    // MapView's lazy worker uses import.meta; keep the shared chat harness a module.
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-action-question-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Action question harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let css = "";
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  css = await styles.outputs[0]!.text();
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const iconSource = await Bun.file(iconCss).text();
  const font = iconSource.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("The Tabler preset references no WOFF2 file.");
  const icons = { css: iconSource.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/tabler.css") return new Response(icons.css, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (url.pathname === "/tabler.woff2") return new Response(Bun.file(icons.font));
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const theme = url.searchParams.get("theme") ?? "light";
      return new Response(
        `<!doctype html><html lang="de" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
          `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin: 0"><script type="module" src="/harness.js"></script></body></html>`,
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

const QUESTIONS = "mail,sched,share,del,routine,right,skill,resume,note,task,fields,legacy,website";
const OUTCOMES = [
  "mail:running",
  "mail:done",
  "del:done",
  "mail:declined",
  "mail:expired",
  "mail:error",
  "mail:checking",
  "mail:found",
  "mail:notfound",
  "mail:pending",
  "mail:checkfail",
  "mail:nocheck",
].join(",");

const VIEWS = [
  { name: "1440", width: 1440, height: 1000, touch: false, column: "48rem" },
  { name: "390", width: 390, height: 844, touch: true, column: "48rem" },
  // The Assistant beside an app: a 22 rem panel column in a wide window.
  { name: "panel 22rem", width: 1440, height: 1000, touch: false, column: "22rem" },
] as const;

const open = async (view: (typeof VIEWS)[number], query: string, theme: "light" | "dark" = "light") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-17T12:10:00Z"));
  await page.goto(`http://127.0.0.1:${server.port}/?${query}&col=${view.column}&theme=${theme}`);
  await page.locator(".k2b-chat-decision").first().waitFor();
  await settled(page);
  return { page, errors, close: () => context.close() };
};

/** Every question and outcome line fits its column: nothing overflows, chips wrap inside, answers stay 44 px high. */
const fits = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.querySelector(".k2b-chat-timeline__viewport")!;
    const column = document.querySelector("main")!.getBoundingClientRect();
    const outside = Array.from(document.querySelectorAll(".k2b-chat-decision *"))
      .map((node) => node.getBoundingClientRect())
      .filter((box) => box.width > 0 && (box.right > column.right + 0.5 || box.left < column.left - 0.5)).length;
    const answers = Array.from(document.querySelectorAll(".k2b-chat-decision__answer")).map((node) => node.getBoundingClientRect().height);
    return { overflowX: viewport.scrollWidth - viewport.clientWidth, outside, answers };
  });

describe("card v4 at every width and theme", () => {
  for (const view of VIEWS)
    for (const theme of ["light", "dark"] as const) {
      test(`every question fits and answers are 44 px (${view.name}, ${theme})`, async () => {
        const { page, errors, close } = await open(view, `scenarios=${QUESTIONS}`, theme);
        try {
          const result = await fits(page);
          expect(result.overflowX).toBeLessThanOrEqual(0);
          expect(result.outside).toBe(0);
          expect(result.answers.length).toBeGreaterThanOrEqual(26);
          for (const height of result.answers) expect(height).toBeGreaterThanOrEqual(44);
          expect(await page.locator(".k2b-chat-decision__card").count()).toBe(13);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }, 60_000);

      test(`every outcome line fits, with its tone (${view.name}, ${theme})`, async () => {
        const { page, errors, close } = await open(view, `scenarios=${OUTCOMES}`, theme);
        try {
          const result = await fits(page);
          expect(result.overflowX).toBeLessThanOrEqual(0);
          expect(result.outside).toBe(0);
          const tones = await page.$$eval(".k2b-chat-outcome", (nodes) => nodes.map((node) => node.getAttribute("data-tone")));
          expect(tones).toEqual([
            "running",
            "done",
            "done",
            "off",
            "off",
            "error",
            "running",
            "done",
            "off",
            "warning",
            "warning",
            "warning",
          ]);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }, 60_000);
    }

  test("a narrow chat uses the phone sentence size and lets the answers share the row, a wide one keeps 18 px", async () => {
    const sizes: Record<string, string> = {};
    for (const view of VIEWS) {
      const { page, close } = await open(view, "scenarios=del");
      try {
        sizes[view.name] = await page.$eval(".k2b-chat-decision__sentence", (node) => getComputedStyle(node).fontSize);
        if (view.column === "22rem" || view.touch) {
          const boxes = await page.$$eval(".k2b-chat-decision__answer", (nodes) => nodes.map((node) => node.getBoundingClientRect()));
          const row = await page.$eval(".k2b-chat-decision__answers", (node) => node.getBoundingClientRect().width);
          // Either both share one row or each takes the whole row; never one narrow button beside a gap.
          const shared = boxes[0]!.top === boxes[1]!.top;
          expect(shared ? boxes[0]!.width + boxes[1]!.width > row - 12 : boxes[0]!.width > row - 1).toBe(true);
        }
      } finally {
        await close();
      }
    }
    expect(sizes).toEqual({ "1440": "18px", "390": "17px", "panel 22rem": "17px" });
  }, 60_000);
});

/** Samples the boxes of `selectors` in every frame until `stop()` is called in the page. */
const sample = (page: Page, selectors: Record<string, string>) =>
  page.evaluate((targets) => {
    const frames: Record<string, number[]>[] = [];
    const read = () => {
      const entry: Record<string, number[]> = {};
      for (const [name, selector] of Object.entries(targets)) {
        const node = document.querySelector(selector);
        const box = node?.getBoundingClientRect();
        entry[name] = box ? [Math.round(box.top * 10) / 10, Math.round(box.height * 10) / 10] : [];
      }
      frames.push(entry);
    };
    let running = true;
    const loop = () => {
      if (!running) return;
      read();
      requestAnimationFrame(loop);
    };
    loop();
    Object.assign(window, {
      stopSampling: () => {
        running = false;
        read();
        return frames;
      },
    });
  }, selectors);

describe("answering", () => {
  for (const view of VIEWS)
    test(`sending moves nothing above the card, and running to done moves the line by 0 px (${view.name})`, async () => {
      const { page, close } = await open(view, "scenarios=mail&slow=1");
      try {
        const aboveBox = await page.$eval(".ai-turn__text", (node) => node.getBoundingClientRect().top);
        const cardTop = await page.$eval(".k2b-chat-decision", (node) => node.getBoundingClientRect().top);
        await page.locator(".k2b-chat-decision__answer").first().click();
        // The card collapsed at once, before the server answered: the outcome line stands where the card began.
        await page.locator(".k2b-chat-outcome").waitFor();
        await settled(page);
        expect(await page.locator(".k2b-chat-decision__card").count()).toBe(0);
        expect(await page.$eval(".k2b-chat-decision", (node) => node.getBoundingClientRect().top)).toBe(cardTop);
        expect(await page.$eval(".ai-turn__text", (node) => node.getBoundingClientRect().top)).toBe(aboveBox);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-chat-outcome"))).toBe(true);
        // The fixture holds the answer until release(). The line fills its live region 40 ms after it changes, a timer
        // that settled() does not wait for, so wait for the words while the answer is still held.
        await page.waitForFunction(() =>
          document.querySelector(".k2b-chat-outcome [role='status']")?.textContent?.includes("wird gesendet …"),
        );
        expect(await page.locator(".k2b-chat-outcome [role='status']").textContent()).toContain("wird gesendet …");

        await sample(page, { line: ".k2b-chat-outcome", text: ".ai-turn__text" });
        await page.evaluate(() => (window as unknown as { release: () => void }).release());
        // The turn reports the decision, then the outcome, while it still runs.
        type Patch = (key: string, patch: Record<string, unknown>) => void;
        await page.evaluate(() =>
          (window as unknown as { patch: Patch }).patch("mail", {
            status: "running",
            approval: undefined,
            approved: true,
            phase: "running",
          }),
        );
        await settled(page);
        await page.evaluate(() =>
          (window as unknown as { patch: Patch }).patch("mail", {
            status: "completed",
            result: { data: {} },
            at: "2026-10-17T12:02:00.000Z",
            phase: "running",
          }),
        );
        await page.waitForFunction(() => document.querySelector(".k2b-chat-outcome")?.getAttribute("data-tone") === "done");
        await settled(page);
        const frames = await page.evaluate(() => (window as unknown as { stopSampling: () => Record<string, number[]>[] }).stopSampling());
        expect(frames.length).toBeGreaterThan(2);
        for (const name of ["line", "text"]) expect(new Set(frames.map((frame) => JSON.stringify(frame[name]))).size).toBe(1);
        expect(await page.locator(".k2b-chat-outcome__text[data-current='true']").textContent()).toContain("wird gesendet.");
      } finally {
        await close();
      }
    }, 60_000);

  test("the keyboard answers, focus lands on the outcome, and a lost answer brings the focus back to the sentence", async () => {
    const { page, close } = await open(VIEWS[0], "scenarios=mail&fail=1");
    try {
      await page.locator(".k2b-chat-decision__answer").first().focus();
      await page.keyboard.press("Enter");
      await page.locator(".k2b-chat-outcome[data-tone='warning']").waitFor();
      expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-chat-outcome"))).toBe(true);
      expect(await page.locator(".k2b-chat-outcome__text[data-current='true']").textContent()).toContain("kam nicht an");
      // The thing's chip in the line is a link; the line's own link follows it.
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Tab");
        if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Noch einmal antworten") break;
      }
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Noch einmal antworten");
      await page.keyboard.press("Enter");
      await page.locator(".k2b-chat-decision__card").waitFor();
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-chat-decision__sentence"))).toBe(true);
      // Tab order in the card: the thing's links, then confirm, then decline.
      const order: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("Tab");
        order.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
      }
      expect(order.indexOf("An Lea Berg senden")).toBeLessThan(order.indexOf("Nicht senden"));
      expect(order).toContain("Ganze Mail lesen");
    } finally {
      await close();
    }
  }, 60_000);

  test("several open questions: answering one leaves the other open and asking", async () => {
    const { page, close } = await open(VIEWS[1], "scenarios=mail,del&multi=1");
    try {
      expect(await page.locator(".k2b-chat-decision__card").count()).toBe(2);
      await page.locator(".k2b-chat-decision__card").nth(1).locator(".k2b-chat-decision__answer").nth(1).click();
      await page.locator(".k2b-chat-outcome").waitFor();
      await settled(page);
      expect(await page.locator(".k2b-chat-decision__card").count()).toBe(1);
      expect(await page.locator(".k2b-chat-decision__card .k2b-chat-decision__sentence").textContent()).toContain("senden?");
      expect(await page.locator(".k2b-chat-outcome__text[data-current='true']").textContent()).toContain("bleibt im Kalender");
      expect(await page.evaluate(() => (window as unknown as { approvals: unknown[] }).approvals)).toEqual([
        { callId: "del-1", approved: false },
      ]);
    } finally {
      await close();
    }
  }, 60_000);

  test("a question at the end of a long chat is in view and fits", async () => {
    const { page, close } = await open(VIEWS[1], "scenarios=sched&history=60");
    try {
      const inView = await page.evaluate(() => {
        const viewport = document.querySelector(".k2b-chat-timeline__viewport")!.getBoundingClientRect();
        const answers = document.querySelector(".k2b-chat-decision__answers")!.getBoundingClientRect();
        return answers.bottom <= viewport.bottom + 0.5 && answers.top >= viewport.top;
      });
      expect(inView).toBe(true);
      expect((await fits(page)).overflowX).toBeLessThanOrEqual(0);
    } finally {
      await close();
    }
  }, 60_000);

  test("a check that could not settle the outcome asks again only through its own button", async () => {
    const { page, close } = await open(VIEWS[0], "scenarios=mail:checkfail");
    try {
      expect(await page.getByRole("button", { name: "An Lea Berg senden" }).count()).toBe(0);
      await page.getByRole("button", { name: "Noch einmal prüfen" }).click();
      await page.waitForFunction(() => document.querySelector(".k2b-chat-outcome")?.getAttribute("data-tone") === "done");
      expect(await page.evaluate(() => (window as unknown as { checks: string[] }).checks)).toEqual(["mail-1"]);
      expect(await page.evaluate(() => (window as unknown as { approvals: unknown[] }).approvals)).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe("server render", () => {
  /** Boxes of the card's parts relative to the card, so the two pages compare at the same width. */
  const parts = (page: Page) =>
    page.evaluate(() => {
      const card = document.querySelector(".k2b-chat-decision")!.getBoundingClientRect();
      return Array.from(
        document.querySelectorAll(
          ".k2b-chat-decision__sentence, .k2b-chat-decision__reason, .k2b-chat-preview > *, .k2b-chat-decision__answer, .k2b-reference",
        ),
      ).map((node) => {
        const box = node.getBoundingClientRect();
        return [box.left - card.left, box.top - card.top, box.width, box.height].map((value) => Math.round(value));
      });
    });

  for (const view of [VIEWS[0], VIEWS[1]])
    test(`the server's first frame of a question equals the browser's (${view.name})`, async () => {
      const client = await open(view, "scenarios=sched");
      try {
        // The chat timeline is the container its questions measure; the server page gives the card the same place in it.
        const place = await client.page.evaluate(() => {
          const timeline = document.querySelector(".k2b-chat-timeline")!.getBoundingClientRect();
          const card = document.querySelector(".k2b-chat-decision")!.getBoundingClientRect();
          return { timeline: timeline.width, left: card.left - timeline.left, width: card.width };
        });
        const block = actionFixtures("de").sched!.block;
        const html = renderToString(() =>
          createComponent(LocaleProvider, {
            locale: "de",
            get children() {
              return createComponent(AiReaderTimeZoneProvider, {
                value: "Europe/Berlin",
                get children() {
                  return createComponent(AiChatActionsProvider, {
                    actions: { onApproval: async () => undefined },
                    get children() {
                      return createComponent(AiTurnView, {
                        segment: () => ({
                          id: "turn",
                          turnId: "turn",
                          phase: "waiting",
                          layout: layoutAiTurn([block], { phase: "waiting" }),
                          earlier: false,
                          duration: () => null,
                        }),
                        disclosureState: createAiToolDisclosureState(),
                      });
                    },
                  });
                },
              });
            },
          }),
        );
        const context = await browser.newContext({
          viewport: { width: view.width, height: view.height },
          isMobile: view.touch,
          reducedMotion: "reduce",
        });
        try {
          const ssr = await context.newPage();
          // Same origin as the harness, so the icon font loads the same way.
          await ssr.goto(`http://127.0.0.1:${server.port}/tabler.css`);
          await ssr.setContent(
            `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
              `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
              `<body class="k2b-ui" style="margin:0"><div class="k2b-chat-timeline" style="width:${place.timeline}px">` +
              `<div style="margin-left:${place.left}px;width:${place.width}px">${html}</div></div></body></html>`,
          );
          await settled(ssr);
          const [serverParts, clientParts] = [await parts(ssr), await parts(client.page)];
          expect(serverParts).toEqual(clientParts);
        } finally {
          await context.close();
        }
      } finally {
        await client.close();
      }
    }, 60_000);
});

describe("complete review proposal", () => {
  for (const view of VIEWS)
    for (const theme of ["light", "dark"] as const) {
      test(`requires an exact full read and recovers from reader failure (${view.name}, ${theme})`, async () => {
        const { page, errors, close } = await open(view, "scenarios=mail&full=1&lang=en", theme);
        try {
          let reads = 0;
          const body = `${"Complete proposal. ".repeat(4_000)}\u0000\u202e\ud800FINAL-END`;
          await page.route("**/api/approvals/*/content?digest=*", async (route) => {
            reads++;
            await route.fulfill(
              reads === 1
                ? { status: 403, json: { message: "Unavailable" } }
                : {
                    json: {
                      kind: "message",
                      baseRevision: 7,
                      from: { name: "Original actor", address: "sender@example.test" },
                      to: [{ address: "recipient@example.test" }],
                      subject: "Unsaved proposal",
                      body,
                      format: "plain",
                      attachments: [{ name: "complete.pdf", size: 123 }],
                    },
                  },
            );
          });
          const send = page.getByRole("button", { name: /^Send to / });
          expect(await send.isDisabled()).toBe(true);
          await page.getByRole("button", { name: "Read the complete proposal", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByText("The complete proposal could not be loaded. Try again before approving.", { exact: true }).waitFor();
          expect(await send.isDisabled()).toBe(true);
          await dialog.getByRole("button", { name: "Try again", exact: true }).click();
          await dialog.getByText("Unsaved proposal", { exact: true }).waitFor();
          const rendered = await dialog.textContent();
          expect(rendered).toContain("Based on revision 7");
          expect(rendered).toContain("Complete proposal. ".repeat(4_000));
          expect(rendered).toContain("⟦U+0000⟧⟦U+202E⟧⟦U+D800⟧FINAL-END");
          expect(rendered).toContain("sender@example.test");
          expect(rendered).toContain("complete.pdf");
          expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          expect(await send.isEnabled()).toBe(true);
          expect(reads).toBe(2);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }, 30_000);
    }
});
