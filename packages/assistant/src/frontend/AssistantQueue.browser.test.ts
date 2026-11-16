import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import type { AssistantQueueEntry } from "./AssistantQueue";

// Queued messages (Gustav chat Feinschliff v6, 6b) are layout first: the row and its list lie over the timeline's free
// end, so they never move the field or the conversation, also beside "Waiting for you"; the three sign buttons keep
// their columns and change paint only. "Send now" runs here through the same reconciliation the workspace uses, with
// Cloud's answer held by the test, so the ring, a refusal and a lost answer can be looked at.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "AssistantQueue.browser-entry.tsx");
const entrySource = `
import { LocaleProvider } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import AssistantQueue from ${JSON.stringify(resolve(import.meta.dir, "AssistantQueue.tsx"))};
import { AssistantWaitingStrip } from ${JSON.stringify(resolve(import.meta.dir, "AssistantWaitingStrip.tsx"))};
import { sendQueuedEntryNow } from ${JSON.stringify(resolve(import.meta.dir, "queue-send.ts"))};

const [entries, setEntries] = createSignal(window.harness.entries);
const [waiting, setWaiting] = createSignal(window.harness.waiting);
const [sendingId, setSendingId] = createSignal(null);
const [failed, setFailed] = createSignal(new Set());
let outcome = "submitted";
let release = () => {};
window.queue = {
  setEntries,
  setWaiting,
  outcome: (next) => { outcome = next; },
  answer: () => release(),
};
const view = () => ({
  attention: waiting() ? [{ key: "w1", kind: "routine", short: "Bestätigung an Lena Vogt senden", open() {} }] : [],
  entries: [],
  more: 0,
  total: waiting() ? 1 : 0,
  onlyHere: null,
});
const mark = (id, on) => setFailed((current) => { const next = new Set(current); on ? next.add(id) : next.delete(id); return next; });
const sendNow = async (entry) => {
  mark(entry.id, false);
  setSendingId(entry.id);
  const result = await sendQueuedEntryNow({
    send: async () => {
      await new Promise((done) => { release = done; });
      if (outcome === "failed") return { state: "failed" };
      if (outcome.startsWith("lost")) throw new Error("lost");
      return { state: "submitted" };
    },
    // The receipt Cloud keeps: a lost answer that went out says submitted, one that did not says failed.
    receipt: async () => ({ state: outcome === "lost-gone" ? "submitted" : "failed" }),
    reload: async () => {
      if (outcome === "submitted" || outcome === "lost-gone") setEntries((list) => list.filter((item) => item.id !== entry.id));
    },
  });
  mark(entry.id, result === "not-sent");
  setSendingId(null);
};
const part = (layout) => (
  <AssistantQueue
    entries={entries()}
    layout={layout}
    sendingId={sendingId()}
    failedIds={failed()}
    busy={false}
    onSendNow={(entry) => void sendNow(entry)}
    onEdit={(entry) => setEntries((list) => list.filter((item) => item.id !== entry.id))}
    onRemove={(entry) => setEntries((list) => list.filter((item) => item.id !== entry.id))}
  />
);

render(
  () => (
    <LocaleProvider locale="de">
      <div class="assistant-chat-layout" style="display:flex;flex-direction:column;height:100vh">
        <div class="k2b-chat-timeline__content" id="timeline" style="flex:1;margin-inline:auto;overflow:auto">
          <For each={Array.from({ length: 12 })}>{(_, index) => <p style="margin:0 0 16px">Absatz {index() + 1} im Verlauf.</p>}</For>
        </div>
        <div class="assistant-chat-composer" style="padding:0 24px 24px">
          <div class="assistant-chat-composer__column mx-auto flex max-w-3xl flex-col gap-2">
            <Show when={waiting()}>
              <AssistantWaitingStrip view={view()} conversationId="chat01" quiet={false} onJump={() => {}} onShowMore={() => {}}
                queue={entries().length > 0 ? part("chip") : undefined} />
            </Show>
            <Show when={!waiting() && entries().length > 0}>{part("line")}</Show>
            <div id="field" style="height:112px;border-radius:16px;border:1px solid var(--k2b-border)"><textarea aria-label="Nachricht" style="width:100%;border:0" /></div>
          </div>
        </div>
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root"),
);
`;

const ENTRIES: AssistantQueueEntry[] = [
  {
    id: "q1",
    text: "Und markiere die Buchungen über 300 €",
    origin: { kind: "person", id: "u1", name: "Lena Vogt" },
    state: "pending",
    authorIsViewer: true,
  },
  {
    id: "q2",
    text: "Briefing für Montag: 3 neue Lieferavise, 1 Mahnung fällig, 2 Termine am Vormittag und eine offene Rückfrage von Holzhandel Nord zur Lieferung der Eichenbohlen",
    origin: { kind: "automation", id: "a1", name: "Morgen-Briefing", href: "/app/code/a1" },
    state: "pending",
    authorIsViewer: false,
  },
  {
    id: "q3",
    text: "Bitte prüfe, ob die Anzahlung von Lena Vogt eingegangen ist",
    origin: { kind: "chat", id: "c1", name: "Messe Köln" },
    state: "pending",
    authorIsViewer: false,
  },
  {
    id: "q4",
    text: "Leg die Tabelle danach in den Space Buchhaltung und sag Tom Bescheid, dass der Abgleich für November fertig ist",
    origin: { kind: "person", id: "u1", name: "Lena Vogt" },
    state: "pending",
    authorIsViewer: true,
  },
  {
    id: "q5",
    text: "Abgleich Oktober ist fertig: 2 Abweichungen",
    origin: { kind: "automation", id: "a2", name: "PayPal-Abgleich" },
    state: "pending",
    authorIsViewer: false,
  },
];

let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
let css: string;
let script: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-queue",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const source = path === entry ? entrySource : await Bun.file(path).text();
            const result = await transformAsync(source, {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the queue harness.");
  script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const stylesheets = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", path.slice(4))));
      return new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
});

type View = { name: string; width: number; height: number; touch: boolean };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const phone: View = { name: "390", width: 390, height: 780, touch: true };

const open = async (view: View, options: { entries?: AssistantQueueEntry[]; waiting?: boolean; theme?: "light" | "dark" } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    locale: "de",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  const harness = { entries: options.entries ?? ENTRIES, waiting: options.waiting ?? false };
  await page.route(`${assets.url.origin}/app`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="de" class="${options.theme ?? "light"}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
        `<body class="k2b-ui" style="margin:0"><div id="root"></div>` +
        `<script>window.harness = ${JSON.stringify(harness).replace(/</g, "\\u003c")};</script><script src="/harness.js"></script></body></html>`,
    }),
  );
  await page.goto(`${assets.url.origin}/app`);
  await page.locator("#field").waitFor();
  await settled(page);
  return { page, errors, close: () => context.close() };
};

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };
const box = (page: Page, selector: string): Promise<Box> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const round = (value: number) => Math.round(value * 10) / 10;
      return {
        top: round(rect.top),
        bottom: round(rect.bottom),
        left: round(rect.left),
        right: round(rect.right),
        width: round(rect.width),
        height: round(rect.height),
      };
    });
/** Where the field and the conversation are: neither may move while the queue comes, grows, opens and goes. */
const frame = async (page: Page) => ({ field: await box(page, "#field"), timeline: await box(page, "#timeline") });
const setEntries = (page: Page, entries: AssistantQueueEntry[]) =>
  page.evaluate((next) => (window as unknown as { queue: { setEntries: (value: unknown) => void } }).queue.setEntries(next), entries);
const setWaiting = (page: Page, on: boolean) =>
  page.evaluate((next) => (window as unknown as { queue: { setWaiting: (value: boolean) => void } }).queue.setWaiting(next), on);
const answer = (page: Page, outcome: "submitted" | "failed" | "lost-pending" | "lost-gone") =>
  page.evaluate((next) => {
    const queue = (window as unknown as { queue: { outcome: (value: string) => void; answer: () => void } }).queue;
    queue.outcome(next);
    queue.answer();
  }, outcome);
const row = (page: Page, id: string) => page.locator(`.assistant-queue__row[data-entry="${id}"]`);
const actionsOpacity = (page: Page) =>
  page
    .locator(".assistant-queue__row")
    .evaluateAll((rows) => rows.map((element) => Number(getComputedStyle(element.querySelector(".assistant-queue__actions")!).opacity)));

describe("queued messages", () => {
  test("the row and the list never move the field or the conversation, also beside Waiting for you", async () => {
    const { page, errors, close } = await open(desktop, { entries: [] });
    try {
      const before = await frame(page);
      // Appears, grows, opens, closes, shares its row with "Waiting for you", goes.
      await setEntries(page, ENTRIES.slice(0, 1));
      await settled(page);
      expect(await box(page, ".assistant-queue")).toMatchObject({ height: 32 });
      expect(await frame(page)).toEqual(before);
      await setEntries(page, ENTRIES);
      await settled(page);
      expect(await frame(page)).toEqual(before);
      await page.getByRole("button", { name: "Alle 5 vorgemerkten Nachrichten zeigen" }).click();
      await settled(page);
      expect(await page.locator(".assistant-queue__list").isVisible()).toBe(true);
      expect(await frame(page)).toEqual(before);
      // The list floats over the row across its full width.
      const line = await box(page, ".assistant-queue");
      const list = await box(page, ".assistant-queue__list");
      expect([list.left, list.right]).toEqual([line.left, line.right]);
      expect(list.bottom).toBeLessThanOrEqual(line.top);
      await page.keyboard.press("Escape");
      await setWaiting(page, true);
      await settled(page);
      const shared = await box(page, "nav.assistant-waiting");
      expect(shared.height).toBe(32);
      expect(await page.locator(".assistant-queue").count()).toBe(1);
      expect(await page.locator("nav.assistant-waiting .assistant-queue__chip").innerText()).toContain("Vorgemerkt");
      expect(await frame(page)).toEqual(before);
      await setEntries(page, []);
      await setWaiting(page, false);
      await settled(page);
      expect(await page.locator(".assistant-queue").count()).toBe(0);
      expect(await frame(page)).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("the sign columns line up in every row, and pointer and focus show only their row's signs without moving anything", async () => {
    const { page, close } = await open(desktop);
    try {
      await page.getByRole("button", { name: "Alle 5 vorgemerkten Nachrichten zeigen" }).click();
      await settled(page);
      const columns = await page
        .locator(".assistant-queue__row")
        .evaluateAll((rows) =>
          rows.map((element) =>
            Array.from(element.querySelectorAll(".assistant-queue__actions > :not([role=tooltip])")).map((place) =>
              Math.round(place.getBoundingClientRect().left),
            ),
          ),
        );
      for (const places of columns) expect(places).toEqual(columns[0]!);
      expect(await box(page, ".assistant-queue__actions")).toMatchObject({ width: 94 });
      const rows = () =>
        page
          .locator(".assistant-queue__row")
          .evaluateAll((list) =>
            list.map((element) => [...element.querySelectorAll("*")].map((part) => JSON.stringify(part.getBoundingClientRect()))),
          );
      const before = await rows();
      expect(await actionsOpacity(page)).toEqual([0, 0, 0, 0, 0]);
      await hoverInPlace(row(page, "q2").locator(".assistant-queue__text"));
      await settled(page);
      expect(await actionsOpacity(page)).toEqual([0, 1, 0, 0, 0]);
      expect(await rows()).toEqual(before);
      await page.mouse.move(0, 0);
      await row(page, "q4").getByRole("button", { name: "Bearbeiten" }).focus();
      await settled(page);
      expect(await actionsOpacity(page)).toEqual([0, 0, 0, 1, 0]);
      expect(await rows()).toEqual(before);
      // The empty edit place of another's entry is no tab stop.
      await row(page, "q2").getByRole("button", { name: "Jetzt senden" }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("[data-entry]")?.getAttribute("data-entry"))).toBe("q1");
    } finally {
      await close();
    }
  });

  test("a long text gives way while its source stays whole, in the row and in the list", async () => {
    const { page, close } = await open(desktop, { entries: [ENTRIES[1]!, ENTRIES[2]!] });
    try {
      await page.getByRole("button", { name: "Alle 2 vorgemerkten Nachrichten zeigen" }).click();
      await settled(page);
      for (const scope of [".assistant-queue__next", '.assistant-queue__row[data-entry="q2"]']) {
        const parts = await page.locator(scope).evaluate((element) => {
          const text = element.querySelector(".assistant-queue__text")!;
          const origin = element.querySelector(".assistant-queue__origin")!;
          return {
            cut: text.scrollWidth > text.clientWidth,
            origin: origin.scrollWidth <= origin.clientWidth + 1 && origin.getBoundingClientRect().width > 0,
            after: Math.round(origin.getBoundingClientRect().left - text.getBoundingClientRect().right),
          };
        });
        expect(parts).toEqual({ cut: true, origin: true, after: 0 });
      }
    } finally {
      await close();
    }
  });

  test("Send now shows the ring while Cloud answers; a confirmed send leaves the queue", async () => {
    const { page, close } = await open(desktop);
    try {
      await page.getByRole("button", { name: "Alle 5 vorgemerkten Nachrichten zeigen" }).click();
      await row(page, "q3").getByRole("button", { name: "Jetzt senden" }).click();
      await row(page, "q3").getByRole("status", { name: "Wird gesendet …" }).waitFor();
      await page.mouse.move(0, 0);
      await settled(page);
      // The ring informs, so it stays without the pointer; every other button waits.
      expect((await actionsOpacity(page))[2]).toBe(1);
      expect(await page.locator(".assistant-queue__actions button:not([disabled])").count()).toBe(0);
      await answer(page, "submitted");
      await row(page, "q3").waitFor({ state: "detached" });
      expect(await page.locator(".assistant-queue__actions button[disabled]").count()).toBe(0);
    } finally {
      await close();
    }
  });

  test("a refused or lost answer keeps the entry, says Not sent and offers Send again; a lost answer that went out does not", async () => {
    const { page, close } = await open(desktop);
    try {
      await page.getByRole("button", { name: "Alle 5 vorgemerkten Nachrichten zeigen" }).click();
      for (const outcome of ["failed", "lost-pending"] as const) {
        await row(page, "q1")
          .getByRole("button", { name: /Jetzt senden|Erneut senden/ })
          .click();
        await answer(page, outcome);
        await row(page, "q1").getByRole("button", { name: "Erneut senden" }).waitFor();
        expect(await row(page, "q1").locator(".assistant-queue__state").innerText()).toBe("Nicht gesendet");
        expect(await page.locator(".assistant-queue__next ~ .assistant-queue__state").innerText()).toBe("Nicht gesendet");
      }
      await row(page, "q1").getByRole("button", { name: "Erneut senden" }).click();
      await answer(page, "lost-gone");
      await row(page, "q1").waitFor({ state: "detached" });
      expect(await page.getByText("Nicht gesendet").count()).toBe(0);
    } finally {
      await close();
    }
  });

  test("on a phone every row shows its signs with 44 px taps and the list stays inside the screen", async () => {
    for (const theme of ["light", "dark"] as const) {
      const { page, close } = await open(phone, { theme });
      try {
        const before = await frame(page);
        await page.getByRole("button", { name: "Alle 5 vorgemerkten Nachrichten zeigen" }).click();
        await settled(page);
        expect(await frame(page)).toEqual(before);
        expect(await actionsOpacity(page)).toEqual([1, 1, 1, 1, 1]);
        const taps = await page.locator(".assistant-queue__actions .k2b-icon-button").evaluateAll((buttons) =>
          buttons.map((button) => {
            const after = getComputedStyle(button, "::after");
            const rect = button.getBoundingClientRect();
            return Math.round(rect.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom));
          }),
        );
        for (const tap of taps) expect(tap).toBeGreaterThanOrEqual(44);
        const list = await box(page, ".assistant-queue__list");
        expect(list.left).toBeGreaterThanOrEqual(0);
        expect(list.right).toBeLessThanOrEqual(phone.width);
        // Text and source on two lines; the source is still there.
        expect(await row(page, "q2").locator(".assistant-queue__origin").isVisible()).toBe(true);
      } finally {
        await close();
      }
    }
  });
});
