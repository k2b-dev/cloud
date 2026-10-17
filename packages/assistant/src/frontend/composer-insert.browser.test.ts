import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudResourcePickerItem } from "@k2b/cloud/browser/resource-picker";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";

// Where the slash list, its scope heading, the picker and the inserted reference end up is real layout and real
// focus, so this runs the Assistant's Insert rows in a browser against a server that answers the picker's search.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "composer-insert.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-composer-insert-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Composer insert harness build failed");
  return build.outputs[0]!.text();
};

const apps = [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }];
const note = (id: string, title: string, preview: string): CloudResourcePickerItem => ({
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  readable: true,
  ref: { type: "notebooks.note", id },
  title,
  preview,
  href: `/app/notebooks/${id}`,
});
const notes = [
  note("n1", "Q3-Planung", "Notizbuch Vertrieb"),
  note("n2", "Q3-Ziele Team", "Notizbuch Persönlich"),
  note("n3", "Retro Q3", "Notizbuch Produkt"),
];
const searches: URL[] = [];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  // Icons and the typeface load from @k2b/ui's build, so rows look and measure as they do in Cloud.
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = `${fonts}\n${await styles.outputs[0]!.text()}`;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (url.pathname === "/api/search") {
        searches.push(url);
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        // The NDJSON lines of /api/search: start, one per app, done.
        const lines = [
          { type: "start", query, apps, providers: ["notebooks"] },
          {
            type: "provider",
            provider: "notebooks",
            status: "ok",
            results: notes.filter((item) => item.title.toLowerCase().includes(query)),
            ms: 5,
          },
          { type: "done", status: "complete", count: 0 },
        ];
        return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:0 1rem"><div id="root"></div><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
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

const open = async (view: View, query = "") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/${query}`);
  const field = page.locator("textarea").first();
  await field.waitFor();
  await field.focus();
  await page.keyboard.press("End");
  return { page, field, close: () => context.close() };
};
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    });
const option = (page: Page, text: string) => page.locator('[role="listbox"] [role="option"]', { hasText: text }).first();

describe(`Insert from the Assistant's slash list in ${browserName}`, () => {
  test.each(views)(
    "at $width px, /notiz q3 opens Notes with q3 and inserts the chosen note as a reference",
    async (view) => {
      searches.length = 0;
      const { page, field, close } = await open(view);
      try {
        const composer = await box(page, ".k2b-chat-composer");
        await page.keyboard.type("/notiz");
        await option(page, "Notizbücher").waitFor();
        // Tags appear under Insert while typing; the composer does not move for the list.
        expect(await page.locator(".k2b-chat-composer__command-heading").first().textContent()).toBe("Einfügen");
        expect(await box(page, ".k2b-chat-composer")).toEqual(composer);

        await page.keyboard.type(" q3");
        await option(page, "„q3“ in Notizen suchen").waitFor();
        expect(await page.locator(".k2b-chat-composer__command-heading").allTextContents()).toEqual(["Notizen aus Notebooks"]);
        expect(await option(page, "„q3“ in Notizen suchen").textContent()).toContain("Aus Notebooks, mit Vorschau");
        expect(await box(page, ".k2b-chat-composer")).toEqual(composer);

        await page.keyboard.press("Enter");
        const dialog = page.locator("dialog");
        await dialog.getByText("Q3-Planung").first().waitFor();
        expect(await dialog.getByText("Notizen einfügen").count()).toBeGreaterThan(0);
        expect(await dialog.locator(".cloud-resource-search__tag").first().textContent()).toContain("Notizen · Notebooks");
        expect(await dialog.locator('input[role="combobox"]').inputValue()).toBe("q3");
        // Narrowed on the server, with the reader requirement kept.
        const url = searches.find((search) => search.searchParams.get("q") === "q3")!;
        expect(Object.fromEntries(["app", "scope_tag", "q", "require_reader"].map((key) => [key, url.searchParams.get(key)]))).toEqual({
          app: "notebooks",
          scope_tag: "note",
          q: "q3",
          require_reader: "true",
        });

        await dialog.getByRole("option", { name: /Q3-Planung/ }).click();
        await dialog.getByRole("button", { name: "Hinzufügen" }).click();
        await page.waitForFunction(() => document.querySelector("dialog")?.open !== true);
        await page.waitForFunction(() => document.querySelector("textarea")?.value === "Ja, nimm die Preise aus Q3-Planung ");
        expect(await page.locator(".k2b-chat-composer__mention").allTextContents()).toEqual(["Q3-Planung"]);
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");

        await field.press("Control+z");
        await page.waitForFunction(() => document.querySelector("textarea")?.value === "Ja, nimm die Preise aus /notiz q3");
      } finally {
        await close();
      }
    },
    60_000,
  );

  test("Escape in the picker keeps /notiz q3 in place", async () => {
    const { page, close } = await open(views[0]!);
    try {
      await page.keyboard.type("/notiz q3");
      await option(page, "„q3“ in Notizen suchen").waitFor();
      await page.keyboard.press("Enter");
      await page.locator("dialog").getByText("Q3-Planung").first().waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("dialog")?.open !== true);
      expect(await page.locator("textarea").inputValue()).toBe("Ja, nimm die Preise aus /notiz q3");
    } finally {
      await close();
    }
  }, 60_000);

  test("an unmatched search says so above the row that searches all of Cloud", async () => {
    const { page, close } = await open(views[0]!);
    try {
      await page.keyboard.type("/xylo");
      const tail = option(page, "„xylo“ in Cloud suchen");
      await tail.waitFor();
      const status = page.locator('[role="listbox"] [role="status"]', { hasText: "Nichts gefunden für „xylo“" });
      // "Nothing found" waits until the search has answered; the row is there from the first key.
      await status.waitFor();
      expect(
        await status.evaluate(
          (node, row) => Boolean(node.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING),
          await tail.elementHandle(),
        ),
      ).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

  test("a full message says why Attach file and Insert from Cloud are unavailable", async () => {
    const { page, close } = await open(views[0]!, "?full");
    try {
      await page.keyboard.type("/");
      const attach = option(page, "Datei anhängen");
      await attach.waitFor();
      expect(await attach.textContent()).toContain("Eine Nachricht kann höchstens 16 Elemente enthalten.");
      expect(await attach.getAttribute("aria-disabled")).toBe("true");
      expect(await option(page, "Aus Cloud einfügen").getAttribute("aria-disabled")).toBe("true");
    } finally {
      await close();
    }
  }, 60_000);
});
