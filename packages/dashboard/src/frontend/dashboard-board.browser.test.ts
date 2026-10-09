import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { WidgetStreamLine } from "@k2b/cloud/contracts";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// Whether a widget that answers late, fails, or is retried moves another one is a layout result of the shipped
// cascade, so this runs the real board in a browser against a server that streams invented widgets line by line.

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "dashboard-board.browser-entry.tsx");
const tile = (key: string, title: string) => ({ key, title, icon: "ti ti-box", href: `/app/${key.split("/")[0]}` });
const board = {
  focusRows: [[tile("spaces/today", "Spaces")]],
  overviewRows: [[tile("venue/today", "Venue"), tile("quotes/quote", "Quotes")], [tile("notebooks/recent", "Notebooks")]],
  context: [tile("weather/current", "Weather"), tile("gateway-ops/health", "Gateway")],
  requestKeys: ["spaces/today", "venue/today", "quotes/quote", "notebooks/recent", "weather/current", "gateway-ops/health"],
  registeredKeys: ["spaces/today", "venue/today", "quotes/quote", "notebooks/recent", "weather/current", "gateway-ops/health"],
  hint: { forbidden: [], empty: [] },
};
const entrySource = `
import { render } from "solid-js/web";
import DashboardBoard from ${JSON.stringify(resolve(import.meta.dir, "dashboard-board.tsx"))};

render(() => <div class="dashboard-page"><DashboardBoard {...${JSON.stringify(board)}} /></div>, document.getElementById("root"));
`;

const list = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `Item ${index + 1}`, sub: "Detail", meta: "today", href: "/app/x" }));
const answers: Record<string, WidgetStreamLine> = {
  "spaces/today": {
    type: "widget",
    key: "spaces/today",
    status: "ok",
    ms: 20,
    widget: { title: "Today", meta: "3 open", href: "/app/spaces", blocks: [{ kind: "list", items: list(3), grow: true }] },
  },
  "venue/today": {
    type: "widget",
    key: "venue/today",
    status: "ok",
    ms: 30,
    widget: {
      title: "Front desk",
      blocks: [
        { kind: "status", tone: "info", title: "Closed now", message: "No regular hours today" },
        { kind: "stat", value: 20, label: "Free spots", sub: "people still needed" },
      ],
    },
  },
  "quotes/quote": {
    type: "widget",
    key: "quotes/quote",
    status: "ok",
    ms: 5000,
    widget: { title: "Quote of the hour", blocks: [{ kind: "hero", title: "If you want peace, accept.", subtitle: "Someone" }] },
  },
  "notebooks/recent": {
    type: "widget",
    key: "notebooks/recent",
    status: "ok",
    ms: 40,
    // Longer than its space: it scrolls inside the widget instead of growing it.
    widget: { title: "Recent notes", blocks: [{ kind: "list", items: list(12), grow: true }] },
  },
  "weather/current": {
    type: "widget",
    key: "weather/current",
    status: "ok",
    ms: 10,
    widget: { title: "Weather", blocks: [{ kind: "hero", title: "No saved locations yet", icon: "ti ti-map-pin" }] },
  },
};

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

type Answer = (keys: string[], write: (line: WidgetStreamLine) => void) => Promise<void>;
let answer: Answer = async () => {};
const requests: string[][] = [];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
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
    plugins: [
      {
        name: "solid-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dashboard board harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  const stylesheets = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
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
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/") {
        const lang = url.searchParams.get("lang") ?? "en";
        return new Response(
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname !== "/api/widgets/v1") return new Response(null, { status: 404 });
      const keys = url.searchParams.getAll("widget");
      requests.push(keys);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (line: WidgetStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          write({ type: "start", widgets: keys });
          await answer(keys, write);
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
const views: View[] = [
  { width: 1440, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
];

const open = async (view: View, lang = "en") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`);
  await page.locator(".dashboard-widget-slot").first().waitFor();
  return { page, close: () => context.close() };
};

/** Every widget's box, in document order, and what it shows. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll<HTMLElement>(".dashboard-widget-slot"));
    return {
      boxes: slots.map((slot) => {
        const rect = slot.getBoundingClientRect();
        return [
          slot.dataset.widget,
          Math.round(rect.left),
          Math.round(rect.top + window.scrollY),
          Math.round(rect.width),
          Math.round(rect.height),
        ];
      }),
      states: Object.fromEntries(slots.map((slot) => [slot.dataset.widget, slot.dataset.state])),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
const waitForState = (page: Page, key: string, state: string) =>
  page.locator(`.dashboard-widget-slot[data-widget="${key}"][data-state="${state}"]`).waitFor();

describe("dashboard widgets in a browser", () => {
  test("streams each widget into its reserved space; a slow and a failing app move nothing and stay on their own", async () => {
    for (const view of views) {
      const slow = gate();
      const firstLines = gate();
      const retried = gate();
      answer = async (keys, write) => {
        if (keys.length === 1 && keys[0] === "notebooks/recent") {
          await retried.opened;
          write(answers["notebooks/recent"]!);
          return;
        }
        await firstLines.opened;
        for (const key of ["weather/current", "spaces/today", "venue/today"]) write(answers[key]!);
        write({ type: "widget", key: "notebooks/recent", status: "error", ms: 12 });
        write({ type: "widget", key: "gateway-ops/health", status: "timeout", ms: 8000 });
        await slow.opened;
        write(answers["quotes/quote"]!);
      };
      const { page, close } = await open(view);
      try {
        const loading = await layout(page);
        expect(Object.values(loading.states)).toEqual(Array(6).fill("loading"));

        firstLines.open();
        await waitForState(page, "notebooks/recent", "error");
        await waitForState(page, "gateway-ops/health", "timeout");
        const partial = await layout(page);
        expect(partial.states).toEqual({
          "spaces/today": "ok",
          "venue/today": "ok",
          "quotes/quote": "loading",
          "notebooks/recent": "error",
          "weather/current": "ok",
          "gateway-ops/health": "timeout",
        });
        // Loaded widgets do not wait for the slow one, and nothing moved.
        expect(await page.locator('[data-widget="spaces/today"]').textContent()).toContain("Item 3");
        expect({ width: view.width, boxes: partial.boxes }).toEqual({ width: view.width, boxes: loading.boxes });
        // The failure stays inside its widget, with its own retry; there is no board-wide error.
        expect(await page.locator('[data-widget="gateway-ops/health"]').textContent()).toContain("The app did not respond in time.");
        expect(await page.locator('[role="alert"]').count()).toBe(2);

        // Retrying the failed widget while the slow one still loads: the first stream ending must not fail the retry.
        const before = requests.length;
        await page.locator('[data-widget="notebooks/recent"]').getByRole("button", { name: "Try again" }).focus();
        await page.keyboard.press("Enter");
        await waitForState(page, "notebooks/recent", "loading");
        // Keyboard focus stays on the widget when its retry button gives way to the loading state.
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.widget)).toBe("notebooks/recent");
        slow.open();
        await waitForState(page, "quotes/quote", "ok");
        expect((await layout(page)).states["notebooks/recent"]).toBe("loading");
        expect((await layout(page)).boxes).toEqual(loading.boxes);

        retried.open();
        await waitForState(page, "notebooks/recent", "ok");
        expect(requests.slice(before)).toEqual([["notebooks/recent"]]);
        const done = await layout(page);
        expect(done.boxes).toEqual(loading.boxes);
        expect(done.states["gateway-ops/health"]).toBe("timeout");
        // The long list scrolls inside its widget instead of growing it.
        const scrolls = await page
          .locator('[data-widget="notebooks/recent"] .k2b-widget-list')
          .evaluate((list) => list.scrollHeight > list.clientHeight);
        expect(scrolls).toBeTrue();
        expect(done.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("names a widget that failed and offers a retry, in English and German", async () => {
    answer = async (keys, write) => {
      for (const key of keys) write({ type: "widget", key, status: key === "quotes/quote" ? "timeout" : "error", ms: 5 });
    };
    for (const [lang, title, retry] of [
      ["en", "Widget unavailable", "Try again"],
      ["de", "Widget nicht verfügbar", "Erneut versuchen"],
    ] as const) {
      const { page, close } = await open(views[1]!, lang);
      try {
        await waitForState(page, "quotes/quote", "timeout");
        const slot = page.locator('[data-widget="quotes/quote"]');
        expect(await slot.textContent()).toContain(title);
        await slot.getByRole("button", { name: retry }).waitFor();
      } finally {
        await close();
      }
    }
  }, 30_000);
});
