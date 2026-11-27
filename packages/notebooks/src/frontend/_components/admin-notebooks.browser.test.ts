import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

const ui = `${resolve(import.meta.dir, "../../../../ui")}/`;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const deletes: string[] = [];
const accessLoads: string[] = [];
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
      // a notebook's access, as the platform's dialog shows it
      const access = /^\/api\/notebooks\/(\w+)\/access$/.exec(url.pathname);
      if (access && request.method === "GET") {
        accessLoads.push(access[1]!);
        return Response.json([]);
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

// every page's errors; a view transition that a navigation cuts short is the browser's, not the page's
const errors: string[][] = [];
afterEach(() => {
  expect(
    errors
      .splice(0)
      .flat()
      .filter((message) => !message.includes("ViewTransition")),
  ).toEqual([]);
});
const open = async (path: string, width = 1440) => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  errors.push(pageErrors(page));
  await page.goto(new URL(path, server.url).href);
  await page.locator("[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};

const row = (page: Page, name: string) => page.locator('[data-k2-part="Table"] tbody tr', { hasText: name });

for (const width of [1440, 1024, 390]) {
  test(`${width}: the notebooks are a clean v2 admin screen led by how many were used, with what needs a look`, async () => {
    const page = await open("/admin/notebooks", width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // the admin bar and the shell name the page: the head holds only its deeds
      expect(await page.locator('[data-slot="head"] .k2-bar-start').count()).toBe(0);
      // the hero: how many notebooks were used in 30 days, of how many, with its trend
      const hero = page.getByRole("region", { name: "aktiv in 30 Tagen" });
      expect((await hero.locator('[data-k2-part="Inline"]').first().textContent())?.replace(/\s+/g, " ")).toBe(
        "18aktiv in 30 Tagenvon 24 Notizbüchern",
      );
      expect(await hero.locator('[data-k2-part="Spark"]').getAttribute("aria-label")).toMatch(/^Notizbücher mit Änderungen je Tag/);
      // the exceptions on one line under the figure, "● n word · who": only the dot carries the colour, no pill
      const exceptions = hero.locator('[data-k2-part="Inline"]').nth(1);
      expect((await exceptions.textContent())?.replace(/[⁨⁩]/g, "")).toBe(
        "● 1 ohne Zugriff· Altes Wiki● 6 ohne Änderung seit 30 Tagen· Altes Wiki, Archiv 2025 +4",
      );
      expect(await exceptions.locator('[data-tone="bad"]').textContent()).toBe("●");
      expect(await exceptions.locator('[data-tone="warn"]').textContent()).toBe("●");
      expect(await hero.locator('[data-k2-part="Chip"]').count()).toBe(0);
      // every notebook carries its mark, also in the phone's rows
      expect(await page.locator('[data-k2-part="Pane"] [data-k2-part="Mark"]').filter({ visible: true }).count()).toBeGreaterThanOrEqual(8);
      if (width > 600) {
        expect(await page.locator('[data-k2-part="Table"] tbody tr').count()).toBe(24);
        expect(await page.getByRole("columnheader").allTextContents()).toEqual(["Notizbuch", "Zugriff", "Notizen", "Zuletzt"]);
        // the table fits beside the admin bar: no column runs out of sight
        expect(await page.locator(".k2-table-scroll").evaluate((scroll) => scroll.scrollWidth <= scroll.clientWidth)).toBe(true);
        // the one picture of a row: who has access; nobody is the exception, in red with its word
        expect(await row(page, "Handbuch Lager").locator('[data-k2-part="Avatar.Stack"]').getAttribute("aria-label")).toBe("6 mit Zugriff");
        expect((await row(page, "Handbuch Lager").locator("td").nth(2).textContent())?.trim()).toBe("148");
        const nobody = row(page, "Altes Wiki").locator("td").nth(1);
        expect((await nobody.textContent())?.trim()).toBe("●niemand");
        expect(await nobody.locator('[data-tone="bad"]').textContent()).toBe("●");
        expect(await nobody.locator('[data-k2-part="Chip"]').count()).toBe(0);
        // a long standstill waits; an unknown last change says so
        expect(await row(page, "Altes Wiki").locator("td").nth(3).locator('[data-tone="warn"]').count()).toBe(1);
        expect((await row(page, "Recht").locator("td").nth(3).textContent())?.trim()).toBe("unbekannt");
      } else {
        // two lines per row: the name, then who can reach it and its notes; the exception in red in that line
        expect(await page.getByText("6 mit Zugriff · 148 Notizen").isVisible()).toBe(true);
        expect(await page.getByText("Niemand hat Zugriff").first().isVisible()).toBe(true);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("a notebook opens beside the list from its row, with its changes, access, writers and history", async () => {
  const page = await open("/admin/notebooks");
  try {
    // no detail while none is open: the list has the whole width
    expect(await page.locator('[data-k2-part="Pane"][data-detail]').count()).toBe(0);
    await row(page, "Handbuch Lager").getByRole("link", { name: "Handbuch Lager" }).click();
    await page.waitForURL((url) => url.searchParams.get("open") === "nb0000");
    const detail = page.locator('[data-k2-part="Pane"][data-detail]');
    await detail.waitFor();
    expect(await detail.getAttribute("aria-label")).toBe("Handbuch Lager");
    expect(await detail.locator('[data-k2-part="Cells.Cell"]').count()).toBe(3);
    expect(await detail.getByRole("region", { name: "Zugriff" }).getByText("Ada Renz").isVisible()).toBe(true);
    expect(await detail.getByRole("region", { name: "Wer schreibt" }).getByText("42 Änderungen").isVisible()).toBe(true);
    expect(await detail.getByRole("region", { name: "Verlauf" }).getByText("Wareneingang", { exact: false }).first().isVisible()).toBe(
      true,
    );
    // the list keeps its width beside it, and the open row is marked
    expect(
      await page.locator('[data-k2-part="Pane"]:not([data-detail])').evaluate((pane) => pane.getBoundingClientRect().width),
    ).toBeLessThan(700);
    // closing returns to the list as it was
    expect(await detail.getByRole("link", { name: "Schließen" }).getAttribute("href")).toBe("/admin/notebooks");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

test("an open notebook nobody can reach says so at its head, with the way to give access", async () => {
  const page = await open("/admin/notebooks?open=nb0004");
  try {
    const notice = page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Notice"]');
    expect(await notice.getAttribute("data-tone")).toBe("bad");
    expect(await notice.getByText("Niemand hat Zugriff").isVisible()).toBe(true);
    expect(await notice.getByRole("button", { name: "Berechtigungen" }).isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

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
    // nothing found is said once, by the empty table, which offers to reset the search; no figures
    expect(await empty.locator('[data-k2-part="Band"]').count()).toBe(0);
    expect(await empty.getByRole("link", { name: "Suche zurücksetzen" }).getAttribute("href")).toBe("/admin/notebooks");
  } finally {
    await empty.close();
  }
}, 60_000);

test("the open notebook's menu deletes after asking, and a refused delete says so in a few fixed words", async () => {
  const page = await open("/admin/notebooks?open=nb0004");
  try {
    await page.getByRole("button", { name: "Aktionen für Altes Wiki" }).click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    // nothing happens before the question is answered
    await page.getByRole("alertdialog").waitFor();
    expect(deletes).toEqual([]);
    // the menu has closed: the question stands alone
    expect(await page.getByRole("menu").filter({ visible: true }).count()).toBe(0);
    await page.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
    await page.locator('[data-k2-part="Toast"]').getByText("Notizbuch nicht gelöscht").waitFor();
    // the server's words stay out of the toast
    expect(await page.locator('[data-k2-part="Toast"]').getByText("Das Notizbuch ist gesperrt.").count()).toBe(0);
    expect(deletes).toEqual(["nb0004"]);
  } finally {
    deletes.length = 0;
    await page.close();
  }
}, 60_000);

test("a network that fails says so in fixed words, for the access and for deleting", async () => {
  const page = await open("/admin/notebooks?open=nb0000");
  try {
    await page.route("**/api/notebooks/**", (route) => route.abort("internetdisconnected"));
    const menu = page.getByRole("button", { name: "Aktionen für Handbuch Lager" });
    await menu.click();
    await page.getByRole("menuitem", { name: "Berechtigungen" }).click();
    await page.locator('[data-k2-part="Toast"]').getByText("Zugriff nicht geladen").waitFor();
    await menu.click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
    await page.locator('[data-k2-part="Toast"]').getByText("Notizbuch nicht gelöscht").waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("more notebooks than one page holds go on with Weiter", async () => {
  const page = await open("/admin/notebooks?pages=2");
  try {
    expect(await page.getByText("Seite 1 von 2").isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "Weiter" }).getAttribute("href")).toBe("/admin/notebooks?page=2");
  } finally {
    await page.close();
  }
}, 60_000);

test("Berechtigungen loads the notebook's access, closes the menu and opens the access dialog", async () => {
  const page = await open("/admin/notebooks?open=nb0000");
  try {
    const menu = page.getByRole("button", { name: "Aktionen für Handbuch Lager" });
    await menu.click();
    await page.getByRole("menuitem", { name: "Berechtigungen" }).click();
    await page.getByRole("dialog").filter({ hasText: "Handbuch Lager" }).waitFor();
    expect(accessLoads).toEqual(["nb0000"]);
    // the menu closed once the access had loaded; it does not wait busy behind the dialog
    expect(await page.getByRole("menu").filter({ visible: true }).count()).toBe(0);
    expect(await menu.getAttribute("aria-busy")).not.toBe("true");
  } finally {
    accessLoads.length = 0;
    await page.close();
  }
}, 60_000);

/** Tabs forward until the focus stands on `target` (at most `limit` presses), as a person with a keyboard does. */
const tabTo = async (page: Page, target: Locator, limit = 60) => {
  for (let press = 0; press < limit; press++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("The target was not reached with Tab");
};

/** Moves through an open menu with the arrow key until `name` has the focus (a menu has few items). */
const arrowTo = async (page: Page, name: string) => {
  for (let press = 0; press < 6; press++) {
    if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === name) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`${name} not reached with the arrow key`);
};

// The row menu of earlier versions held Berechtigungen and Löschen; both stay one menu away in the open notebook.
for (const width of [1440, 390]) {
  test(`${width}: every deed of a notebook is reachable by keyboard alone: open it, then its menu`, async () => {
    const page = await open("/admin/notebooks", width);
    try {
      await tabTo(page, page.getByRole("link", { name: /^Handbuch Lager/ }).filter({ visible: true }));
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.searchParams.get("open") === "nb0000");
      await page.locator('[data-k2-part="Pane"][data-detail]').waitFor();
      await tabTo(page, page.getByRole("button", { name: "Aktionen für Handbuch Lager" }).filter({ visible: true }));
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu").filter({ visible: true });
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Berechtigungen", "Löschen"]);
      // Berechtigungen by keys: the access dialog opens

      await arrowTo(page, "Berechtigungen");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").filter({ hasText: "Handbuch Lager" }).waitFor();
      await page.keyboard.press("Escape");
      // Löschen by keys: the question comes, and nothing is deleted before it is answered
      await tabTo(page, page.getByRole("button", { name: "Aktionen für Handbuch Lager" }).filter({ visible: true }));
      await page.keyboard.press("Enter");
      await menu.waitFor();
      await arrowTo(page, "Löschen");
      await page.keyboard.press("Enter");
      await page.getByRole("alertdialog").waitFor();
      expect(deletes).toEqual([]);
      await page.keyboard.press("Escape");
    } finally {
      deletes.length = 0;
      accessLoads.length = 0;
      await page.close();
    }
  }, 60_000);
}

test("an open notebook the reader holds no grant on shows its figures and no note titles", async () => {
  const page = await open("/admin/notebooks?open=nb0000&history=hidden");
  try {
    const history = page.locator('[data-k2-part="Pane"][data-detail]').getByRole("region", { name: "Verlauf" });
    expect(await history.getByText("Den Verlauf sehen nur Mitglieder dieses Notizbuchs", { exact: false }).isVisible()).toBe(true);
    expect(await history.locator('[data-k2-part="Digest"]').count()).toBe(0);
    expect(await page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Cells.Cell"]').count()).toBe(3);
  } finally {
    await page.close();
  }
}, 60_000);

test("390: an open notebook is a page of its own with a way back, and its deeds stay reachable", async () => {
  const page = await open("/admin/notebooks?open=nb0004", 390);
  try {
    expect(await page.getByRole("link", { name: "Notizbücher" }).filter({ visible: true }).getAttribute("href")).toBe("/admin/notebooks");
    expect(await page.locator('[data-k2-part="Table"]').filter({ visible: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Aktionen für Altes Wiki" }).filter({ visible: true }).click();
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

for (const width of [1440, 390]) {
  test(`${width}: the worst an installation holds stays inside the screen, in the language's digits`, async () => {
    const page = await open("/admin/notebooks?data=worst&open=wc0000", width);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (width > 600) {
        const hero = page.getByRole("region", { name: "aktiv in 30 Tagen" });
        // the exceptions name 120-sign names cut to a few words, so the band never runs past its pane
        expect(await hero.evaluate((band) => band.scrollWidth <= band.clientWidth)).toBe(true);
        expect(await hero.getByText("9.302").isVisible()).toBe(true);
        expect(await hero.getByText("1.204 ohne Zugriff").isVisible()).toBe(true);
        expect(await hero.getByText(/Qualitätsmanagementhand…⁩, ⁨https:\/\/wiki\.northwind-…⁩ \+1\.202$/).isVisible()).toBe(true);
        expect(await page.locator(".k2-table-scroll").evaluate((scroll) => scroll.scrollWidth <= scroll.clientWidth)).toBe(true);
        // a five-digit access count: three faces and the rest as one quiet "+n", never two
        const access = row(page, "Alle Mitarbeitenden").locator("td").nth(1);
        expect(await access.getByText("+12.477").isVisible()).toBe(true);
        expect(await access.locator(".k2-avs-rest").filter({ visible: true }).count()).toBe(0);
      }
      // the open notebook's name is cut in its head, never pushing its deeds away
      expect(
        await page
          .getByRole("button", { name: /^Aktionen für Qualitätsmanagementhandbuch/ })
          .filter({ visible: true })
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("390: the worst rows keep two lines in the language's digits", async () => {
  const page = await open("/admin/notebooks?data=worst", 390);
  try {
    // the exception line keeps inside its band: the names move to the next line, never past the edge
    const band = page.getByRole("region", { name: "aktiv in 30 Tagen" });
    expect(await band.evaluate((element) => element.scrollWidth <= element.clientWidth && element.clientWidth > 0)).toBe(true);
    expect(await page.getByText("12.480 mit Zugriff · 48.213 Notizen").isVisible()).toBe(true);
    expect(await page.getByText("1 mit Zugriff · 1 Notiz").first().isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);
