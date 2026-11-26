import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";

const ui = `${resolve(import.meta.dir, "../../../../ui")}/`;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const deletes: string[] = [];
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "admin-notebooks.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-admin-notebooks-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the admin harness.");
  const bundle = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../cloud")}/`))).default;
  const sheet = async (entry: string) => {
    const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
    return output.outputs[0]!.text();
  };
  // the shipped page-head order and cascade: Cloud, the app, then v2
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await sheet(resolve(import.meta.dir, "../../styles/app.css")),
    await sheet(resolve(import.meta.dir, "../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(1))));
      // deleting a notebook: the one nobody can reach is refused, the others go
      const deleted = /^\/api\/notebooks\/(\w+)$/.exec(url.pathname);
      if (deleted && request.method === "DELETE") {
        deletes.push(deleted[1]!);
        return deleted[1] === "nb0004"
          ? Response.json({ message: "Das Notizbuch ist gesperrt." }, { status: 409 })
          : new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
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

const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
const open = async (path: string, width = 1440) => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  page.on("pageerror", (error) => {
    if (!error.message.includes("ViewTransition")) errors.push(error.message);
  });
  await page.goto(new URL(path, server.url).href);
  await page.locator("[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};

for (const width of [1440, 390]) {
  test(`${width}: the notebooks are a clean v2 admin screen that says how many there are and which nobody can reach`, async () => {
    const page = await open("/admin/notebooks", width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // the first row states the numbers
      expect(await page.locator('[data-k2-part="StatusRow"]').textContent()).toContain("48 Notizbücher");
      // the one nobody can reach stands out
      expect(await page.locator('[data-k2-part="Chip"][data-status="bad"]').count()).toBeGreaterThan(0);
      if (width > 600) {
        expect(await page.locator('[data-k2-part="Table"] tbody tr').count()).toBe(8);
        expect(await page.getByText("Seite 1 von 6").isVisible()).toBe(true);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("the search goes into the address, and an empty result says so", async () => {
  const page = await open("/admin/notebooks");
  try {
    const search = page.getByRole("searchbox", { name: "Notizbücher durchsuchen" });
    await search.fill("Lager");
    await search.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("search") === "Lager");
  } finally {
    await page.close();
  }
  const empty = await open("/admin/notebooks?empty=1&search=Zeppelin");
  try {
    await empty.getByText("Keine Notizbücher passen zu „Zeppelin“.").waitFor();
  } finally {
    await empty.close();
  }
}, 60_000);

test("a row's menu deletes after asking, and a refused delete names the reason", async () => {
  const page = await open("/admin/notebooks");
  try {
    const row = (name: string) => page.locator('[data-k2-part="Table"] tbody tr', { hasText: name });
    await row("Altes Wiki").getByRole("button", { name: "Aktionen für Altes Wiki" }).click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    // nothing happens before the question is answered
    await page.getByRole("alertdialog").waitFor();
    expect(deletes).toEqual([]);
    await page.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
    await page.locator('[data-k2-part="Toast"]').getByText("Das Notizbuch ist gesperrt.").waitFor();
    expect(deletes).toEqual(["nb0004"]);
  } finally {
    deletes.length = 0;
    await page.close();
  }
}, 60_000);

test("390: a row's deeds stay reachable on the phone, where the table shows rows", async () => {
  const page = await open("/admin/notebooks", 390);
  try {
    const actions = page.getByRole("button", { name: "Aktionen für Altes Wiki" }).filter({ visible: true });
    await actions.click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    await page.getByRole("alertdialog").waitFor();
    // asking deletes nothing yet
    expect(deletes).toEqual([]);
    await page.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
  } finally {
    deletes.length = 0;
    await page.close();
  }
}, 60_000);
