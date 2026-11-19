import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiWakeup } from "@k2b/cloud/ai";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

// Gustav's alarms above the field (Gustav alarms v1, F1 A) are layout first: their row lies on the timeline's free end
// like "Queued", alone or as a chip beside "Queued" and "Waiting for you", so it never moves the field or the
// conversation; the list floats over the row. The clock of the page is frozen, so "Heute" stays today.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "wakeup-dock.browser-entry.tsx");
const entrySource = `
import { LocaleProvider } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import AssistantQueue from ${JSON.stringify(resolve(import.meta.dir, "AssistantQueue.tsx"))};
import { AssistantWaitingStrip } from ${JSON.stringify(resolve(import.meta.dir, "AssistantWaitingStrip.tsx"))};
import AssistantWakeupDock from ${JSON.stringify(resolve(import.meta.dir, "wakeup-dock.tsx"))};

const [items, setItems] = createSignal(window.harness.items);
const [queued, setQueued] = createSignal(false);
const [waiting, setWaiting] = createSignal(false);
window.dock = { setItems, setQueued, setWaiting };
const context = { chatId: () => "chat01", items, limit: () => 5, refresh: async () => undefined, locale: () => "de", timeZone: "Europe/Berlin" };
const view = () => ({
  attention: waiting() ? [{ key: "w1", kind: "routine", short: "Angebot an Lena Vogt senden", open() {} }] : [],
  entries: [],
  more: 0,
  total: waiting() ? 1 : 0,
  onlyHere: null,
});
const entries = () => (queued() ? [{ id: "q1", text: "Und die Kosten für Strom", origin: { kind: "person", id: "u1", name: "Lena Vogt" }, state: "pending", authorIsViewer: true }] : []);
const queue = (layout, end) => (
  <AssistantQueue entries={entries()} layout={layout} sendingId={null} failedIds={new Set()} busy={false} onSendNow={() => {}} onEdit={() => {}} onRemove={() => {}} end={end} />
);
const chip = () => <AssistantWakeupDock context={context} layout="chip" />;
render(
  () => (
    <LocaleProvider locale="de">
      <div class="assistant-chat-layout" style="display:flex;flex-direction:column;height:100vh">
        <div class="k2b-chat-timeline__content" id="timeline" style="flex:1;margin-inline:auto;overflow:auto">
          <p style="margin:0 0 16px">Schick Lena Vogt das Angebot und schau um 16:00, ob sie geantwortet hat.</p>
        </div>
        <div class="assistant-chat-composer" style="padding:0 24px 24px">
          <div class="assistant-chat-composer__column mx-auto flex max-w-3xl flex-col gap-2">
            <Show when={waiting()}>
              <AssistantWaitingStrip view={view()} conversationId="chat01" quiet={false} onJump={() => {}} onShowMore={() => {}}
                queue={<>{queued() ? queue("chip") : null}{items().length ? chip() : null}</>} />
            </Show>
            <Show when={!waiting() && queued()}>{queue("line", items().length ? chip() : undefined)}</Show>
            <Show when={!waiting() && !queued() && items().length > 0}>
              <AssistantWakeupDock context={context} layout="line" />
            </Show>
            <div id="field" style="height:112px;border-radius:16px;border:1px solid var(--k2b-border)"><textarea aria-label="Nachricht" style="width:100%;border:0" /></div>
          </div>
        </div>
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root"),
);
`;

const alarm = (id: string, at: string, note: string, patch: Partial<AiWakeup> = {}): AiWakeup => ({
  id,
  at,
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note,
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 0,
  rhythm: "Einmalig",
  ...patch,
});
const ALARMS: AiWakeup[] = [
  alarm("6f9619ff-8b86-4d11-b42d-00c04fc96401", "2026-11-16T15:00:00.000Z", "Antwort von Lena Vogt prüfen"),
  alarm("6f9619ff-8b86-4d11-b42d-00c04fc96402", "2026-11-17T07:00:00.000Z", "Posteingang Vertrieb zusammenfassen", {
    cron: "0 8 * * 1-5",
    rhythm: "Mo–Fr 08:00",
    endsAt: "2026-12-16T10:00:00.000Z",
  }),
  alarm("6f9619ff-8b86-4d11-b42d-00c04fc96403", "2026-11-19T08:00:00.000Z", "Lieferavis von Spedition Brandt nachfassen"),
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
        name: "assistant-wakeup-dock",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the alarm row harness.");
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

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 780, touch: true };

const open = async (view: View, items: AiWakeup[]) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    locale: "de",
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  // Monday, 16 November 2026, 10:00 in Berlin.
  await page.clock.setFixedTime(new Date("2026-11-16T09:00:00.000Z"));
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.route(`${assets.url.origin}/app`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
        `<body class="k2b-ui" style="margin:0"><div id="root"></div>` +
        `<script>window.harness = ${JSON.stringify({ items }).replace(/</g, "\\u003c")};</script><script src="/harness.js"></script></body></html>`,
    }),
  );
  await page.goto(`${assets.url.origin}/app`);
  await page.locator("#field").waitFor();
  await settled(page);
  return { page, errors, close: () => context.close() };
};

type Box = { top: number; bottom: number; left: number; right: number; height: number };
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
        height: round(rect.height),
      };
    });
const frame = async (page: Page) => ({ field: await box(page, "#field"), timeline: await box(page, "#timeline") });
type Dock = { setItems: (value: unknown) => void; setQueued: (value: boolean) => void; setWaiting: (value: boolean) => void };
const dock = (page: Page, change: { items?: AiWakeup[]; queued?: boolean; waiting?: boolean }) =>
  page.evaluate((next) => {
    const harness = (window as unknown as { dock: Dock }).dock;
    if (next.items) harness.setItems(next.items);
    if (next.queued !== undefined) harness.setQueued(next.queued);
    if (next.waiting !== undefined) harness.setWaiting(next.waiting);
  }, change);

describe("alarms above the field", () => {
  test("the row comes, counts, shares its row with Queued and Waiting for you, and goes without moving anything", async () => {
    const { page, errors, close } = await open(desktop, []);
    try {
      const before = await frame(page);
      expect(await page.locator(".assistant-wakeups").count()).toBe(0);
      await dock(page, { items: ALARMS.slice(0, 1) });
      await settled(page);
      expect(await box(page, ".assistant-wakeups")).toMatchObject({ height: 32 });
      expect((await page.locator(".assistant-wakeups").innerText()).replace(/\s+/g, " ")).toContain(
        "Wecker Heute 16:00 Antwort von Lena Vogt prüfen",
      );
      expect(await frame(page)).toEqual(before);
      await dock(page, { items: ALARMS.slice(0, 2) });
      await settled(page);
      expect(await page.locator(".assistant-wakeups .assistant-queue__count").innerText()).toBe("+1");
      expect(await frame(page)).toEqual(before);
      // Beside "Queued": the queue keeps its line, the alarms become the chip "Wecker · 2" at its end.
      await dock(page, { queued: true });
      await settled(page);
      expect(await box(page, ".assistant-queue")).toMatchObject({ height: 32 });
      expect((await page.locator(".assistant-queue .assistant-wakeups .assistant-queue__chip").innerText()).replace(/\s+/g, " ")).toContain(
        "Wecker · 2",
      );
      expect(await frame(page)).toEqual(before);
      // With "Waiting for you": one row, both as chips at its end.
      await dock(page, { waiting: true });
      await settled(page);
      expect(await box(page, "nav.assistant-waiting")).toMatchObject({ height: 32 });
      expect(await page.locator("nav.assistant-waiting .assistant-queue__chip").count()).toBe(2);
      expect(await frame(page)).toEqual(before);
      await dock(page, { items: [], queued: false, waiting: false });
      await settled(page);
      expect(await page.locator(".assistant-wakeups").count()).toBe(0);
      expect(await frame(page)).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("the list floats over the row at its full width, counts against the limit, and Escape gives the focus back", async () => {
    const { page, errors, close } = await open(desktop, ALARMS);
    try {
      const before = await frame(page);
      const toggle = page.getByRole("button", { name: "Alle 3 Wecker zeigen" });
      await toggle.click();
      await page.locator(".assistant-wakeups__list").waitFor();
      await settled(page);
      const row = await box(page, ".assistant-wakeups");
      const list = await box(page, ".assistant-wakeups__list");
      expect([list.left, list.right]).toEqual([row.left, row.right]);
      expect(list.bottom).toBeLessThanOrEqual(row.top);
      expect(await frame(page)).toEqual(before);
      expect((await page.locator(".assistant-wakeups__list .assistant-queue__list-head").innerText()).replace(/\s+/g, " ")).toContain(
        "Wecker · 3 von 5",
      );
      // Times stand in one fixed column, the repeating alarm by its rhythm.
      const times = await page
        .locator(".assistant-wakeups__list .assistant-wakeups__when")
        .evaluateAll((cells) =>
          cells.map((cell) => [
            cell.textContent,
            Math.round(cell.getBoundingClientRect().left),
            Math.round(cell.getBoundingClientRect().width),
          ]),
        );
      expect(times.map(([text]) => text)).toEqual(["Heute 16:00", "Mo–Fr 08:00", "Do., 19.11. 09:00"]);
      expect(new Set(times.map(([, left, width]) => `${left}/${width}`)).size).toBe(1);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator(".assistant-wakeups__list").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Alle 3 Wecker zeigen");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("on a phone the signs always show and time and note stand on two lines", async () => {
    const { page, close } = await open(phone, ALARMS);
    try {
      await page.getByRole("button", { name: "Alle 3 Wecker zeigen" }).click();
      await page.locator(".assistant-wakeups__list").waitFor();
      await settled(page);
      const rows = await page.locator(".assistant-wakeups__row").evaluateAll((list) =>
        list.map((element) => {
          const when = element.querySelector(".assistant-wakeups__when")!.getBoundingClientRect();
          const note = element.querySelector(".assistant-queue__text")!.getBoundingClientRect();
          return {
            below: note.top >= when.bottom - 1,
            signs: Number(getComputedStyle(element.querySelector(".assistant-wakeups__actions")!).opacity),
          };
        }),
      );
      expect(rows).toEqual(ALARMS.map(() => ({ below: true, signs: 1 })));
    } finally {
      await close();
    }
  });
});
