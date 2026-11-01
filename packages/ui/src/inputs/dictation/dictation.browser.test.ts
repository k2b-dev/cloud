import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../test/browser";

// Live dictation in the assistant composer with a scripted source: where text lands, what replaces the footer and
// whether anything moves are results of layout and focus in a real engine.
const ui = resolve(import.meta.dir, "../../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "dictation.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const [draft, setDraft] = createSignal(options.draft ?? "");
window.draft = draft;
window.log = [];
window.sent = [];
let push;
const source = {
  devices: async () => [
    { id: "default", label: "MacBook-Mikrofon" },
    { id: "airpods", label: "AirPods Pro" },
    { id: "jabra", label: "Jabra Speak 510" },
  ],
  start: ({ deviceId, signal }) => {
    const queue = [];
    let wake;
    let ended = false;
    push = (event) => {
      queue.push(event);
      wake?.();
    };
    window.log.push("start:" + (deviceId ?? "none"));
    signal.addEventListener("abort", () => {
      ended = true;
      window.log.push("abort");
      wake?.();
    });
    const events = {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          const event = queue.shift();
          if (!event) {
            await new Promise((done) => (wake = done));
            continue;
          }
          yield event;
          if ((event.type === "state" && event.state === "finished") || event.type === "error") return;
        }
      },
    };
    return {
      events,
      stop: () => {
        window.log.push("stop");
        push({ type: "state", state: "finishing" });
        return new Promise((done) => (window.finish = (text) => {
          if (text) push({ type: "text", text });
          push({ type: "state", state: "finished" });
          done();
        }));
      },
    };
  },
};
window.emit = (event) => push(event);

render(
  () =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return createComponent(Chat.Composer, {
          variant: options.variant,
          get value() {
            return draft();
          },
          onValueChange: setDraft,
          onSubmit: ({ text }) => {
            window.sent.push(text);
          },
          fileSelection: { onSelect: () => {} },
          dictation: {
            source,
            alternative: options.alternative ? { label: "Record instead", note: "Try again soon or record.", run: () => window.log.push("record") } : undefined,
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dictation fixture for the browser.");
const script = await build.outputs[0]!.text();

declare const emit: (event: unknown) => void;
declare const finish: (text?: string) => void;
declare const draft: () => string;
declare const log: string[];
declare const sent: string[];

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (
  options: { width?: number; draft?: string; alternative?: boolean; locale?: "en" | "de"; variant?: "conversation" } = {},
): Promise<Page> => {
  const width = options.width ?? 900;
  const page = await (await browser.newContext({ viewport: { width, height: 700 } })).newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const documentHtml =
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<style>${css}</style><style>${fonts}</style>` +
    `<style>*,*::before,*::after{transition:none!important}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; padding: 0.5rem; box-sizing: border-box; }
</style></head><body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`;
  const documentUrl = `${assets}dictation`;
  await page.route(documentUrl, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  await page.goto(documentUrl);
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-chat-composer textarea").first().waitFor();
  return page;
};

const box = async (page: Page, selector: string) => {
  await settled(page);
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} has no box`);
  return rect;
};
const start = async (page: Page) => {
  await page.getByRole("button", { name: "Dictate" }).click();
  await page.evaluate(() => {
    emit({ type: "state", state: "connecting" });
    emit({ type: "state", state: "live", maxMs: 600_000, device: { id: "default", label: "MacBook-Mikrofon" } });
  });
  await page.getByRole("group", { name: "Dictating" }).waitFor();
};

describe("live dictation in the composer", () => {
  test("the bar stands in for the footer at the same height, and text lands at the caret", async () => {
    const page = await open({ draft: "Write a short mail to Jana:" });
    try {
      const composer = await box(page, ".k2b-chat-composer");
      const footer = await box(page, ".k2b-chat-composer__footer");
      await page.locator("textarea").click();
      await page.keyboard.press("End");
      await start(page);
      expect(await box(page, ".k2b-chat-composer__footer")).toEqual(footer);
      expect(await box(page, ".k2b-chat-composer")).toEqual(composer);
      // The stop button has the focus, so a second press of Enter or Space ends it.
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Stop dictation");
      await page.evaluate(() => {
        emit({ type: "text", text: "We" });
        emit({ type: "text", text: " move the setup" });
      });
      await page.waitForFunction(() => draft() === "Write a short mail to Jana: We move the setup");
      expect(await page.locator(".k2b-dictation-fresh").count()).toBeGreaterThan(0);
      expect(await page.locator(".k2b-dictation-mark").count()).toBe(1);
      // Send waits while dictation runs, also through Enter in the field.
      await page.locator("textarea").press("Enter");
      expect(await page.evaluate(() => sent.length)).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("typing elsewhere keeps the dictation at its mark", async () => {
    const page = await open({ draft: "Start. End." });
    try {
      await page.locator("textarea").click();
      await page.evaluate(() => document.querySelector("textarea")!.setSelectionRange(6, 6));
      await start(page);
      await page.evaluate(() => emit({ type: "text", text: " Middle" }));
      await page.waitForFunction(() => draft() === "Start. Middle End.");
      await page.locator("textarea").click();
      await page.evaluate(() => document.querySelector("textarea")!.setSelectionRange(0, 0));
      await page.keyboard.type("New: ");
      await page.evaluate(() => emit({ type: "text", text: " goes on" }));
      await page.waitForFunction(() => draft() === "New: Start. Middle goes on End.");
      // The person's own caret stayed where they typed.
      expect(await page.evaluate(() => document.querySelector("textarea")!.selectionStart)).toBe(5);
    } finally {
      await page.context().close();
    }
  });

  test("a caret placed before the text is a valid start, also at offset zero", async () => {
    const page = await open({ draft: "existing text" });
    try {
      await page.locator("textarea").click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Control+Home");
      await start(page);
      await page.evaluate(() => emit({ type: "text", text: "First" }));
      await page.evaluate(() => emit({ type: "text", text: " words" }));
      // Words before existing text keep one space to it.
      await page.waitForFunction(() => draft() === "First words existing text");
    } finally {
      await page.context().close();
    }
  });

  test("stop finishes with the last words, then the microphone has the focus again", async () => {
    const page = await open({ draft: "" });
    try {
      await start(page);
      await page.evaluate(() => emit({ type: "text", text: "Hello" }));
      await page.getByRole("button", { name: "Stop dictation" }).click();
      await page.getByRole("group", { name: "Finishing dictation" }).waitFor();
      expect(await page.getByRole("status").filter({ hasText: "Finishing …" }).count()).toBe(1);
      await page.evaluate(() => finish(" world"));
      await page.getByRole("button", { name: "Dictate" }).waitFor();
      expect(await page.evaluate(() => draft())).toBe("Hello world");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Dictate");
      expect(await page.locator(".k2b-dictation-mark").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("discard removes only the dictated words and ends the connection at once", async () => {
    const page = await open({ draft: "Earlier draft." });
    try {
      await page.locator("textarea").click();
      await page.keyboard.press("End");
      await start(page);
      await page.evaluate(() => emit({ type: "text", text: "Dictated words" }));
      await page.waitForFunction(() => draft() === "Earlier draft. Dictated words");
      await page.getByRole("button", { name: "Discard dictation" }).click();
      await page.waitForFunction(() => draft() === "Earlier draft.");
      expect(await page.evaluate(() => log)).toContain("abort");
    } finally {
      await page.context().close();
    }
  });

  test("Escape stops, and an interruption keeps the text with a way to continue at the same mark", async () => {
    const page = await open({ draft: "" });
    try {
      await start(page);
      await page.evaluate(() => emit({ type: "text", text: "One" }));
      await page.evaluate(() => emit({ type: "error", code: "connection_lost", retryable: true }));
      await page.getByRole("button", { name: "Continue dictating" }).waitFor();
      expect(await page.locator(".k2b-dictation-bar__message--long").textContent()).toBe("Dictation interrupted. The text so far stays.");
      await page.getByRole("button", { name: "Continue dictating" }).click();
      await page.evaluate(() => {
        emit({ type: "state", state: "live", maxMs: 600_000 });
        emit({ type: "text", text: " two" });
      });
      await page.waitForFunction(() => draft() === "One two");
      await page.keyboard.press("Escape");
      await page.getByRole("group", { name: "Finishing dictation" }).waitFor();
      expect(await page.evaluate(() => log.filter((entry) => entry === "stop").length)).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("the last minute counts down, and the end after the maximum keeps the text", async () => {
    const page = await open({ draft: "" });
    try {
      await page.getByRole("button", { name: "Dictate" }).click();
      await page.evaluate(() => emit({ type: "state", state: "live", maxMs: 30_000 }));
      await page.locator(".k2b-dictation-bar__time[data-warning]").waitFor();
      expect(await page.locator(".k2b-dictation-bar__time").textContent()).toMatch(/^0:(29|30) left$/);
      await page.evaluate(() => {
        emit({ type: "text", text: "Kept" });
        emit({ type: "state", state: "finished", reason: "max_duration" });
      });
      await page.getByRole("button", { name: "Continue dictating" }).waitFor();
      expect(await page.evaluate(() => draft())).toBe("Kept");
    } finally {
      await page.context().close();
    }
  });

  for (const width of [1440, 390]) {
    test(`notice cards open above the composer and stay inside the screen at ${width} px`, async () => {
      const page = await open({ width, alternative: true });
      try {
        const composer = await box(page, ".k2b-chat-composer");
        await page.getByRole("button", { name: "Dictate" }).click();
        await page.evaluate(() => emit({ type: "error", code: "overloaded", retryable: true }));
        const card = page.getByRole("dialog", { name: "Live dictation is busy right now" });
        await card.waitFor();
        await settled(page);
        const rect = (await card.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(composer.y);
        // The card keeps the focus; the microphone does not take it back.
        await settled(page);
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
        await card.getByRole("button", { name: "Record instead" }).click();
        expect(await page.evaluate(() => log)).toContain("record");
        await page.getByRole("button", { name: "Dictate" }).click();
        await page.evaluate(() => emit({ type: "error", code: "microphone_blocked", retryable: true }));
        await page.getByRole("dialog", { name: "Microphone blocked" }).getByRole("button", { name: "Try again" }).click();
        await page.evaluate(() => emit({ type: "state", state: "live", maxMs: 600_000 }));
        await page.getByRole("group", { name: "Dictating" }).waitFor();
      } finally {
        await page.context().close();
      }
    });
  }

  test("in a conversation the bar takes the row above the field, and the field stays put", async () => {
    const page = await open({ variant: "conversation", draft: "Hi" });
    try {
      const field = await box(page, "textarea:not([aria-hidden])");
      await start(page);
      expect(await box(page, "textarea:not([aria-hidden])")).toEqual(field);
      await page.evaluate(() => emit({ type: "text", text: "there" }));
      await page.waitForFunction(() => draft() === "Hi there");
      await page.getByRole("button", { name: "Stop dictation" }).click();
      await page.evaluate(() => finish());
      await page.getByRole("button", { name: "Dictate" }).waitFor();
      expect(await box(page, "textarea:not([aria-hidden])")).toEqual(field);
    } finally {
      await page.context().close();
    }
  });

  test("closing a card returns the focus to the microphone", async () => {
    const page = await open({});
    try {
      await page.getByRole("button", { name: "Dictate" }).click();
      await page.evaluate(() => emit({ type: "error", code: "busy_elsewhere", retryable: false }));
      await page.getByRole("dialog", { name: "You are dictating in another tab" }).waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Dictate");
    } finally {
      await page.context().close();
    }
  });

  test("offline, the microphone stays focusable and says why it waits", async () => {
    const page = await open({});
    try {
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      const microphone = page.getByRole("button", { name: "Dictate, not available offline" });
      expect(await microphone.getAttribute("aria-disabled")).toBe("true");
      await microphone.click({ force: true });
      expect(await page.evaluate(() => log.length)).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("the microphone list chooses a device and remembers it", async () => {
    const page = await open({ locale: "de" });
    try {
      await page.getByRole("button", { name: "Diktieren" }).click();
      await page.evaluate(() =>
        emit({ type: "state", state: "live", maxMs: 600_000, device: { id: "default", label: "MacBook-Mikrofon" } }),
      );
      await page.getByRole("button", { name: "Mikrofon: MacBook-Mikrofon" }).click();
      await page.getByRole("menuitemradio", { name: "AirPods Pro" }).click();
      await page.getByRole("group", { name: "Diktat wird abgeschlossen" }).waitFor();
      await page.evaluate(() => finish());
      await page.waitForFunction(() => log.includes("start:airpods"));
      expect(await page.evaluate(() => localStorage.getItem("k2b.dictation.deviceId"))).toBe("airpods");
    } finally {
      await page.context().close();
    }
  });
});
