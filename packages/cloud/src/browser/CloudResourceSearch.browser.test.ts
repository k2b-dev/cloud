import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { type Browser, chromium, type Page } from "playwright";
import type { SearchItem, SearchStreamLine } from "../api/search/schemas";

// Whether rows that arrive later move the ones already shown depends on real layout, so this runs in a browser
// against a server that streams invented results line by line.
const ui = resolve(import.meta.dir, "../../../ui");

/** The real search islands, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CloudResourceSearch.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-search-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Search harness build failed");
  return build.outputs[0]!.text();
};

const apps = [
  { id: "files", name: "Files", icon: "ti ti-folder" },
  { id: "mail", name: "Mail", icon: "ti ti-mail" },
  { id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" },
];
const result = (appId: string, title: string, preview: string): SearchItem => ({
  appId,
  appName: apps.find((app) => app.id === appId)!.name,
  appIcon: apps.find((app) => app.id === appId)!.icon,
  readable: true,
  ref: { type: `${appId}.item`, id: title },
  title,
  preview,
  href: `/app/${appId}`,
});
const line = (provider: string, results: SearchItem[], status = results.length ? "ok" : "empty"): SearchStreamLine => ({
  type: "provider",
  provider,
  status: status as "ok",
  results,
  ms: 10,
});

/** A provider that answers only when the test opens it. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};
type Answer = (url: URL, write: (line: SearchStreamLine) => void) => Promise<void>;
let answer: Answer = async () => {};
const searches: URL[] = [];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname !== "/api/search") {
        if (url.pathname !== "/") return new Response(null, { status: 404 });
        const lang = url.searchParams.get("lang") ?? "en";
        return new Response(
          `<!doctype html><html lang="${lang}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<style>${css}</style></head><body class="k2b-ui"><script src="/harness.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      searches.push(url);
      const encoder = new TextEncoder();
      const query = url.searchParams.get("q") ?? "";
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (value: SearchStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          if (!query) write({ type: "start", query, apps, providers: [] });
          else await answer(url, write);
          write({ type: "done", status: "complete", count: 0 });
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const views: View[] = [
  { width: 1440, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
];

const open = async (view: View, path = "/") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}${path}`);
  await page.locator('input[role="combobox"]').waitFor();
  return { page, close: () => context.close() };
};

/** Positions of the dialog and every result row, in CSS pixels. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    };
    return {
      dialog: box(document.querySelector("dialog")!),
      rows: Array.from(document.querySelectorAll('[role="option"]')).map(box),
      status: document.querySelector(".cloud-resource-search__status")?.textContent ?? "",
      selected: document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
const waitForRows = (page: Page, count: number) =>
  page.waitForFunction((expected) => document.querySelectorAll('[role="option"]').length === expected, count);
const waitForText = (page: Page, text: string) => page.locator("dialog").getByText(text, { exact: false }).first().waitFor();

describe("streamed search in a browser", () => {
  test("shows each app as it answers, appends slower apps below, and moves nothing already shown", async () => {
    for (const view of views) {
      const files = gate();
      const mail = gate();
      answer = async (_url, write) => {
        write({ type: "start", query: "plan", apps, providers: ["files", "mail", "notebooks"] });
        write(line("notebooks", []));
        await files.opened;
        write(
          line("files", [
            result("files", "Plan 2027.pdf", "Shared/Planning"),
            result("files", "Project plan.docx", "Team/Drafts"),
            result("files", "Floor plan.png", "Office"),
          ]),
        );
        await mail.opened;
        write(line("mail", [result("mail", "Plan for Monday", "Anna Beispiel"), result("mail", "Re: Plan", "Jonas Beispiel")]));
      };
      const { page, close } = await open(view);
      try {
        await page.keyboard.type("plan");
        await waitForText(page, "Files and Mail are still searching…");
        const searching = await layout(page);
        expect(searching.rows).toEqual([]);
        expect(await page.locator("dialog").textContent()).not.toContain("No matches");

        files.open();
        await waitForRows(page, 3);
        await waitForText(page, "Mail is still searching…");
        const first = await layout(page);
        // The status line sits below the results.
        const statusTop = await page.locator(".cloud-resource-search__status").evaluate((element) => element.getBoundingClientRect().top);
        expect(statusTop).toBeGreaterThanOrEqual(first.rows[2]![1]! + first.rows[2]![3]!);
        await page.keyboard.press("ArrowDown");
        expect((await layout(page)).selected).toContain("Project plan.docx");

        mail.open();
        await waitForRows(page, 5);
        await page.locator(".cloud-resource-search__status").waitFor({ state: "detached" });
        const done = await layout(page);
        // One dialog size from the first keystroke to the last app, and the first rows never move.
        expect({ width: view.width, dialog: [first.dialog, done.dialog], rows: done.rows.slice(0, 3) }).toEqual({
          width: view.width,
          dialog: [searching.dialog, searching.dialog],
          rows: first.rows,
        });
        expect(done.selected).toContain("Project plan.docx");
        expect(done.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("says that nothing was found only after every app has answered", async () => {
    const mail = gate();
    answer = async (_url, write) => {
      write({ type: "start", query: "zebra", apps, providers: ["files", "mail"] });
      write(line("files", []));
      await mail.opened;
      write(line("mail", []));
    };
    const { page, close } = await open(views[0]!);
    try {
      await page.keyboard.type("zebra");
      await waitForText(page, "Mail is still searching…");
      const searching = await layout(page);
      expect(await page.locator("dialog").textContent()).not.toContain("No matches");
      mail.open();
      await waitForText(page, "No matches. Try another search term.");
      expect((await layout(page)).dialog).toEqual(searching.dialog);
    } finally {
      await close();
    }
  }, 30_000);

  test("names an app that did not answer in time and searches only that app again", async () => {
    answer = async (url, write) => {
      if (url.searchParams.get("app") === "mail") {
        write({ type: "start", query: "budget", apps, providers: ["mail"] });
        write(line("mail", [result("mail", "Budget 2027", "Finance")]));
        return;
      }
      write({ type: "start", query: "budget", apps, providers: ["files", "mail"] });
      write(line("files", [result("files", "Budget.xlsx", "Finance")]));
      write(line("mail", [], "timeout"));
    };
    for (const view of views) {
      const { page, close } = await open(view);
      try {
        await page.keyboard.type("budget");
        await waitForText(page, "Mail did not respond in time");
        const before = await layout(page);
        expect(before.rows).toHaveLength(1);
        const count = searches.length;
        await page.locator(".cloud-resource-search__status").getByRole("button", { name: "Try again" }).click();
        await waitForRows(page, 2);
        expect(searches.slice(count).map((url) => url.searchParams.get("app"))).toEqual(["mail"]);
        const after = await layout(page);
        expect(after.rows[0]).toEqual(before.rows[0]!);
        expect(after.dialog).toEqual(before.dialog);
        expect(after.status).toBe("");
        expect(after.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("gives a picker narrowed to one app one clear state, in English and German", async () => {
    answer = async (url, write) => {
      write({ type: "start", query: url.searchParams.get("q") ?? "", apps, providers: ["mail"] });
      write(line("mail", []));
    };
    for (const [lang, text] of [
      ["en", "Mail: no matches for “invoice”"],
      ["de", "Mail: keine Treffer für „invoice“"],
    ] as const) {
      const { page, close } = await open(views[1]!, `/?picker&app=mail&lang=${lang}`);
      try {
        await page.keyboard.type("invoice");
        await waitForText(page, text);
        expect(searches.at(-1)?.searchParams.get("app")).toBe("mail");
      } finally {
        await close();
      }
    }
  }, 30_000);
});
