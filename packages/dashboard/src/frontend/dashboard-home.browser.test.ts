import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { WidgetResponse, WidgetStreamLine } from "@k2b/cloud/contracts";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import type { DashboardCatalogWidget } from "../shared";
import type { DashboardHomeProps } from "./dashboard-home";

// Whether a widget that answers late, fails, is resized, dragged or added moves another one is a layout result of
// the shipped cascade, so this runs the real dashboard island in a browser against a server that streams invented
// widgets line by line and records what the board saves.

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "dashboard-home.browser-harness.tsx");

const widget = (
  key: string,
  title: string,
  sizes: DashboardCatalogWidget["sizes"],
  defaultSize: DashboardCatalogWidget["defaultSize"],
  suggest: boolean,
): DashboardCatalogWidget => ({
  key,
  appId: key.split("/")[0]!,
  appName: key.split("/")[0]!.replace(/^./, (letter) => letter.toUpperCase()),
  appIcon: "ti ti-box",
  appHref: `/app/${key.split("/")[0]}`,
  title,
  description: `${title}, as a test widget.`,
  sizes,
  defaultSize,
  suggest,
});
const catalog: DashboardCatalogWidget[] = [
  widget("spaces/today", "Today", ["medium", "large"], "large", true),
  widget("notebooks/recent", "Recent notes", ["medium", "large"], "medium", true),
  widget("weather/current", "Weather", ["small", "medium", "large"], "small", true),
  widget("gateway/health", "Platform health", ["small", "medium"], "small", true),
  widget("quotes/quote", "Quote of the hour", ["small", "medium"], "medium", false),
  widget("venue/today", "Venue today", ["small", "medium", "large"], "medium", true),
];
const board = [
  { key: "spaces/today", size: "large" },
  { key: "notebooks/recent", size: "medium" },
  { key: "weather/current", size: "small" },
  { key: "gateway/health", size: "small" },
  { key: "quotes/quote", size: "medium" },
] as const;
const baseProps: DashboardHomeProps = {
  greeting: "Hi, Mara",
  today: "Saturday, October 10",
  apps: [],
  legalLinks: [],
  shortcuts: [{ id: "handbook", kind: "link", title: "Handbook", href: "/handbook", icon: "ti ti-book" }],
  catalog,
  board: [...board],
  // Third on the saved board, between the recent notes and the weather.
  kept: [{ key: "stopped/app", size: "small", index: 2 }],
  followsDefault: false,
};

const list = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `Item ${index + 1}`, sub: "Detail", meta: "today", href: "/app/x" }));
const responses: Record<string, WidgetResponse> = {
  "spaces/today": { title: "Today", meta: "3 open", href: "/app/spaces", blocks: [{ kind: "list", items: list(3), grow: true }] },
  // Longer than its frame: it scrolls inside the widget instead of growing it.
  "notebooks/recent": { title: "Recent notes", blocks: [{ kind: "list", items: list(12), grow: true }] },
  "weather/current": { title: "Weather", blocks: [{ kind: "hero", title: "14°C", subtitle: "Hamburg", icon: "ti ti-sun" }] },
  "gateway/health": { title: "Platform health", blocks: [{ kind: "status", tone: "ok", title: "All apps run" }] },
  "quotes/quote": { title: "Quote of the hour", blocks: [{ kind: "hero", title: "Stay curious.", subtitle: "Ada" }] },
  "venue/today": { title: "Front desk", blocks: [{ kind: "status", tone: "info", title: "Closed now" }] },
};
const ok = (key: string): WidgetStreamLine => ({ type: "widget", key, status: "ok", ms: 5, widget: responses[key]! });

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

type Asked = { key: string; size: string | undefined };
type Answer = (asked: Asked[], write: (line: WidgetStreamLine) => void) => Promise<void>;
const answerAll: Answer = async (asked, write) => {
  for (const { key } of asked) write(responses[key] ? ok(key) : { type: "widget", key, status: "error", ms: 5 });
};
let answer: Answer = answerAll;
let props = baseProps;
const requests: Asked[][] = [];
const saved: unknown[] = [];
/** Holds the answer to a save until the test opens it. */
let saveGate: Promise<void> | undefined;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dashboard harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  const stylesheets = [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/") {
        const lang = url.searchParams.get("lang") ?? "en";
        return new Response(
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root"></div>` +
            `<script>window.dashboardProps = ${JSON.stringify(props)}</script><script src="/harness.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/api/dashboard/settings" && request.method === "PUT") {
        saved.push(await request.json());
        await saveGate;
        return Response.json({ ok: true });
      }
      if (url.pathname !== "/api/widgets/v1") return new Response(null, { status: 404 });
      const asked = url.searchParams.getAll("widget").map((value) => {
        const [key, size] = value.split("@");
        return { key: key!, size };
      });
      requests.push(asked);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (line: WidgetStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          write({ type: "start", widgets: asked.map(({ key }) => key) });
          await answer(asked, write);
          write({ type: "done", status: "partial" });
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const open = async (view: View, options: { lang?: string; props?: DashboardHomeProps } = {}) => {
  props = options.props ?? baseProps;
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${options.lang ?? "en"}`);
  await page.locator(".dashboard-tile").first().waitFor();
  return { page, close: () => context.close() };
};

/** Every widget's box, in document order, and what it shows. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll<HTMLElement>(".dashboard-tile"));
    return {
      boxes: tiles.map((tile) => {
        const rect = tile.getBoundingClientRect();
        return [
          tile.dataset.key,
          Math.round(rect.left),
          Math.round(rect.top + window.scrollY),
          Math.round(rect.width),
          Math.round(rect.height),
        ];
      }),
      states: Object.fromEntries(tiles.map((tile) => [tile.dataset.key, tile.dataset.state])),
      order: tiles.map((tile) => `${tile.dataset.key}:${tile.dataset.size}`),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
const waitForState = (page: Page, key: string, state: string) =>
  page.locator(`.dashboard-tile[data-key="${key}"][data-state="${state}"]`).waitFor();
const allLoaded = async (page: Page) => {
  for (const { key } of board) await waitForState(page, key, "ok");
};
/** Waits until the live region has said `text`. */
const announced = (page: Page, text: string) =>
  page.waitForFunction((expected) => document.querySelector("[data-k2b-live]")?.textContent?.includes(expected), text);
const tile = (page: Page, key: string) => page.locator(`.dashboard-tile[data-key="${key}"]`);
const center = async (page: Page, key: string) => {
  const box = (await tile(page, key).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

describe("the dashboard board in a browser", () => {
  test("streams every widget into its frame in its size; a slow and a failing app move nothing and stay on their own", async () => {
    for (const view of [desktop, phone]) {
      const first = gate();
      const slow = gate();
      const retried = gate();
      answer = async (asked, write) => {
        if (asked.length === 1 && asked[0]!.key === "notebooks/recent") {
          await retried.opened;
          write(ok("notebooks/recent"));
          return;
        }
        await first.opened;
        for (const key of ["weather/current", "spaces/today", "gateway/health"]) write(ok(key));
        write({ type: "widget", key: "notebooks/recent", status: "error", ms: 12 });
        await slow.opened;
        write(ok("quotes/quote"));
      };
      const { page, close } = await open(view);
      try {
        const loading = await layout(page);
        expect(Object.values(loading.states)).toEqual(Array(5).fill("loading"));
        // Each widget is asked in the size the board shows it in.
        expect(requests.at(-1)).toEqual(board.map(({ key, size }) => ({ key, size })));

        first.open();
        await waitForState(page, "notebooks/recent", "error");
        await waitForState(page, "spaces/today", "ok");
        expect(await tile(page, "notebooks/recent").textContent()).toContain("Notebooks could not load this widget.");
        // After three seconds the slow app says so inside its own frame.
        await page.locator('.dashboard-tile[data-key="quotes/quote"] .dashboard-widget-slow[data-shown]').waitFor({ timeout: 4_000 });
        expect(await tile(page, "quotes/quote").textContent()).toContain("Quotes is taking longer than usual.");
        expect({ width: view.width, boxes: (await layout(page)).boxes }).toEqual({ width: view.width, boxes: loading.boxes });

        // Retrying the failed widget while the slow one still loads: the first stream ending must not fail the retry.
        const before = requests.length;
        await tile(page, "notebooks/recent").getByRole("button", { name: "Try again" }).click();
        await waitForState(page, "notebooks/recent", "loading");
        slow.open();
        await waitForState(page, "quotes/quote", "ok");
        expect((await layout(page)).states["notebooks/recent"]).toBe("loading");
        retried.open();
        await waitForState(page, "notebooks/recent", "ok");
        expect(requests.slice(before)).toEqual([[{ key: "notebooks/recent", size: "medium" }]]);
        const done = await layout(page);
        expect(done.boxes).toEqual(loading.boxes);
        expect(done.overflow).toBeLessThanOrEqual(0);
        const scrolls = await tile(page, "notebooks/recent")
          .locator(".k2b-widget-list")
          .evaluate((element) => element.scrollHeight > element.clientHeight);
        expect(scrolls).toBeTrue();
      } finally {
        answer = answerAll;
        await close();
      }
    }
  }, 60_000);

  test("lays the same order out in four columns and, on a phone, in two", async () => {
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view);
      try {
        await allLoaded(page);
        const boxes = Object.fromEntries(
          (await layout(page)).boxes.map(([key, left, top, width, height]) => [key, { left, top, width, height }]),
        );
        const today = boxes["spaces/today"]!;
        const weather = boxes["weather/current"]!;
        const health = boxes["gateway/health"]!;
        const notes = boxes["notebooks/recent"]!;
        // Large is two rows high; small widgets share a row; medium is as wide as two small ones.
        expect(today.height).toBeGreaterThan(2 * notes.height);
        expect(weather.top).toBe(health.top);
        expect(weather.width).toBe(health.width);
        expect(Math.abs(notes.width - (2 * weather.width + (health.left - weather.left - weather.width)))).toBeLessThanOrEqual(1);
        if (view === phone) {
          // Medium and large take the full width, small half of it.
          expect(today.width).toBe(notes.width);
          expect(weather.width).toBeLessThan(notes.width / 2);
          expect(notes.top).toBeGreaterThan(today.top);
        } else {
          // Large and medium side by side on four columns.
          expect(notes.top).toBe(today.top);
        }
        expect((await layout(page)).overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 30_000);

  test("the edit mode moves nothing, moves and removes widgets by keyboard, resizes them, and saves without a reload", async () => {
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view);
      try {
        await allLoaded(page);
        await page.evaluate(() => Object.assign(window, { sameDocument: true }));
        const before = await layout(page);
        await page.getByRole("button", { name: "Edit dashboard" }).click();
        await page.locator(".dashboard-tile__remove").first().waitFor();
        // Entering the edit mode adds controls over the widgets and the reserved hint line, nothing in between.
        expect((await layout(page)).boxes).toEqual(before.boxes);
        // WebKit may report the hint's previous style for a moment, so this waits for the painted one.
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".dashboard-edit-hint")!).visibility === "visible");
        // Widget content cannot be used while editing.
        expect(
          await tile(page, "spaces/today")
            .locator(".dashboard-tile__frame")
            .evaluate((frame) => (frame as HTMLElement).inert),
        ).toBeTrue();

        await tile(page, "spaces/today").focus();
        await page.keyboard.press("ArrowRight");
        expect((await layout(page)).order.slice(0, 2)).toEqual(["notebooks/recent:medium", "spaces/today:large"]);
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("spaces/today");
        await announced(page, "Today at position 2 of 5");
        await page.keyboard.press("ArrowLeft");
        expect((await layout(page)).order[0]).toBe("spaces/today:large");

        await tile(page, "quotes/quote").focus();
        await page.keyboard.press("Delete");
        expect((await layout(page)).order).not.toContain("quotes/quote:medium");
        await announced(page, "Quote of the hour removed");

        const asked = requests.length;
        await tile(page, "weather/current").getByRole("radio", { name: "Medium" }).click();
        await page.locator('.dashboard-tile[data-key="weather/current"][data-size="medium"]').waitFor();
        expect(requests.slice(asked)).toEqual([[{ key: "weather/current", size: "medium" }]]);
        // The old content stays while the widget answers in its new size.
        expect((await layout(page)).states["weather/current"]).toBe("ok");

        await page.getByRole("button", { name: "Done" }).click();
        await page.locator(".dashboard-tile__remove").first().waitFor({ state: "detached" });
        expect(saved.at(-1)).toEqual({
          shortcuts: baseProps.shortcuts,
          board: [
            { key: "spaces/today", size: "large" },
            { key: "notebooks/recent", size: "medium" },
            // A widget the page could not show keeps its place on the saved board.
            { key: "stopped/app", size: "small" },
            { key: "weather/current", size: "medium" },
            { key: "gateway/health", size: "small" },
          ],
        });
        // Done went away with the edit mode and handed the focus back to Edit.
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Edit dashboard");
        expect(await page.evaluate(() => "sameDocument" in window)).toBeTrue();
        await announced(page, "Dashboard saved");
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("Cancel restores the board, and Default makes the person follow the default board again", async () => {
    const { page, close } = await open(desktop);
    try {
      await allLoaded(page);
      const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
      // By keyboard, Edit hands the focus to Done, which takes its place.
      await page.getByRole("button", { name: "Edit dashboard" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Done" }).waitFor();
      expect(await focused()).toBe("Done");
      await tile(page, "quotes/quote").getByRole("button", { name: "Remove Quote of the hour" }).click();
      await page.getByRole("button", { name: "Remove Handbook" }).click();
      await page.getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
      expect((await layout(page)).order).toEqual(board.map(({ key, size }) => `${key}:${size}`));
      await page.getByRole("link", { name: "Handbook" }).waitFor();
      expect(await focused()).toBe("Edit");

      const saves = saved.length;
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await page.getByRole("button", { name: "Default", exact: true }).click();
      // Suggested widgets in their default sizes, large first; venue/today is new and asked at once.
      expect((await layout(page)).order).toEqual([
        "spaces/today:large",
        "notebooks/recent:medium",
        "venue/today:medium",
        "weather/current:small",
        "gateway/health:small",
      ]);
      await waitForState(page, "venue/today", "ok");
      // While Done saves, the board cannot change, so what is saved is what stays on screen.
      const held = gate();
      saveGate = held.opened;
      await page.getByRole("button", { name: "Done" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".dashboard-tile__remove")?.disabled === true);
      await tile(page, "spaces/today").focus();
      await page.keyboard.press("Delete");
      expect((await layout(page)).order[0]).toBe("spaces/today:large");
      held.open();
      saveGate = undefined;
      await page.locator(".dashboard-tile__remove").first().waitFor({ state: "detached" });
      expect(saved.slice(saves)).toEqual([{ shortcuts: baseProps.shortcuts, board: null }]);

      // The default board keeps no unavailable widgets, so the next board saved starts without them.
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await tile(page, "spaces/today").focus();
      await page.keyboard.press("ArrowRight");
      await page.getByRole("button", { name: "Done" }).click();
      await page.locator(".dashboard-tile__remove").first().waitFor({ state: "detached" });
      expect(saved.at(-1)).toEqual({
        shortcuts: baseProps.shortcuts,
        board: [
          { key: "notebooks/recent", size: "medium" },
          { key: "spaces/today", size: "large" },
          { key: "venue/today", size: "medium" },
          { key: "weather/current", size: "small" },
          { key: "gateway/health", size: "small" },
        ],
      });
    } finally {
      await close();
    }
  }, 30_000);

  test("drags a widget with the mouse; the others make room", async () => {
    const { page, close } = await open(desktop);
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const from = await center(page, "gateway/health");
      const to = await center(page, "spaces/today");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y - 20, { steps: 4 });
      await page.locator(".dashboard-tile-ghost").waitFor();
      expect(await tile(page, "gateway/health").getAttribute("data-dragging")).toBe("true");
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
      await page.locator(".dashboard-tile-ghost").waitFor({ state: "detached" });
      expect((await layout(page)).order[0]).toBe("gateway/health:small");
      await announced(page, "Platform health at position 1 of 5");
    } finally {
      await close();
    }
  }, 30_000);

  // Mobile WebKit takes no synthetic touch input, so touch is checked in Chromium.
  test.skipIf(browserName !== "chromium")(
    "on a phone a long press opens the edit mode, a held finger drags, and a swipe still scrolls",
    async () => {
      const { page, close } = await open(phone);
      try {
        await allLoaded(page);
        const cdp = await page.context().newCDPSession(page);
        const touch = (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) =>
          cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] });

        // A swipe over a widget scrolls the page and opens nothing.
        let point = await center(page, "spaces/today");
        await touch("touchStart", point.x, point.y);
        for (let step = 1; step <= 8; step += 1) await touch("touchMove", point.x, point.y - step * 20);
        await touch("touchEnd");
        await page.waitForFunction(() => window.scrollY > 0);
        expect(await page.locator(".dashboard-tile__remove").count()).toBe(0);
        // The swipe flings the page on; only once it rests does a point measured now stay on the widget it names.
        await page.waitForFunction(
          () =>
            new Promise<boolean>((resolve) => {
              const y = window.scrollY;
              setTimeout(() => resolve(window.scrollY === y), 150);
            }),
        );
        await page.evaluate(() => window.scrollTo(0, 0));

        // A long press opens the edit mode.
        point = await center(page, "weather/current");
        await touch("touchStart", point.x, point.y);
        await page.waitForTimeout(700);
        await page.locator(".dashboard-tile__remove").first().waitFor();
        await touch("touchEnd");
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("weather/current");

        // Hold briefly, then drag the weather widget in front of the recent notes. The widget is held above its size
        // choice, which takes a press of its own.
        const box = (await tile(page, "weather/current").boundingBox())!;
        point = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
        const target = await center(page, "notebooks/recent");
        await touch("touchStart", point.x, point.y);
        await page.waitForTimeout(350);
        for (let step = 1; step <= 10; step += 1)
          await touch("touchMove", point.x + ((target.x - point.x) * step) / 10, point.y + ((target.y - point.y) * step) / 10);
        await touch("touchEnd");
        expect((await layout(page)).order.slice(0, 3)).toEqual(["spaces/today:large", "weather/current:small", "notebooks/recent:medium"]);

        // In the edit mode, a quick swipe still scrolls instead of picking a widget up.
        point = await center(page, "notebooks/recent");
        await touch("touchStart", point.x, point.y);
        for (let step = 1; step <= 8; step += 1) await touch("touchMove", point.x, point.y - step * 20);
        await touch("touchEnd");
        await page.waitForFunction(() => window.scrollY > 0);
        expect(await page.locator(".dashboard-tile-ghost").count()).toBe(0);
        await cdp.detach();
      } finally {
        await close();
      }
    },
    30_000,
  );

  test("the gallery suggests, groups by app, previews in the chosen size, and adds at the end", async () => {
    for (const view of [desktop, phone]) {
      const { page, close } = await open(view, {
        props: { ...baseProps, board: baseProps.board.filter(({ key }) => key !== "weather/current") },
      });
      try {
        await waitForState(page, "spaces/today", "ok");
        await page.getByRole("button", { name: "Edit dashboard" }).click();
        await page.getByRole("button", { name: "Add widget" }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Suggested for you").waitFor();
        if (view === phone) expect(await page.locator(".k2b-bottom-sheet-frame").count()).toBe(1);
        // Suggested and not yet on the board: weather and venue. Everything else is listed under its app.
        const suggested = dialog.getByRole("region", { name: "Suggested for you" });
        expect(
          await suggested.locator(".dashboard-gallery-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-key"))),
        ).toEqual(["weather/current", "venue/today"]);
        await dialog.getByRole("region", { name: "Quotes" }).getByRole("button", { name: "On the board" }).waitFor();

        const card = dialog.locator('.dashboard-gallery-card[data-key="weather/current"]');
        await card.locator('.k2b-widget[data-size="fill"]').getByText("14°C").waitFor();
        if (view === phone) {
          const heights = await card
            .locator(".k2b-segmented-control__option")
            .evaluateAll((options) => options.map((option) => Math.round(option.getBoundingClientRect().height)));
          expect(heights).toEqual([44, 44, 44]);
        }
        expect(requests.flat()).toContainEqual({ key: "weather/current", size: "small" });
        await card.getByRole("radio", { name: "Medium" }).click();
        for (
          let tries = 0;
          tries < 50 && !requests.flat().some((asked) => asked.key === "weather/current" && asked.size === "medium");
          tries += 1
        )
          await Bun.sleep(20);
        expect(requests.flat()).toContainEqual({ key: "weather/current", size: "medium" });

        await card.getByRole("button", { name: "Add Weather" }).click();
        await dialog.waitFor({ state: "detached" });
        const added = tile(page, "weather/current");
        await added.waitFor();
        expect((await layout(page)).order.at(-1)).toBe("weather/current:medium");
        expect(await added.getAttribute("data-fresh")).toBe("true");
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("weather/current");
        await announced(page, "Weather added, position 5 of 5");
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("entering and leaving the edit mode moves nothing when the shortcuts fill their row or there are none", async () => {
    const shortcuts = (count: number): DashboardHomeProps["shortcuts"] =>
      Array.from({ length: count }, (_, index) => ({
        id: `shortcut-${index}`,
        kind: "link",
        title: `Shortcut ${index + 1}`,
        href: "/handbook",
        icon: "ti ti-link",
      }));
    // Ten shortcuts fill a row at 1024px, so an add button that only appeared while editing would start a second one.
    const cases = [
      { view: { width: 1024, height: 900, touch: false }, count: 10 },
      { view: phone, count: 0 },
    ];
    for (const { view, count } of cases) {
      const { page, close } = await open(view, { props: { ...baseProps, shortcuts: shortcuts(count) } });
      try {
        await allLoaded(page);
        const before = (await layout(page)).boxes;
        await page.getByRole("button", { name: "Edit dashboard" }).click();
        await page.locator(".dashboard-shortcut-add[data-shown]").waitFor();
        expect({ width: view.width, boxes: (await layout(page)).boxes }).toEqual({ width: view.width, boxes: before });
        await page.getByRole("button", { name: "Cancel" }).click();
        await page.locator(".dashboard-tile__remove").first().waitFor({ state: "detached" });
        expect({ width: view.width, boxes: (await layout(page)).boxes }).toEqual({ width: view.width, boxes: before });
        // Outside the edit mode the reserved button can be neither seen nor reached.
        expect(await page.getByRole("button", { name: "Shortcut", exact: true }).count()).toBe(0);
      } finally {
        await close();
      }
    }
  }, 30_000);

  test("on a 320px phone every size choice stays inside its widget, with full labels and 44px targets", async () => {
    const { page, close } = await open(
      { width: 320, height: 640, touch: true },
      {
        props: {
          ...baseProps,
          board: [
            { key: "weather/current", size: "small" },
            { key: "venue/today", size: "small" },
            { key: "spaces/today", size: "large" },
          ],
          kept: [],
        },
      },
    );
    try {
      await waitForState(page, "weather/current", "ok");
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await page.locator(".dashboard-tile__sizes").first().waitFor();
      const controls = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".dashboard-tile")).map((tile) => {
          const box = tile.getBoundingClientRect();
          const control = tile.querySelector(".dashboard-tile__sizes .k2b-segmented-control")!.getBoundingClientRect();
          const options = Array.from(tile.querySelectorAll<HTMLElement>(".dashboard-tile__sizes .k2b-segmented-control__option"));
          return {
            key: tile.dataset.key,
            inside: control.left >= box.left && control.right <= box.right,
            heights: options.map((option) => Math.round(option.getBoundingClientRect().height)),
            cut: options.filter((option) => option.querySelector("span")!.scrollWidth > option.querySelector("span")!.clientWidth).length,
          };
        }),
      );
      expect(controls).toEqual([
        { key: "weather/current", inside: true, heights: [44, 44, 44], cut: 0 },
        { key: "venue/today", inside: true, heights: [44, 44, 44], cut: 0 },
        { key: "spaces/today", inside: true, heights: [44, 44], cut: 0 },
      ]);
      const bar = await page
        .locator(".dashboard-edit-bar .k2b-button")
        .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
      expect(bar).toEqual([44, 44, 44]);
    } finally {
      await close();
    }
  }, 30_000);

  test("adding stops at the board's and the shortcuts' limits with a message, counting widgets it cannot show", async () => {
    const many = Array.from({ length: 99 }, (_, index) => widget(`bulk/w${index}`, `Widget ${index + 1}`, ["small"], "small", false));
    const { page, close } = await open(desktop, {
      props: {
        ...baseProps,
        shortcuts: Array.from({ length: 50 }, (_, index) => ({
          id: `shortcut-${index}`,
          kind: "link" as const,
          title: `S${index + 1}`,
          href: "/handbook",
          icon: "ti ti-link",
        })),
        catalog: [...catalog, ...many],
        board: many.map(({ key }) => ({ key, size: "small" as const })),
        // 99 shown and one the page cannot show make a full board.
        kept: [{ key: "stopped/app", size: "small", index: 0 }],
      },
    });
    try {
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await page.getByRole("button", { name: "Add widget" }).first().click();
      await page.getByText("The board holds up to 100 widgets. Remove one to add another.").waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);

      await page.getByRole("button", { name: "Shortcut", exact: true }).click();
      await page.getByText("You can keep up to 50 shortcuts. Remove one to add another.").waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  test("speaks German", async () => {
    const { page, close } = await open(phone, { lang: "de" });
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Dashboard bearbeiten" }).click();
      await page.getByRole("button", { name: "Fertig" }).waitFor();
      expect(await page.locator(".dashboard-edit-hint").textContent()).toContain("Halten und ziehen verschiebt");
      await tile(page, "weather/current").getByRole("radio", { name: "Mittel" }).waitFor();
      await page.getByRole("button", { name: "Abbrechen" }).click();
    } finally {
      await close();
    }
  }, 30_000);
});
