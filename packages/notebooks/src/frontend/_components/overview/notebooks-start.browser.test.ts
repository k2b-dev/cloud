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
/** A way to start as a card: its name is the card's link. */
const card = (page: Page, name: string) => page.locator('[data-k2-part="Tiles"] .k2-tile').filter({ hasText: name }).getByRole("link");
const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Neues Notizbuch" });
/** A card opens the new-notebook dialog on its way to start. */
const start = async (page: Page, name: string) => {
  await card(page, name).click();
  await dialogOf(page).waitFor();
};
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });

for (const width of [1440, 1920, 1024, 390]) {
  test(`${width}: without a notebook the page is one line and four cards in its middle, no nav, a clean v2 page`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // no sidebar, no switcher, no head: only the line and the ways to start
      expect(await page.locator(".k2-ws-side, [data-k2-part='Nav'], .k2-ws-main > [data-slot='head'], .k2-fab").count()).toBe(0);
      expect(await page.getByText("Leg dein erstes Notizbuch an").isVisible()).toBe(true);
      // the blank notebook, then three templates; each with how many pages it makes and the first of them
      const cards = page.locator('[data-k2-part="Tiles"] .k2-tile');
      expect(await cards.allInnerTexts()).toEqual([
        expect.stringContaining("Leeres Notizbuch"),
        expect.stringContaining("Tagebuch"),
        expect.stringContaining("Rezepte und Vorräte"),
        expect.stringContaining("Leseliste"),
      ]);
      expect(await cards.nth(1).innerText()).toContain("6 Seiten");
      expect(await cards.nth(2).locator(".k2-tile-preview").innerText()).toContain("Camembert");
      expect(await cards.nth(0).innerText()).toContain("1 Seite");
      // the fourth template waits in the dialog
      expect(
        await page
          .locator(".k2-tile-title")
          .filter({ hasText: /^Gartentagebuch$/ })
          .count(),
      ).toBe(0);
      const pane = await box(page, '[data-k2-part="Pane"] > .k2-scroll');
      const tiles = await box(page, '[data-k2-part="Tiles"]');
      const tops = await cards.evaluateAll((all) => all.map((element) => Math.round(element.getBoundingClientRect().top)));
      if (width >= 1440) {
        // four in one row, in the middle of the page across and in height
        expect(new Set(tops).size).toBe(1);
        expect(Math.abs(tiles.left - pane.left - (pane.right - tiles.right))).toBeLessThanOrEqual(1);
        const line = await box(page, '[data-k2-part="Pane"] > .k2-scroll > .k2-text');
        expect(Math.abs(line.top - pane.top - (pane.bottom - tiles.bottom))).toBeLessThanOrEqual(1);
      }
      // where four do not fit in one row: 2 × 2, never 3 + 1
      if (width === 1024) expect(new Set(tops).size).toBe(2);
      if (width < 768) {
        // the phone: from the top, the cards 2 × 2 as the approved mockup draws them
        expect(new Set(tops).size).toBe(2);
        const line = await box(page, '[data-k2-part="Pane"] > .k2-scroll > .k2-text');
        expect(line.top - pane.top).toBeLessThan(40);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
}

// break-ui: the longest names and descriptions, an emoji, an address, one letter, Japanese, Arabic and Vietnamese pages,
// a template with 63 pages and one with none, no template at all, and one; the cards and the open dialog
const samples = [
  ["worst", "/app/notebooks?data=worst"],
  ["worst in English", "/app/notebooks?data=worst&lang=en"],
  ["worst, long names in the dialog", "/app/notebooks?data=worst&new=handover"],
  ["no template", "/app/notebooks?data=empty"],
  ["one template", "/app/notebooks?data=one"],
] as const;
for (const [sample, path] of samples)
  for (const width of [390, 1440])
    test(`break-ui ${sample} at ${width}: the page keeps the v2 rules and never scrolls sideways`, async () => {
      const page = await open(width, path);
      try {
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect(layout.problems).toEqual([]);
        expect(layout.measured.texts).toBeGreaterThan(0);
        // every card keeps one shape: a template without a table or page text shows its sign as its preview
        expect(await page.locator(".k2-tile-preview").count()).toBe(await page.locator("[data-k2-part='Tiles'] .k2-tile").count());
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await page.close();
      }
    }, 60_000);

test("the blank card makes a notebook after asking its name, and opens it", async () => {
  const page = await open();
  try {
    await start(page, "Leeres Notizbuch");
    const dialog = dialogOf(page);
    // a blank notebook has no name to offer: without one nothing is made
    expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("");
    await dialog.getByRole("button", { name: "Anlegen" }).click();
    await dialog.getByText("Gib dem Notizbuch einen Namen.").waitFor();
    expect(created).toEqual([]);
    await dialog.getByRole("textbox", { name: "Name" }).fill("Inventur 2027");
    await dialog.getByRole("button", { name: "Anlegen" }).click();
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
    const dialog = dialogOf(page);
    await dialog.getByRole("textbox", { name: "Name" }).fill("Ü".repeat(101));
    await dialog.getByRole("button", { name: "Anlegen" }).click();
    await dialog.getByText("Der Name darf höchstens 100 Zeichen haben.").waitFor();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Inventur 2027");
    await dialog.getByRole("textbox", { name: "Beschreibung" }).fill("a".repeat(501));
    await dialog.getByRole("button", { name: "Anlegen" }).click();
    await dialog.getByText("Die Beschreibung darf höchstens 500 Zeichen haben.").waitFor();
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("a template's card opens the dialog on that template with its name filled in, which one click makes", async () => {
  const page = await open();
  try {
    await start(page, "Rezepte und Vorräte");
    const dialog = dialogOf(page);
    expect(await dialog.getByText("Rezepte, Vorratsbestand, Einkaufsliste und Anregungen für den Einstieg.").isVisible()).toBe(true);
    expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Rezepte und Vorräte");
    await dialog.getByRole("button", { name: "Anlegen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/recipe-collector", body: { name: "Rezepte und Vorräte" } }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("the template's name follows the chosen template until the person writes one of their own", async () => {
  const page = await open();
  try {
    await start(page, "Tagebuch");
    const dialog = dialogOf(page);
    const name = dialog.getByRole("textbox", { name: "Name" });
    expect(await name.inputValue()).toBe("Tagebuch");
    // the fourth template, which has no card, is a choice in the dialog
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "Gartentagebuch" }).click();
    expect(await name.inputValue()).toBe("Gartentagebuch");
    await name.fill("Balkon 2027");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "Leseliste" }).click();
    expect(await name.inputValue()).toBe("Balkon 2027");
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
      await start(page, "Leseliste");
      const dialog = dialogOf(page);
      await dialog.getByRole("button", { name: "Anlegen" }).click();
      await dialog.getByText(says).waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/notebooks");
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  }, 60_000);

test("the open dialog stands in the address: a reload shows it again, back closes it, closing returns to the cards", async () => {
  const page = await open();
  try {
    await start(page, "Leseliste");
    expect(new URL(page.url()).searchParams.get("new")).toBe("reading-list");
    await page.reload();
    await dialogOf(page).getByText("Bücher, Leseliste, Notizen, Zitate und Bewertungen.").waitFor();
    // after a reload the dialog came with the address: closing it removes it from the address in place
    await dialogOf(page).getByRole("button", { name: "Abbrechen" }).click();
    await dialogOf(page).waitFor({ state: "hidden" });
    expect(new URL(page.url()).searchParams.has("new")).toBe(false);
    // opened from a card, back closes it, and closing it goes back, so back never reopens it
    await start(page, "Tagebuch");
    await page.goBack();
    await dialogOf(page).waitFor({ state: "hidden" });
    expect(new URL(page.url()).searchParams.has("new")).toBe(false);
    await start(page, "Tagebuch");
    await page.keyboard.press("Escape");
    await dialogOf(page).waitFor({ state: "hidden" });
    await page.waitForURL((url) => !url.searchParams.has("new"));
    await card(page, "Tagebuch").waitFor();
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

for (const width of [390, 1440])
  test(`${width}: the keyboard alone reaches each way to start, and Enter opens the dialog`, async () => {
    const page = await open(width);
    try {
      const dialog = dialogOf(page);
      const focusOn = async (name: string) => {
        for (let step = 0; step < 20; step += 1) {
          if (await card(page, name).evaluate((element) => element === document.activeElement)) return;
          await page.keyboard.press("Tab");
        }
        throw new Error(`Tab never reached ${name}`);
      };
      await focusOn("Leeres Notizbuch");
      await page.keyboard.press("Enter");
      await dialog.getByRole("textbox", { name: "Name" }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await focusOn("Leseliste");
      await page.keyboard.press("Enter");
      await dialog.getByText("Bücher, Leseliste, Notizen, Zitate und Bewertungen.").waitFor();
      expect(created).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

test("the switcher of a page that is not v2 opens the same dialog, which loads the templates and makes one", async () => {
  const page = await open(1440, "/app/notebooks?switcher");
  try {
    await page.getByRole("button", { name: "Notizbuch aus Vorlage" }).click();
    const dialog = dialogOf(page);
    await dialog.waitFor();
    // a v2 dialog in a v2 scope of its own: it is drawn, not a bare element
    expect(await dialog.evaluate((element) => getComputedStyle(element).borderRadius !== "0px")).toBe(true);
    expect(await dialog.getByText("Protokolle mit Aufgaben und Beschlüssen").isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Anlegen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/meeting", body: { name: "Besprechungen" } }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("templates that come as something other than a list say so, and nothing can be made from them", async () => {
  const page = await open(1440, "/app/notebooks?switcher");
  try {
    server.templates = "object";
    await page.getByRole("button", { name: "Notizbuch aus Vorlage" }).click();
    const dialog = dialogOf(page);
    await dialog.getByText("Die Vorlagen konnten nicht geladen werden.").waitFor();
    expect(await dialog.getByRole("button", { name: "Anlegen" }).isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(created).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
