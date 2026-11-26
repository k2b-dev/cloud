import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../ui/test/browser";
import { activity, activityPage } from "./notebooks-home.fixtures";

// The home of Notebooks on v2 with invented data: the test answers the notebooks API itself (activity pages, a new
// notebook, a notebook from a template) and records what the page asked.
const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
const created: { path: string; body: unknown }[] = [];
const server = { activity: 75, failNext: 0 };
let httpServer: ReturnType<typeof Bun.serve>;
let browser: Browser;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebooks-home.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-notebooks-home-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the home harness.");
  const bundle = await build.outputs[0]!.text();
  const sheet = async (entry: string) => {
    const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
    return output.outputs[0]!.text();
  };
  // the shipped page-head order and cascade: Cloud, the app, then v2
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await sheet(resolve(import.meta.dir, "../../../styles/app.css")),
    await sheet(resolve(import.meta.dir, "../../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
  ].join("\n");
  httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(1))));
      if (url.pathname === "/api/notebooks/overview/activity") {
        if (server.failNext > 0) {
          server.failNext--;
          return Response.json({ message: "unavailable" }, { status: 503 });
        }
        const page = activityPage(activity(server.activity), Number(url.searchParams.get("cursor") ?? 0));
        return Response.json({ data: page.items, nextCursor: page.nextCursor });
      }
      if (request.method === "POST" && (url.pathname === "/api/notebooks" || url.pathname.startsWith("/api/notebooks/templates/"))) {
        created.push({ path: url.pathname, body: await request.json() });
        return Response.json({ id: url.pathname === "/api/notebooks" ? "newbook" : "fromtemplate" });
      }
      if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      if (url.pathname !== "/app/notebooks")
        return new Response("<!doctype html><title>opened</title>", { headers: { "content-type": "text/html" } });
      const state = url.searchParams.get("state") ?? "normal";
      return new Response(
        `<!doctype html><html lang="de" data-state="${state}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  httpServer?.stop(true);
});

const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
  created.length = 0;
  server.activity = 75;
  server.failNext = 0;
});
const open = async (state = "normal", width = 1440): Promise<Page> => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : width < 1200 ? 768 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  page.on("pageerror", (error) => {
    if (!error.message.includes("ViewTransition")) errors.push(error.message);
  });
  await page.goto(new URL(`/app/notebooks?state=${state}`, httpServer.url).href);
  await page.locator("[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const nav = (page: Page) => page.locator('[data-k2-part="Nav"]');
const activityRows = (page: Page) => page.locator('[data-k2-part="Digest"] [data-k2-part="Row"]');
const plus = (page: Page) => page.getByRole("button", { name: "Neues Notizbuch" }).first();

for (const width of [1440, 1024, 390]) {
  test(`${width}: the home is a clean v2 workspace with the notebooks, the notes edited last and the activity`, async () => {
    const page = await open("normal", width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // the head: the search and the one "+", which the phone keeps too
      expect(await page.getByRole("button", { name: "Suchen" }).isVisible()).toBe(true);
      expect(await plus(page).isVisible()).toBe(true);
      expect(await page.getByText("Wochenplan KW 48").first().isVisible()).toBe(true);
      // one page of activity: the rest loads on request
      expect(await activityRows(page).count()).toBe(30);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("pinning moves a notebook into its own group above the others, keeps it in the cookie, and says so", async () => {
  const page = await open();
  try {
    // the sidebar reads: the overview, the pinned group, then all other notebooks
    const order = async () => {
      const text = (await nav(page).textContent()) ?? "";
      return { pinned: text.indexOf("Angeheftet"), all: text.indexOf("Alle Notizbücher"), at: (name: string) => text.indexOf(name) };
    };
    const before = await order();
    expect(before.at("Projekt Hallenumbau")).toBeGreaterThan(before.pinned);
    expect(before.at("Projekt Hallenumbau")).toBeLessThan(before.all);
    expect(before.at("Handbuch Lager")).toBeGreaterThan(before.all);
    await nav(page)
      .getByRole("link", { name: /Handbuch Lager/ })
      .hover();
    await nav(page).getByRole("button", { name: "Aktionen für Handbuch Lager" }).click();
    await page.getByRole("menuitem", { name: "Anheften" }).click();
    await page.waitForFunction(() => decodeURIComponent(document.cookie).includes("book00"));
    const after = await order();
    expect(after.at("Handbuch Lager")).toBeGreaterThan(after.pinned);
    expect(after.at("Handbuch Lager")).toBeLessThan(after.all);
    await page.locator('[data-k2-part="Toast"]').getByText("Handbuch Lager angeheftet").waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("the one + makes a blank notebook after asking its name, and opens it", async () => {
  const page = await open();
  try {
    await plus(page).click();
    await page.getByRole("menuitem", { name: /Leeres Notizbuch/ }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.waitFor();
    // without a name nothing is made
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Gib dem Notizbuch einen Namen.").waitFor();
    expect(created).toEqual([]);
    await dialog.getByRole("textbox", { name: "Name" }).fill("Inventur 2027");
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/newbook");
    expect(created).toEqual([{ path: "/api/notebooks", body: { name: "Inventur 2027" } }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("the one + makes a notebook from a template, under the template's name when none is given", async () => {
  const page = await open();
  try {
    await plus(page).click();
    await page.getByRole("menuitem", { name: /Besprechungen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Besprechungen" });
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/meeting", body: {} }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("the search asks Cloud's search for the notebooks", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      window.addEventListener("cloud.search.open", (event) => {
        const detail = (event as CustomEvent<{ options: { scope?: { appId?: string } }; accepted: boolean }>).detail;
        detail.accepted = true;
        document.documentElement.dataset.searched = detail.options.scope?.appId ?? "";
      });
    });
    await page.getByRole("button", { name: "Suchen" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.searched === "notebooks");
  } finally {
    await page.close();
  }
}, 60_000);

test("the activity loads page by page; a failed page keeps the loaded ones and tries again", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Mehr laden" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-k2-part="Digest"] [data-k2-part="Row"]').length === 60);
    server.failNext = 1;
    await page.getByRole("button", { name: "Mehr laden" }).click();
    const failed = page.locator('[data-k2-part="Failed"]');
    await failed.waitFor();
    expect(await activityRows(page).count()).toBe(60);
    await failed.getByRole("button").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-k2-part="Digest"] [data-k2-part="Row"]').length === 75);
    // the last page has nothing after it
    expect(await page.getByRole("button", { name: "Mehr laden" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test("activity the server could not read says so, and trying again loads it", async () => {
  const page = await open("failed");
  try {
    const failed = page.locator('[data-k2-part="Failed"]');
    await failed.waitFor();
    await failed.getByRole("button").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-k2-part="Digest"] [data-k2-part="Row"]').length === 30);
  } finally {
    await page.close();
  }
}, 60_000);

test("break-ui: no notebooks offers a new one, and the + still works", async () => {
  const page = await open("empty");
  try {
    const empty = page.locator('[data-k2-part="Empty"]', { hasText: "Noch keine Notizbücher." });
    await empty.getByRole("button", { name: "Neues Notizbuch" }).click();
    await page.getByRole("dialog", { name: "Neues Notizbuch" }).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

for (const width of [1440, 390])
  test(`break-ui ${width}: 200 notebooks with long names stay inside the sidebar and the page`, async () => {
    const page = await open("many", width);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      if (width > 600) {
        // every notebook is in the sidebar, the pinned ones first; a long name is cut, never wider than the sidebar
        expect(await nav(page).getByRole("link").count()).toBeGreaterThanOrEqual(200);
        const overflow = await nav(page).evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      }
    } finally {
      await page.close();
    }
  }, 60_000);

test("break-ui: 1,000 activities come in pages of 30, so the first picture stays small", async () => {
  server.activity = 1000;
  const page = await open("activity1000");
  try {
    expect(await activityRows(page).count()).toBe(30);
    await page.getByRole("button", { name: "Mehr laden" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-k2-part="Digest"] [data-k2-part="Row"]').length === 60);
    expect(await page.locator("#root *").count()).toBeLessThan(4000);
  } finally {
    await page.close();
  }
}, 60_000);
