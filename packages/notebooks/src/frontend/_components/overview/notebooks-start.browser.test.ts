import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";

// Notebooks for a person without a notebook, on v2, and the same new-notebook dialog opened from a page that is not
// v2 (the notebook switcher): the test answers the notebooks API itself and records what the page asked.
const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
const created: { path: string; body: unknown }[] = [];
// how the next creation answers: a notebook; 201 with a body that is no JSON (a proxy page, a cut connection); 201
// without an id; a refusal with the server's reason. And whether the templates come as a list or as something else.
const server = { creation: "notebook" as "notebook" | "garbled" | "no-id" | "refused", templates: "list" as "list" | "object" };
const templates = [
  { id: "meeting", name: "Besprechungen", description: "Protokolle mit Aufgaben und Beschlüssen", icon: "ti ti-users" },
  { id: "handbook", name: "Handbuch", description: "Kapitel, Abläufe und Ansprechpersonen", icon: "ti ti-book" },
];
let httpServer: ReturnType<typeof Bun.serve>;
let browser: Browser;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebooks-start.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-notebooks-start-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the start harness.");
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
      if (request.method === "POST" && (url.pathname === "/api/notebooks" || url.pathname.startsWith("/api/notebooks/templates/"))) {
        created.push({ path: url.pathname, body: await request.json() });
        if (server.creation === "garbled")
          return new Response("<html>gateway</html>", { status: 201, headers: { "content-type": "text/html" } });
        if (server.creation === "no-id") return Response.json({ name: "Inventur 2027" }, { status: 201 });
        if (server.creation === "refused")
          return Response.json({ message: "Ein Notizbuch mit diesem Namen gibt es schon." }, { status: 409 });
        return Response.json({ id: url.pathname === "/api/notebooks" ? "newbook" : "fromtemplate" }, { status: 201 });
      }
      if (url.pathname === "/api/notebooks/templates") return Response.json(server.templates === "list" ? templates : { templates });
      if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      if (url.pathname !== "/app/notebooks")
        return new Response("<!doctype html><title>opened</title>", { headers: { "content-type": "text/html" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root"${url.searchParams.has("switcher") ? "" : ' class="k2-ui"'} style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
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

// every page's errors; opening the new notebook may cut the page's view transition short, which is no error of it
const errors: string[][] = [];
afterEach(() => {
  expect(
    errors
      .splice(0)
      .flat()
      .filter((message) => !message.includes("ViewTransition")),
  ).toEqual([]);
  created.length = 0;
  server.creation = "notebook";
  server.templates = "list";
});
const open = async (width = 1440, path = "/app/notebooks"): Promise<Page> => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : width < 1200 ? 768 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  errors.push(pageErrors(page));
  await page.goto(new URL(path, httpServer.url).href);
  await page.locator(path.includes("switcher") ? "#root button" : "[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const row = (page: Page, name: string) => page.locator('[data-k2-part="Row"]').filter({ hasText: name }).getByRole("button");

for (const width of [1440, 1024, 390]) {
  test(`${width}: without a notebook the page offers the ways to start as rows, a clean v2 workspace`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // a blank notebook, then each template with what it holds; no head that only repeats them
      const rows = page.locator('[data-k2-part="Row"]');
      expect(await rows.count()).toBe(3);
      expect(await rows.nth(1).innerText()).toContain("Protokolle mit Aufgaben und Beschlüssen");
      expect(await page.locator('[data-slot="head"]').count()).toBe(0);
      // the phone's main action floats; wider screens start from the rows
      expect(await page.locator(".k2-fab").isVisible()).toBe(width < 768);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("the blank row makes a notebook after asking its name, and opens it", async () => {
  const page = await open();
  try {
    await row(page, "Leeres Notizbuch").click();
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

test("a template's row opens the dialog on that template, which keeps its name when none is given", async () => {
  const page = await open();
  try {
    await row(page, "Handbuch").click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.waitFor();
    expect(await dialog.getByText("Kapitel, Abläufe und Ansprechpersonen").isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/handbook", body: {} }]);
  } finally {
    await page.close();
  }
}, 60_000);

for (const [answer, says] of [
  ["garbled", "Das Notizbuch konnte nicht aus der Vorlage erstellt werden"],
  ["no-id", "Das Notizbuch konnte nicht aus der Vorlage erstellt werden"],
  ["refused", "Ein Notizbuch mit diesem Namen gibt es schon."],
] as const)
  test(`an answer that is no notebook (${answer}) says so in the dialog, which stays usable and closes`, async () => {
    const page = await open();
    try {
      server.creation = answer;
      await row(page, "Besprechungen").click();
      const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await dialog.getByText(says).waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/notebooks");
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  }, 60_000);

test("the switcher of a page that is not v2 opens the same dialog, which loads the templates and makes one", async () => {
  const page = await open(1440, "/app/notebooks?switcher");
  try {
    await page.getByRole("button", { name: "Notizbuch aus Vorlage" }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.waitFor();
    // a v2 dialog in a v2 scope of its own: it is drawn, not a bare element
    expect(await dialog.evaluate((element) => getComputedStyle(element).borderRadius !== "0px")).toBe(true);
    expect(await dialog.getByText("Protokolle mit Aufgaben und Beschlüssen").isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/meeting", body: {} }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("templates that come as something other than a list say so, and nothing can be made from them", async () => {
  const page = await open(1440, "/app/notebooks?switcher");
  try {
    server.templates = "object";
    await page.getByRole("button", { name: "Notizbuch aus Vorlage" }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.getByText("Die Vorlagen konnten nicht geladen werden.").waitFor();
    expect(await dialog.getByRole("button", { name: "Erstellen" }).isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
