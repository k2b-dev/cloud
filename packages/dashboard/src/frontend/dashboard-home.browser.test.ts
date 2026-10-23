import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { WidgetResponse, WidgetStreamLine } from "@k2b/cloud/contracts";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import type { DashboardBoardEntry, DashboardCatalogWidget, DashboardSettings } from "../shared";
import { builtInWidgets } from "./built-in-widgets.browser-fixture";
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
  {
    ...widget("spaces/today", "Today", ["medium", "large"], "large", true),
    settings: {
      space: { kind: "resource", label: "Space", type: "spaces.space" },
      done: { kind: "toggle", label: "Show done" },
      note: { kind: "text", label: "Note", maxLength: 40 },
    },
  },
  widget("notebooks/recent", "Recent notes", ["medium", "large"], "medium", true),
  {
    ...widget("weather/current", "Weather", ["small", "medium", "large"], "small", true),
    settings: {
      place: {
        kind: "choice",
        label: "Place",
        options: [
          { label: "Hamburg", value: "hamburg" },
          { label: "Berlin", value: "berlin" },
        ],
        default: "hamburg",
      },
    },
  },
  widget("gateway/health", "Platform health", ["small", "medium"], "small", true),
  widget("quotes/quote", "Quote of the hour", ["small", "medium"], "medium", false),
  widget("venue/today", "Venue today", ["small", "medium", "large"], "medium", true),
];

const board = [
  { id: "spaces/today", key: "spaces/today", size: "large" },
  { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
  { id: "weather/current", key: "weather/current", size: "small" },
  { id: "gateway/health", key: "gateway/health", size: "small" },
  { id: "quotes/quote", key: "quotes/quote", size: "medium" },
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
  kept: [{ id: "stopped/app", key: "stopped/app", size: "small", index: 2 }],
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
const ok = (entry: Asked): WidgetStreamLine => ({
  type: "widget",
  id: entry.id,
  key: entry.key,
  status: "ok",
  ms: 5,
  widget: { ...responses[entry.key]!, ...(entry.settings?.place ? { title: `Weather ${entry.settings.place}` } : {}) },
});

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

type Asked = DashboardBoardEntry;
type Answer = (asked: Asked[], write: (line: WidgetStreamLine) => void) => Promise<void>;
const answerAll: Answer = async (asked, write) => {
  for (const entry of asked)
    write(responses[entry.key] ? ok(entry) : { type: "widget", id: entry.id, key: entry.key, status: "error", ms: 5 });
};
let answer: Answer = answerAll;
let props = baseProps;
/**
 * The widget requests in the order they arrived. The page changes before its fetch reaches this server, so a test never
 * reads the newest one: it notes `requests.count` before a step and awaits the request that step causes with
 * `requests.next(count)`.
 */
const requests = (() => {
  const recorded: Asked[][] = [];
  const waiters = new Set<(asked: Asked[], index: number) => void>();
  return {
    get count() {
      return recorded.length;
    },
    push(asked: Asked[]) {
      const index = recorded.length;
      recorded.push(asked);
      for (const waiter of waiters) waiter(asked, index);
    },
    next(from: number, matches: (asked: Asked[]) => boolean = () => true): Promise<Asked[]> {
      const arrived = recorded.slice(from).find(matches);
      if (arrived) return Promise.resolve(arrived);
      return new Promise((resolve, reject) => {
        const waiter = (asked: Asked[], index: number) => {
          if (index < from || !matches(asked)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(asked);
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for requests.next(${from}); arrived since ${from}: ${JSON.stringify(recorded.slice(from))}`));
        }, 5_000);
        waiters.add(waiter);
      });
    },
  };
})();
const saved: DashboardSettings[] = [];
const scripts: string[] = [];
/** Holds the answer to a save until the test opens it. */
let saveGate: Promise<void> | undefined;

let settingsChunkPath: string;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    splitting: true,
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
  const assets = new Map(
    await Promise.all(
      build.outputs.map(async (output) => [new URL(output.path, "http://harness.test/").pathname, await output.text()] as const),
    ),
  );
  settingsChunkPath = [...assets].find(([path, text]) => path.endsWith(".js") && text.includes("dashboard-widget-settings__reset"))![0];
  const entryPath = new URL(build.outputs.find((output) => output.kind === "entry-point")!.path, "http://harness.test/").pathname;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  const stylesheets = [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  // The fonts Core serves: text wraps and icons take their height as on a real page.
  const uiDist = resolve(ui, "dist");
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)![0];
  const fonts = [
    (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/fonts/"),
    icons.replace(/\.\/tabler-icons-[\w-]+\.woff2/, `/${iconFont}`),
  ];
  const css = ["@layer properties, theme, base, components, utilities;", ...fonts, ...outputs].join("\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const script = assets.get(url.pathname);
      if (script !== undefined) {
        scripts.push(url.pathname);
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname.startsWith("/fonts/") || url.pathname === `/${iconFont}`)
        return new Response(Bun.file(resolve(uiDist, url.pathname.slice(1))), { headers: { "content-type": "font/woff2" } });
      if (url.pathname === "/") {
        const lang = url.searchParams.get("lang") ?? "en";
        return new Response(
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root"></div>` +
            `<script>window.dashboardProps = ${JSON.stringify(props)}</script><script type="module" src="${entryPath}"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/api/dashboard/settings" && request.method === "PUT") {
        saved.push(await request.json());
        await saveGate;
        return Response.json({ ok: true });
      }
      if (url.pathname !== "/api/widgets/v1" || request.method !== "POST") return new Response(null, { status: 404 });
      const asked = ((await request.json()) as { widgets: Asked[] }).widgets;
      requests.push(asked);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (line: WidgetStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          write({ type: "start", widgets: asked.map(({ id }) => id) });
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

const open = async (view: View, options: { lang?: string; props?: DashboardHomeProps; engine?: Browser } = {}) => {
  props = options.props ?? baseProps;
  const context = await (options.engine ?? browser).newContext({
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
          tile.dataset.id,
          Math.round(rect.left),
          Math.round(rect.top + window.scrollY),
          Math.round(rect.width),
          Math.round(rect.height),
        ];
      }),
      states: Object.fromEntries(tiles.map((tile) => [tile.dataset.id, tile.dataset.state])),
      order: tiles.map((tile) => `${tile.dataset.id}:${tile.dataset.size}`),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
const waitForState = (page: Page, id: string, state: string) =>
  page.locator(`.dashboard-tile[data-id="${id}"][data-state="${state}"]`).waitFor();
const allLoaded = async (page: Page) => {
  for (const { id } of board) await waitForState(page, id, "ok");
};
/** Waits until the live region has said `text`. */
const announced = (page: Page, text: string) =>
  page.waitForFunction((expected) => document.querySelector("[data-k2b-live]")?.textContent?.includes(expected), text);
const tile = (page: Page, id: string) => page.locator(`.dashboard-tile[data-id="${id}"]`);
const center = async (page: Page, id: string) => {
  const box = (await tile(page, id).boundingBox())!;
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
          write(ok(asked.find((entry) => entry.key === "notebooks/recent")!));
          return;
        }
        await first.opened;
        for (const key of ["weather/current", "spaces/today", "gateway/health"]) write(ok(asked.find((entry) => entry.key === key)!));
        write({
          type: "widget",
          id: asked.find((entry) => entry.key === "notebooks/recent")!.id,
          key: "notebooks/recent",
          status: "error",
          ms: 12,
        });
        await slow.opened;
        write(ok(asked.find((entry) => entry.key === "quotes/quote")!));
      };
      const count = requests.count;
      const { page, close } = await open(view);
      try {
        const loading = await layout(page);
        expect(Object.values(loading.states)).toEqual(Array(5).fill("loading"));
        // Each widget is asked in the size the board shows it in.
        expect(await requests.next(count)).toEqual(board.map(({ id, key, size }) => ({ id, key, size })));

        first.open();
        await waitForState(page, "notebooks/recent", "error");
        await waitForState(page, "spaces/today", "ok");
        expect(await tile(page, "notebooks/recent").textContent()).toContain("Notebooks could not load this widget.");
        // After three seconds the slow app says so inside its own frame.
        await page.locator('.dashboard-tile[data-id="quotes/quote"] .dashboard-widget-slow[data-shown]').waitFor({ timeout: 4_000 });
        expect(await tile(page, "quotes/quote").textContent()).toContain("Quotes is taking longer than usual.");
        expect({ width: view.width, boxes: (await layout(page)).boxes }).toEqual({ width: view.width, boxes: loading.boxes });

        // Retrying the failed widget while the slow one still loads: the first stream ending must not fail the retry.
        const before = requests.count;
        await tile(page, "notebooks/recent").getByRole("button", { name: "Try again" }).click();
        await waitForState(page, "notebooks/recent", "loading");
        slow.open();
        await waitForState(page, "quotes/quote", "ok");
        expect((await layout(page)).states["notebooks/recent"]).toBe("loading");
        retried.open();
        await waitForState(page, "notebooks/recent", "ok");
        expect(await requests.next(before)).toEqual([{ id: "notebooks/recent", key: "notebooks/recent", size: "medium" }]);
        expect(requests.count).toBe(before + 1);
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
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe("spaces/today");
        await announced(page, "Today at position 2 of 5");
        await page.keyboard.press("ArrowLeft");
        expect((await layout(page)).order[0]).toBe("spaces/today:large");

        await tile(page, "quotes/quote").focus();
        await page.keyboard.press("Delete");
        expect((await layout(page)).order).not.toContain("quotes/quote:medium");
        await announced(page, "Quote of the hour removed");

        const asked = requests.count;
        await tile(page, "weather/current").getByRole("radio", { name: "Medium" }).click();
        await page.locator('.dashboard-tile[data-id="weather/current"][data-size="medium"]').waitFor();
        expect(await requests.next(asked)).toEqual([{ id: "weather/current", key: "weather/current", size: "medium" }]);
        expect(requests.count).toBe(asked + 1);
        // The old content stays while the widget answers in its new size.
        expect((await layout(page)).states["weather/current"]).toBe("ok");

        await page.getByRole("button", { name: "Done" }).click();
        await page.locator(".dashboard-tile__remove").first().waitFor({ state: "detached" });
        expect(saved.at(-1)).toEqual({
          shortcuts: baseProps.shortcuts,
          board: [
            { id: "spaces/today", key: "spaces/today", size: "large" },
            { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
            // A widget the page could not show keeps its place on the saved board.
            { id: "stopped/app", key: "stopped/app", size: "small" },
            { id: "weather/current", key: "weather/current", size: "medium" },
            { id: "gateway/health", key: "gateway/health", size: "small" },
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
          { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
          { id: "spaces/today", key: "spaces/today", size: "large" },
          { id: "venue/today", key: "venue/today", size: "medium" },
          { id: "weather/current", key: "weather/current", size: "small" },
          { id: "gateway/health", key: "gateway/health", size: "small" },
        ],
      });
    } finally {
      await close();
    }
  }, 30_000);

  test("drags a widget with the mouse without selecting page text; the others make room", async () => {
    const { page, close } = await open(desktop);
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      // iPadOS selects through `-webkit-user-select` alone, so the greeting the widget sweeps across reports that one.
      const greetingSelect = () =>
        page
          .locator("h1", { hasText: "Hi, Mara" })
          .evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-user-select"));
      const before = await greetingSelect();
      const from = await center(page, "gateway/health");
      const to = await center(page, "spaces/today");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y - 20, { steps: 4 });
      await page.locator(".dashboard-tile-ghost").waitFor();
      expect(await tile(page, "gateway/health").getAttribute("data-dragging")).toBe("true");
      expect(await greetingSelect()).toBe("none");
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
      await page.locator(".dashboard-tile-ghost").waitFor({ state: "detached" });
      expect(await greetingSelect()).toBe(before);
      expect(before).not.toBe("none");
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
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe("weather/current");

        // Hold briefly, then drag the weather widget in front of the recent notes. The widget is held by its head, above
        // its move buttons and its size choice, which take presses of their own.
        const box = (await tile(page, "weather/current").boundingBox())!;
        point = { x: box.x + box.width / 2, y: box.y + box.height / 6 };
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
        const count = requests.count;
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
        await requests.next(count, (asked) => asked.some((entry) => entry.key === "weather/current" && entry.size === "small"));
        const medium = requests.count;
        await card.getByRole("radio", { name: "Medium" }).click();
        await requests.next(medium, (asked) => asked.some((entry) => entry.key === "weather/current" && entry.size === "medium"));

        await card.getByRole("button", { name: "Add Weather" }).click();
        await dialog.waitFor({ state: "detached" });
        const added = tile(page, "weather/current");
        await added.waitFor();
        expect((await layout(page)).order.at(-1)).toBe("weather/current:medium");
        expect(await added.getAttribute("data-fresh")).toBe("true");
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe("weather/current");
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
            { id: "weather/current", key: "weather/current", size: "small" },
            { id: "venue/today", key: "venue/today", size: "small" },
            { id: "spaces/today", key: "spaces/today", size: "large" },
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
            key: tile.dataset.id,
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
        board: many.map(({ key }) => ({ id: key, key, size: "small" as const })),
        // 99 shown and one the page cannot show make a full board.
        kept: [{ id: "stopped/app", key: "stopped/app", size: "small", index: 0 }],
      },
    });
    try {
      // The live region repeats a toast's text for a moment, so the toast is looked up in its own region.
      const toasts = page.getByRole("region", { name: "Notifications" });
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await page.getByRole("button", { name: "Add widget" }).first().click();
      await toasts.getByText("The board holds up to 100 widgets. Remove one to add another.").waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);

      await page.getByRole("button", { name: "Shortcut", exact: true }).click();
      await toasts.getByText("You can keep up to 50 shortcuts. Remove one to add another.").waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  test("Customize loads on demand, reloads quietly, saves values for a reload, and Cancel restores them", async () => {
    const first = gate();
    const entered = gate();
    const scriptStart = scripts.length;
    answer = async (asked, write) => {
      if (asked.some((entry) => entry.settings?.place === "berlin")) {
        entered.open();
        await first.opened;
      }
      await answerAll(asked, write);
    };
    const { page, close } = await open(desktop);
    try {
      await allLoaded(page);
      const initialScripts = scripts.slice(scriptStart);
      expect(initialScripts).not.toContain(settingsChunkPath);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const weather = tile(page, "weather/current");
      expect(await tile(page, "gateway/health").locator(".dashboard-tile__customize").count()).toBe(0);
      const before = (await layout(page)).boxes;
      await weather.getByRole("button", { name: "Customize Weather" }).click();
      const dialog = page.getByRole("dialog", { name: "Customize Weather" });
      await dialog.getByRole("radio", { name: "Hamburg" }).waitFor();
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .filter((animation) => animation.timeline === document.timeline)
          .every((animation) => animation.playState !== "running"),
      );
      expect(await dialog.getAttribute("class")).toContain("k2b-bottom-sheet-frame is-adaptive");
      expect(await dialog.locator(".k2b-bottom-sheet__handle").isVisible()).toBe(false);
      const frame = await dialog.boundingBox();
      const viewport = page.viewportSize()!;
      expect(Math.abs(frame!.x + frame!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame!.y + frame!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);

      expect(scripts.slice(scriptStart)).toContain(settingsChunkPath);
      await dialog.getByRole("radio", { name: "Berlin" }).click();
      const applied = requests.count;
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await entered.opened;
      expect(await requests.next(applied)).toEqual([
        { id: "weather/current", key: "weather/current", size: "small", settings: { place: "berlin" } },
      ]);
      expect(await weather.getAttribute("data-state")).toBe("ok");
      expect(await weather.textContent()).toContain("14°C");
      expect(await weather.textContent()).not.toContain("Weather berlin");
      expect(await weather.locator(".dashboard-tile__customize").evaluate((el) => el === document.activeElement)).toBeTrue();
      expect((await layout(page)).boxes).toEqual(before);
      first.open();
      await weather.getByText("Weather berlin", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Edit dashboard" }).waitFor();
      const savedBoard = saved.at(-1)!.board!;
      expect(savedBoard.find((entry) => entry.id === "weather/current")?.settings).toEqual({ place: "berlin" });
      // The server's next page snapshot carries the saved entry settings.
      props = { ...baseProps, board: savedBoard.filter((entry) => entry.key !== "stopped/app") };
      const reloaded = requests.count;
      await page.reload();
      await tile(page, "weather/current").getByText("Weather berlin", { exact: true }).waitFor();
      expect((await requests.next(reloaded)).find((entry) => entry.id === "weather/current")?.settings).toEqual({ place: "berlin" });
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await weather.getByRole("button", { name: "Customize Weather" }).click();
      await dialog.getByRole("radio", { name: "Hamburg" }).click();
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await weather.getByText("Weather hamburg", { exact: true }).waitFor();
      const cancelled = requests.count;
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await weather.getByText("Weather berlin", { exact: true }).waitFor();
      expect(await requests.next(cancelled)).toEqual([
        { id: "weather/current", key: "weather/current", size: "small", settings: { place: "berlin" } },
      ]);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const after = (await layout(page)).boxes;
      await weather.getByRole("button", { name: "Customize Weather" }).click();
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await weather.locator(".dashboard-tile__customize").evaluate((el) => el === document.activeElement)).toBeTrue();
      expect((await layout(page)).boxes).toEqual(after);
    } finally {
      first.open();
      answer = answerAll;
      await close();
    }
  }, 30_000);

  test("instances of one widget answer, move, resize, and remove independently", async () => {
    const entries: DashboardBoardEntry[] = [
      { id: "weather/current", key: "weather/current", size: "small", settings: { place: "hamburg" } },
      { id: "w2", key: "weather/current", size: "small", settings: { place: "berlin" } },
    ];
    const { page, close } = await open(desktop, { props: { ...baseProps, board: entries, kept: [] } });
    try {
      await tile(page, "weather/current").getByText("Weather hamburg", { exact: true }).waitFor();
      await tile(page, "w2").getByText("Weather berlin", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      // Each entry is named by its chosen option, in its label, its controls, and what is announced.
      expect(await tile(page, "weather/current").getAttribute("aria-label")).toBe("Weather · Hamburg, Weather");
      expect(await tile(page, "w2").getAttribute("aria-label")).toBe("Weather · Berlin, Weather");
      await tile(page, "w2").getByRole("button", { name: "Customize Weather · Berlin", exact: true }).waitFor();
      await tile(page, "w2").getByRole("button", { name: "Move Weather · Berlin forward", exact: true }).click();
      await announced(page, "Weather · Berlin at position 1 of 2");
      expect((await layout(page)).order).toEqual(["w2:small", "weather/current:small"]);
      const resized = requests.count;
      await tile(page, "w2").getByRole("radio", { name: "Medium" }).click();
      await page.waitForFunction(() => document.querySelector('[data-id="w2"]')?.getAttribute("data-size") === "medium");
      expect(await requests.next(resized)).toEqual([{ ...entries[1]!, size: "medium" }]);
      expect(await tile(page, "weather/current").getAttribute("data-size")).toBe("small");
      await tile(page, "w2").getByRole("button", { name: "Remove Weather · Berlin", exact: true }).click();
      await announced(page, "Weather · Berlin removed");
      expect((await layout(page)).order).toEqual(["weather/current:small"]);
      expect(await tile(page, "weather/current").textContent()).toContain("Weather hamburg");
    } finally {
      await close();
    }
  }, 30_000);

  test("Apply without a change keeps a person on the default board", async () => {
    const { page, close } = await open(desktop, {
      props: { ...baseProps, board: [{ id: "weather/current", key: "weather/current", size: "small" }], kept: [], followsDefault: true },
    });
    try {
      await waitForState(page, "weather/current", "ok");
      const asked = requests.count;
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await tile(page, "weather/current").getByRole("button", { name: "Customize Weather", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Customize Weather" });
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      const savedBefore = saved.length;
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Edit dashboard" }).waitFor();
      expect(saved.length).toBe(savedBefore);
      expect(requests.count).toBe(asked);
    } finally {
      await close();
    }
  }, 30_000);

  test("a small widget keeps its head free of the edit controls, and touch screens get 44px targets", async () => {
    const board: DashboardBoardEntry[] = [
      { id: "weather/current", key: "weather/current", size: "small" },
      { id: "gateway/health", key: "gateway/health", size: "small" },
    ];
    for (const view of [
      { width: 800, height: 900, touch: false },
      { width: 820, height: 1180, touch: true },
    ]) {
      const { page, close } = await open(view, { props: { ...baseProps, board, kept: [] } });
      try {
        await waitForState(page, "weather/current", "ok");
        await page.getByRole("button", { name: "Edit dashboard" }).click();
        const result = await page.locator(".dashboard-tile").evaluateAll((tiles) =>
          tiles.map((tile) => {
            const head = tile.querySelector(".k2b-widget > *")!.getBoundingClientRect();
            const tools = tile.querySelector(".dashboard-tile__tools")!.getBoundingClientRect();
            const sizes = tile.querySelector(".dashboard-tile__sizes .k2b-segmented-control")!.getBoundingClientRect();
            const buttons = Array.from(tile.querySelectorAll(".dashboard-tile__tools button")).map((button) => {
              const box = button.getBoundingClientRect();
              return Math.min(box.width, box.height);
            });
            return { coversHead: tools.top < head.bottom, overlapsSizes: tools.bottom > sizes.top, smallest: Math.min(...buttons) };
          }),
        );
        for (const tile of result) {
          expect(tile.coversHead).toBeFalse();
          expect(tile.overlapsSizes).toBeFalse();
          if (view.touch) expect(tile.smallest).toBeGreaterThanOrEqual(44);
        }
      } finally {
        await close();
      }
    }
  }, 30_000);

  test("move buttons announce, retain focus, and reserve the same boxes at the edges", async () => {
    const { page, close } = await open(desktop, {
      props: {
        ...baseProps,
        board: [
          { id: "weather/current", key: "weather/current", size: "small" },
          { id: "gateway/health", key: "gateway/health", size: "small" },
          { id: "quotes/quote", key: "quotes/quote", size: "small" },
        ],
        kept: [],
      },
    });
    try {
      await waitForState(page, "weather/current", "ok");
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const weather = tile(page, "weather/current");
      const forward = weather.getByRole("button", { name: "Move Weather forward" });
      const back = weather.getByRole("button", { name: "Move Weather back" });
      expect(await forward.getAttribute("aria-disabled")).toBe("true");
      expect(
        await tile(page, "quotes/quote").getByRole("button", { name: "Move Quote of the hour back" }).getAttribute("aria-disabled"),
      ).toBe("true");
      const relativeTools = () =>
        weather.evaluate((tile) => {
          const box = tile.getBoundingClientRect();
          const tools = tile.querySelector(".dashboard-tile__tools")!.getBoundingClientRect();
          return [tools.x - box.x, tools.y - box.y, tools.width, tools.height];
        });
      const tools = await relativeTools();
      const before = (await layout(page)).boxes.map((box) => box.slice(1));
      // Playwright does not press a control that says it is disabled; a person still can, and nothing happens.
      await forward.click({ force: true });
      expect((await layout(page)).order[0]).toBe("weather/current:small");
      await back.click();
      expect((await layout(page)).order).toEqual(["gateway/health:small", "weather/current:small", "quotes/quote:small"]);
      await announced(page, "Weather at position 2 of 3");
      expect(await back.evaluate((el) => el === document.activeElement)).toBeTrue();
      expect(await relativeTools()).toEqual(tools);
      expect((await layout(page)).boxes.map((box) => box.slice(1))).toEqual(before);
      expect(await forward.getAttribute("aria-disabled")).toBeNull();
    } finally {
      await close();
    }
  }, 30_000);

  test("phone settings use a sheet and edit controls have 44px targets", async () => {
    const { page, close } = await open(phone);
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const controls = await page.locator(".dashboard-tile").evaluateAll((tiles) =>
        tiles.flatMap((tile) => {
          const buttons = Array.from(tile.querySelectorAll<HTMLElement>(".dashboard-tile__tools button, .dashboard-tile__sizes button"));
          const sizes = buttons.map((el) => {
            const box = el.getBoundingClientRect();
            return { label: el.getAttribute("aria-label") ?? el.textContent, width: box.width, height: box.height };
          });
          const remove = tile.querySelector(".dashboard-tile__remove")!;
          const area = getComputedStyle(remove, "::after");
          const box = remove.getBoundingClientRect();
          sizes.push({
            label: remove.getAttribute("aria-label") ?? "",
            width: box.width - parseFloat(area.left) - parseFloat(area.right),
            height: box.height - parseFloat(area.top) - parseFloat(area.bottom),
          });
          return sizes;
        }),
      );
      expect(controls.filter((box) => box.width < 44 || box.height < 44)).toEqual([]);
      await tile(page, "weather/current").getByRole("button", { name: "Customize Weather" }).click();
      await page.getByRole("dialog", { name: "Customize Weather" }).waitFor();
      expect(await page.locator(".k2b-bottom-sheet-frame.is-adaptive").count()).toBe(1);
      expect(await page.locator(".k2b-bottom-sheet__handle").isVisible()).toBe(true);
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .filter((animation) => animation.timeline === document.timeline)
          .every((animation) => animation.playState !== "running"),
      );
      const frame = (await page.getByRole("dialog").boundingBox())!;
      expect(frame.y + frame.height).toBe(page.viewportSize()!.height);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await tile(page, "spaces/today").getByRole("button", { name: "Customize Today" }).click();
      const choose = page.getByRole("dialog", { name: "Customize Today" }).getByRole("button", { name: "Choose", exact: true });
      const box = (await choose.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    } finally {
      await close();
    }
  }, 30_000);

  test("at 320px tools and sizes stay inside every small tile", async () => {
    const { page, close } = await open(
      { width: 320, height: 640, touch: true },
      {
        props: {
          ...baseProps,
          board: [
            { id: "weather/current", key: "weather/current", size: "small" },
            { id: "gateway/health", key: "gateway/health", size: "small" },
          ],
          kept: [],
        },
      },
    );
    try {
      await waitForState(page, "weather/current", "ok");
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      const outside = await page.locator(".dashboard-tile").evaluateAll((tiles) =>
        tiles.flatMap((tile) => {
          const box = tile.getBoundingClientRect();
          return Array.from(
            tile.querySelectorAll<HTMLElement>(
              ".dashboard-tile__tools, .dashboard-tile__tools button, .dashboard-tile__sizes, .dashboard-tile__sizes button",
            ),
          ).flatMap((el) => {
            const control = el.getBoundingClientRect();
            return control.left < box.left || control.right > box.right || control.top < box.top || control.bottom > box.bottom
              ? [
                  {
                    id: tile.getAttribute("data-id"),
                    control: el.className,
                    left: control.left - box.left,
                    right: control.right - box.right,
                  },
                ]
              : [];
          });
        }),
      );
      expect(outside).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  test("the gallery allows another configurable instance and keeps plain widgets once only", async () => {
    const { page, close } = await open(desktop);
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      for (let index = 0; index < 2; index += 1) {
        await page.getByRole("button", { name: "Add widget" }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.locator('[data-key="gateway/health"]').getByRole("button", { name: "On the board" }).waitFor();
        await dialog.locator('[data-key="weather/current"]').getByRole("button", { name: "Add Weather" }).click();
        await dialog.waitFor({ state: "detached" });
      }
      const weatherIds = await page
        .locator('.dashboard-tile[data-key="weather/current"]')
        .evaluateAll((tiles) => tiles.map((el) => el.getAttribute("data-id")));
      expect(weatherIds).toHaveLength(3);
      expect(new Set(weatherIds).size).toBe(3);
      expect(weatherIds[0]).toBe("weather/current");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Edit dashboard" }).waitFor();
      const entries = saved.at(-1)!.board!.filter((entry) => entry.key === "weather/current");
      expect(entries).toHaveLength(3);
      for (const entry of entries) expect(entry).not.toHaveProperty("settings");
    } finally {
      await close();
    }
  }, 30_000);

  test("timeout retains Retry and asks exactly that entry with its settings", async () => {
    const configured: DashboardBoardEntry = { id: "w2", key: "weather/current", size: "small", settings: { place: "berlin" } };
    answer = async (asked, write) => {
      for (const entry of asked)
        write(entry.id === "w2" ? { type: "widget", id: entry.id, key: entry.key, status: "timeout", ms: 30_000 } : ok(entry));
    };
    const { page, close } = await open(desktop, { props: { ...baseProps, board: [board[2], configured], kept: [] } });
    try {
      await waitForState(page, "w2", "timeout");
      const retry = tile(page, "w2").getByRole("button", { name: "Try again" });
      await retry.waitFor();
      answer = answerAll;
      const retried = requests.count;
      await retry.click();
      await tile(page, "w2").getByText("Weather berlin", { exact: true }).waitFor();
      expect(await requests.next(retried)).toEqual([configured]);
    } finally {
      answer = answerAll;
      await close();
    }
  }, 30_000);

  test("a small widget on a 390px and a 320px phone keeps its failure message and Try again inside its frame", async () => {
    // Playwright's click scrolls a cut-off button into view, so only the boxes show whether the recovery stays reachable.
    const failing: DashboardBoardEntry[] = [
      { id: "w-error", key: "weather/current", size: "small" },
      { id: "w-timeout", key: "gateway/health", size: "small" },
    ];
    answer = async (asked, write) => {
      for (const entry of asked)
        write({ type: "widget", id: entry.id, key: entry.key, status: entry.id === "w-error" ? "error" : "timeout", ms: 5 });
    };
    try {
      const narrow: View = { width: 320, height: 640, touch: true };
      for (const [view, lang] of [
        [phone, "en"],
        [narrow, "en"],
        [phone, "de"],
        [narrow, "de"],
      ] as const) {
        const { page, close } = await open(view, { lang, props: { ...baseProps, board: failing, kept: [] } });
        try {
          await waitForState(page, "w-error", "error");
          await waitForState(page, "w-timeout", "timeout");
          for (const id of ["w-error", "w-timeout"]) {
            const frame = (await tile(page, id).locator(".k2b-widget").boundingBox())!;
            const retry = (await tile(page, id)
              .getByRole("button", { name: lang === "de" ? "Erneut versuchen" : "Try again" })
              .boundingBox())!;
            const body = await tile(page, id)
              .locator(".k2b-widget__body")
              .evaluate((element) => element.scrollHeight - element.clientHeight);
            const fits = { top: retry.y >= frame.y, bottom: retry.y + retry.height <= frame.y + frame.height, scrolls: body };
            expect({ width: view.width, lang, id, ...fits }).toEqual({ width: view.width, lang, id, top: true, bottom: true, scrolls: 0 });
          }
        } finally {
          await close();
        }
      }
    } finally {
      answer = answerAll;
    }
  }, 30_000);

  test("settings keep defaults unset, trim text on Enter, reset fields, and display resource snapshots", async () => {
    const { page, close } = await open(desktop, {
      props: {
        ...baseProps,
        board: [
          {
            id: "spaces/today",
            key: "spaces/today",
            size: "large",
            settings: { space: { type: "spaces.space", id: "home", title: "Home" }, done: true, note: "old", unknown: "drop" },
          },
          board[2],
        ],
        kept: [],
      },
    });
    try {
      await waitForState(page, "spaces/today", "ok");
      await page.getByRole("button", { name: "Edit dashboard" }).click();
      await tile(page, "weather/current").getByRole("button", { name: "Customize Weather" }).click();
      let dialog = page.getByRole("dialog", { name: "Customize Weather" });
      expect(await dialog.getByRole("radio", { name: "Hamburg" }).getAttribute("aria-checked")).toBe("true");
      const count = requests.count;
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(requests.count).toBe(count);
      await tile(page, "spaces/today").getByRole("button", { name: "Customize Today" }).click();
      dialog = page.getByRole("dialog", { name: "Customize Today" });
      // The stored title is shown, and only the reference is sent to the widget.
      expect(await dialog.getByRole("textbox", { name: "Space" }).inputValue()).toBe("Home");
      await dialog.getByRole("button", { name: "Clear Space" }).waitFor();
      expect(await dialog.getByRole("textbox", { name: "Note" }).getAttribute("maxlength")).toBe("40");
      await dialog.getByRole("textbox", { name: "Note" }).fill("  trimmed  ");
      const entered = requests.count;
      await dialog.getByRole("textbox", { name: "Note" }).press("Enter");
      await dialog.waitFor({ state: "detached" });
      expect(await requests.next(entered)).toEqual([
        {
          id: "spaces/today",
          key: "spaces/today",
          size: "large",
          settings: { space: { type: "spaces.space", id: "home" }, done: true, note: "trimmed" },
        },
      ]);
      await tile(page, "spaces/today").getByRole("button", { name: "Customize Today" }).click();
      await dialog.getByRole("button", { name: "Reset", exact: true }).click();
      expect(await dialog.getByRole("textbox", { name: "Space" }).inputValue()).toBe("");
      expect(await dialog.getByRole("textbox", { name: "Space" }).getAttribute("placeholder")).toBe("Nothing chosen");
      expect(await dialog.getByRole("switch", { name: "Show done" }).isChecked()).toBeFalse();
      expect(await dialog.getByRole("textbox", { name: "Note" }).inputValue()).toBe("");
      expect(await dialog.getByRole("button", { name: "Clear Space" }).count()).toBe(0);
      const reset = requests.count;
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await requests.next(reset)).toEqual([{ id: "spaces/today", key: "spaces/today", size: "large" }]);
    } finally {
      await close();
    }
  }, 30_000);

  test("every built-in widget fits its frame in every size it offers, at desktop, tablet and phone widths", async () => {
    // Only a list may hold more than its frame, and then it scrolls its own rows: the header and the blocks after it
    // stay whole, and its scrollbar has its place from the start, so its rows are as wide as those of a list that fits.
    const sizes = ["small", "medium", "large"] as const;
    const fixtures = builtInWidgets.flatMap((built) => built.sizes.flatMap((size) => built.fixtures(size)));
    const states = (["loading", "empty", "forbidden", "timeout", "error"] as const).flatMap((status) =>
      sizes.map((size) => ({ id: `frame:${status}:${size}`, key: "frame/state", size, status })),
    );
    const footer: WidgetResponse["blocks"][number] = { kind: "pills", pills: [{ label: "Open", value: 12 }] };
    const lists = (["long", "short"] as const).flatMap((length) =>
      sizes.map((size) => {
        const response: WidgetResponse = {
          title: "Tasks",
          meta: "12 open",
          blocks: [{ kind: "list", items: list(length === "long" ? 12 : 1) }, footer],
        };
        return { id: `frame:${length}-list:${size}`, key: "frame/state", size, response };
      }),
    );
    const responses = new Map<string, WidgetResponse>([
      ...fixtures.map((fixture) => [`${fixture.key}:${fixture.size}:${fixture.variant}`, fixture.response] as const),
      ...lists.map((entry) => [entry.id, entry.response] as const),
    ]);
    const entries: DashboardBoardEntry[] = [
      ...fixtures.map(({ key, size, variant }) => ({ id: `${key}:${size}:${variant}`, key, size })),
      ...[...states, ...lists].map(({ id, key, size }) => ({ id, key, size })),
    ];
    const fitCatalog: DashboardCatalogWidget[] = [
      ...builtInWidgets.map((built) => widget(built.key, built.key, built.sizes, built.sizes[0]!, false)),
      widget("frame/state", "Frame state", [...sizes], "small", false),
    ];
    const held = gate();
    answer = async (asked, write) => {
      for (const entry of asked) {
        const response = responses.get(entry.id);
        if (response) write({ type: "widget", id: entry.id, key: entry.key, status: "ok", ms: 5, widget: response });
        const status = states.find((state) => state.id === entry.id)?.status;
        if (status && status !== "loading") write({ type: "widget", id: entry.id, key: entry.key, status, ms: 5 });
      }
      await held.opened;
    };
    const views: View[] = [
      { width: 2000, height: 1200, touch: false },
      desktop,
      { width: 1280, height: 800, touch: false },
      { width: 1024, height: 768, touch: true },
      { width: 820, height: 1180, touch: true },
      { width: 768, height: 1024, touch: true },
      phone,
      { width: 360, height: 780, touch: true },
    ];
    const report: { lang: string; width: number; misfits: string[] }[] = [];
    // Playwright hides scrollbars; Windows and Linux desktops draw classic ones that take space. WebKit draws overlay ones.
    const engine = browserName === "chromium" ? await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] }) : browser;
    try {
      for (const lang of ["de", "en"]) {
        for (const view of views) {
          const { page, close } = await open(view, {
            lang,
            engine,
            props: { ...baseProps, catalog: fitCatalog, board: entries, kept: [] },
          });
          try {
            for (const entry of entries) await waitForState(page, entry.id, states.find((state) => state.id === entry.id)?.status ?? "ok");
            await page.evaluate(() => document.fonts.ready);
            const misfits = await page.evaluate(() => {
              const tiles = Array.from(document.querySelectorAll<HTMLElement>(".dashboard-tile"));
              const rowWidth = (id: string) =>
                document.querySelector(`.dashboard-tile[data-id="${id}"] .k2b-widget-list__item`)!.getBoundingClientRect().width;
              return tiles.flatMap((tile) => {
                const id = tile.dataset.id!;
                const body = tile.querySelector<HTMLElement>(".k2b-widget__body")!;
                const bottom = body.getBoundingClientRect().bottom;
                const problems: string[] = [];
                if (body.scrollHeight > body.clientHeight) problems.push(`scrolls ${body.scrollHeight - body.clientHeight}px`);
                if (body.scrollWidth > body.clientWidth) problems.push(`scrolls sideways ${body.scrollWidth - body.clientWidth}px`);
                // Everything but a list's own rows ends inside the frame, the list itself included.
                const cut = Array.from(body.querySelectorAll<HTMLElement>("*")).find(
                  (element) =>
                    !element.parentElement?.closest(".k2b-widget-list") && element.getBoundingClientRect().bottom > bottom + 0.01,
                );
                if (cut) problems.push(`cuts off ${cut.className || cut.tagName}`);
                if (id.startsWith("frame:long-list:")) {
                  const rows = tile.querySelector<HTMLElement>(".k2b-widget-list")!;
                  if (rows.scrollHeight <= rows.clientHeight) problems.push("does not scroll its rows");
                  if (rowWidth(id) !== rowWidth(id.replace("long", "short"))) problems.push("rows narrower than in a list that fits");
                }
                return problems.length > 0 ? [`${id}: ${problems.join(", ")}`] : [];
              });
            });
            if (misfits.length > 0) report.push({ lang, width: view.width, misfits });
          } finally {
            await close();
          }
        }
      }
      expect(report).toEqual([]);
    } finally {
      held.open();
      answer = answerAll;
      if (engine !== browser) await engine.close();
    }
  }, 120_000);

  test("speaks German", async () => {
    const { page, close } = await open(phone, { lang: "de" });
    try {
      await allLoaded(page);
      await page.getByRole("button", { name: "Dashboard bearbeiten" }).click();
      await page.getByRole("button", { name: "Fertig" }).waitFor();
      expect(await page.locator(".dashboard-edit-hint").textContent()).toContain("Halten und ziehen oder ← → tippen verschiebt");
      await tile(page, "weather/current").getByRole("radio", { name: "Mittel" }).waitFor();
      await tile(page, "weather/current").getByRole("button", { name: "Weather anpassen" }).waitFor();
      expect(await tile(page, "weather/current").locator(".dashboard-tile__customize").textContent()).toContain("Anpassen");
      await tile(page, "weather/current").getByRole("button", { name: "Weather nach vorne" }).waitFor();
      await tile(page, "weather/current").getByRole("button", { name: "Weather nach hinten" }).waitFor();
      await tile(page, "weather/current").locator('[data-move="forward"]').hover();
      await page.getByRole("tooltip").getByText("Nach vorne", { exact: true }).waitFor();
      await tile(page, "weather/current").locator('[data-move="back"]').hover();
      await page.getByRole("tooltip").getByText("Nach hinten", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Abbrechen" }).click();
    } finally {
      await close();
    }
  }, 30_000);
});
