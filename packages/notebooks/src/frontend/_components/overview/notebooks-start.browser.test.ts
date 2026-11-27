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
const row = (page: Page, name: string) =>
  page.locator('[data-k2-part="List"] [data-k2-part="Row"]').filter({ hasText: name }).getByRole("button");
const detail = (page: Page) => page.locator('[data-k2-part="Pane"][data-detail]');
/** Wide screens: a way to start opens beside the list, and its one main action opens the dialog. */
const start = async (page: Page, name: string) => {
  await row(page, name).click();
  await detail(page).locator('[data-slot="head"]').getByText(name).first().waitFor();
  await detail(page).getByRole("button", { name: "Erstellen" }).click();
};

for (const width of [1440, 1024, 390]) {
  test(`${width}: without a notebook the page offers the ways to start as rows, a clean v2 workspace`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // a blank notebook, then each template with what it holds; the rows are the actions, so no head and no
      // floating action repeat them
      const rows = page.locator('[data-k2-part="List"] [data-k2-part="Row"]');
      expect(await rows.count()).toBe(3);
      expect(await rows.nth(1).innerText()).toContain("Protokolle mit Aufgaben und Beschlüssen");
      expect(await page.locator('.k2-ws-main > [data-slot="head"]').count()).toBe(0);
      expect(await page.locator(".k2-fab").count()).toBe(0);
      // none is open yet: beside the list its place says how to go on; the phone keeps only the list
      expect(await detail(page).count()).toBe(0);
      expect(await page.getByText("Wähle, womit dein Notizbuch beginnt").isVisible()).toBe(width >= 768);
    } finally {
      await page.close();
    }
  }, 60_000);
}

// break-ui: the longest names and descriptions, an emoji, an address, one letter, Japanese, Arabic and Vietnamese pages,
// a template with 63 pages and one with none, no template at all, and one; the list and an open way to start
const samples = [
  ["worst", "/app/notebooks?data=worst"],
  ["worst in English", "/app/notebooks?data=worst&lang=en"],
  ["worst, 63 pages open", "/app/notebooks?data=worst&template=daily"],
  ["worst, long names open", "/app/notebooks?data=worst&template=handover"],
  ["worst, no pages open", "/app/notebooks?data=worst&template=j"],
  ["no template", "/app/notebooks?data=empty"],
  ["one template", "/app/notebooks?data=one"],
] as const;
for (const [sample, path] of samples)
  for (const width of [390, 1440])
    test(`break-ui ${sample} at ${width}: the workspace keeps the v2 rules and the page never scrolls sideways`, async () => {
      const page = await open(width, path);
      try {
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
        expect(layout.measured.texts).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await page.close();
      }
    }, 60_000);

test("the blank row makes a notebook after asking its name, and opens it", async () => {
  const page = await open();
  try {
    await start(page, "Leeres Notizbuch");
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

test("a name or description longer than the server keeps says so in the dialog and sends nothing", async () => {
  const page = await open();
  try {
    await start(page, "Leeres Notizbuch");
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Ü".repeat(101));
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Der Name darf höchstens 100 Zeichen haben.").waitFor();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Inventur 2027");
    await dialog.getByRole("textbox", { name: "Beschreibung" }).fill("a".repeat(501));
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Die Beschreibung darf höchstens 500 Zeichen haben.").waitFor();
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("a template's row opens the dialog on that template, which keeps its name when none is given", async () => {
  const page = await open();
  try {
    await start(page, "Handbuch");
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
      await start(page, "Besprechungen");
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

test("a way to start opens beside the list, stays in the address, and comes back on reload", async () => {
  const page = await open();
  try {
    await row(page, "Handbuch").click();
    await detail(page).getByText("Annahme prüfen").waitFor();
    // the open row is the current one, and its pages name the page they stand under
    expect(await row(page, "Handbuch").locator("xpath=..").getAttribute("data-current")).toBe("");
    expect(new URL(page.url()).searchParams.get("template")).toBe("handbook");
    await page.reload();
    await detail(page).getByText("Annahme prüfen").waitFor();
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("the keyboard alone reaches each way to start, and Enter or Space opens the dialog", async () => {
  const page = await open(390);
  try {
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    const focusOn = async (name: string) => {
      for (let step = 0; step < 20; step += 1) {
        if (await row(page, name).evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press("Tab");
      }
      throw new Error(`Tab never reached ${name}`);
    };
    await focusOn("Leeres Notizbuch");
    await page.keyboard.press("Enter");
    await dialog.getByRole("textbox", { name: "Name" }).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await focusOn("Handbuch");
    await page.keyboard.press("Space");
    await dialog.getByText("Kapitel, Abläufe und Ansprechpersonen").waitFor();
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("on a wide screen the keyboard opens a way to start beside the list", async () => {
  const page = await open(1440);
  try {
    await row(page, "Handbuch").focus();
    await page.keyboard.press("Enter");
    await detail(page).locator('[data-slot="head"]').getByText("Handbuch").first().waitFor();
    await detail(page).getByRole("button", { name: "Erstellen" }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("dialog", { name: "Neues Notizbuch" }).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("on the phone a way to start opens the dialog right away", async () => {
  const page = await open(390);
  try {
    await row(page, "Handbuch").click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.getByText("Kapitel, Abläufe und Ansprechpersonen").waitFor();
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/handbook", body: {} }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("on the phone a shared address opens the way to start as a page, with its way back and its main action", async () => {
  const page = await open(390, "/app/notebooks?template=handbook");
  try {
    await detail(page).getByText("Annahme prüfen").waitFor();
    expect(await page.getByRole("link", { name: "Notizbücher" }).getAttribute("href")).toBe("/app/notebooks");
    await detail(page).getByRole("button", { name: "Erstellen" }).click();
    await page.getByRole("dialog", { name: "Neues Notizbuch" }).getByText("Kapitel, Abläufe und Ansprechpersonen").waitFor();
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
