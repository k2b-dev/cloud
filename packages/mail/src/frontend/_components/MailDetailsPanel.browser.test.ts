import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { MailDetailsHarnessState } from "./MailDetailsPanel.browser-harness";

// The details outline, its file rows, and row actions are a question of layout and paint, so the real panel runs in
// a browser with invented data. The server stands in for the conversation context, related mail, and attachments.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailDetailsPanel.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-details-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail details harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const uiDist = resolve(import.meta.dir, "../../../../ui/dist");
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
const preview = (hue: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 78%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 50% 58%)"/></linearGradient></defs><rect width="40" height="30" fill="url(#g)"/></svg>`;
/** The Spaces part of the conversation context fails while this is set. */
let spacesFail = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    // Type and icons from the UI build, so screenshots show the real glyphs.
    if (pathname.startsWith("/ui-dist/")) return new Response(Bun.file(resolve(uiDist, pathname.slice("/ui-dist/".length))));
    if (pathname.endsWith("/context"))
      return Response.json({
        conversationId: "Conv01",
        participants: [
          { email: "kai@nordlicht-druck.example", displayName: "Kai Brandt" },
          { email: "info@nordlicht-druck.example", displayName: null },
        ],
        contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
        spaces: spacesFail
          ? { status: "unavailable", items: [], truncated: false }
          : {
              status: "ready",
              truncated: false,
              items: [
                {
                  ref: { type: "spaces.item", id: "Task142" },
                  title: "Broschüre freigeben",
                  icon: "ti ti-layout-kanban",
                  metadata: [{ label: "Space", value: "Messe Frühjahr · In Arbeit" }],
                  links: [{ rel: "open", href: "/app/spaces/Spc01?item=Task142" }],
                },
              ],
            },
      });
    if (pathname.endsWith("/related"))
      return Response.json([
        {
          id: "Conv02",
          subject: "Angebot Broschüre 2026",
          participantSummary: "Druckerei Nordlicht",
          latestMessageAt: "2026-10-14T09:00:00.000Z",
          preview: null,
          reasons: [{ kind: "participant", value: "kai@nordlicht-druck.example" }],
        },
      ]);
    if (/\/attachments\/Att\d+$/.test(pathname)) {
      const hue = (Number(pathname.slice(-2)) * 37) % 360;
      return new Response(preview(hue), { headers: { "Content-Type": "image/svg+xml" } });
    }
    return new Response(
      '<!doctype html><html class="light" lang="de" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/ui-dist/plex.css"><link rel="stylesheet" href="/ui-dist/tabler.css"></head><body class="k2b-ui" style="margin:0;background:var(--k2b-surface)">' +
        '<div id="root" style="width:min(25rem,100%);height:100dvh;display:flex;flex-direction:column"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 1600 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 1600 }, isMobile: true, hasTouch: true };
const shots = process.env.MAIL_DETAILS_SHOTS;

const open = async (state: MailDetailsHarnessState, context: BrowserContextOptions = desktop, dark = false): Promise<Page> => {
  const page = await (await browser.newContext({ ...context, colorScheme: dark ? "dark" : "light" })).newPage();
  await page.goto(server.url.href);
  if (dark) await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((state) => window.mountDetails(state), state);
  if (state !== "loading") await page.locator(".k2b-detail-panel").waitFor();
  await page.waitForFunction(() => !document.querySelector('.k2b-placeholder[data-state="loading"]'));
  await settled(page);
  return page;
};
const shot = async (page: Page, name: string) => {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}.png`,
      clip: { x: 0, y: 0, width: Math.min(400, page.viewportSize()!.width), height: 1600 },
    });
};
const sectionTitles = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        ".k2b-detail-panel__section-header h3, .k2b-detail-panel__section-title, .k2b-discussion__header h3, .k2b-detail-panel__group-title",
      ),
    )
      .filter((element) => !element.closest("[hidden]"))
      .map((element) => element.textContent?.trim()),
  );

describe("Mail conversation details in the shared outline", () => {
  test("keeps the fixed order and merges only files with equal content", async () => {
    const page = await open("normal");
    try {
      expect(await sectionTitles(page)).toEqual([
        "Eigenschaften",
        "Verknüpft",
        "Anhänge",
        "Team-Notizen",
        "Mehr zu dieser Unterhaltung",
        "Personen",
        "Aktivität",
        "Technische Details",
      ]);
      // 5 attachments, the brochure twice with the same content: 4 rows, documents before images.
      expect(await page.locator(".k2b-file-grid__name").allTextContents()).toEqual([
        "Kalkulation-Druck.xlsx",
        "Broschüre-v3.pdf",
        "Seite-4-neu.jpg",
        "Seite-7-neu.jpg",
      ]);
      expect(await page.locator(".k2b-file-grid__meta").nth(1).textContent()).toBe("PDF · 4,2 MB · in 2 Nachrichten");
      expect(await page.locator(".k2b-file-grid__preview img").count()).toBe(2);
      expect(await page.getByText("✦ KI").count()).toBe(1);
      expect(await page.locator(".k2b-detail-panel__action-title", { hasText: "Broschüre freigeben" }).count()).toBe(1);
      expect(await page.getByText("Angebot Broschüre 2026").count()).toBe(1);
      await shot(page, "01-mail-normal-light-1440");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("many files: the first five, Show all opens files and images, and By message shows each message", async () => {
    const page = await open("many");
    try {
      const more = page.getByRole("button", { name: /Alle 17 anzeigen/ });
      expect(await more.textContent()).toContain("4 doppelte zusammengefasst");
      await shot(page, "02-mail-viele-kurz-light-1440");
      await more.click();
      await settled(page);
      expect(await page.locator(".mail-details-files-info").textContent()).toBe("17 Dateien aus 21 Anhängen · 4 doppelte zusammengefasst");
      expect(await page.locator(".k2b-file-grid-stack__label").allTextContents()).toEqual(["Dateien6", "Bilder11"]);
      // Equal names with different content stay apart and name their sender.
      expect(await page.locator(".k2b-file-grid__meta", { hasText: "von Lena Hoffmann" }).count()).toBe(1);
      expect(await page.locator(".k2b-file-grid__meta", { hasText: "von Druckerei Nordlicht" }).count()).toBe(1);
      await shot(page, "03-mail-viele-alle-light-1440");
      await page.getByRole("radio", { name: "Nach Nachricht" }).click();
      await settled(page);
      const labels = await page.locator(".k2b-file-grid-stack__label").allTextContents();
      expect(labels).toHaveLength(3);
      expect(labels[0]).toContain("Lena Hoffmann");
      expect(labels[2]).toContain("Mira Okafor");
      await shot(page, "04-mail-nach-nachricht-light-1440");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("row actions wait for hover and focus inside the row, without moving anything", async () => {
    const page = await open("normal");
    try {
      const row = page.locator(".k2b-file-grid__item").first();
      const actions = row.locator(".k2b-file-grid__actions");
      const before = await row.boundingBox();
      expect(await actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      await row.hover();
      await settled(page);
      expect(await actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await row.boundingBox()).toEqual(before);
      await shot(page, "05-mail-zeile-hover-light-1440");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  for (const [state, name] of [
    ["empty", "06-mail-leer"],
    ["loading", "07-mail-laedt"],
    ["readonly", "09-mail-nur-lesen"],
  ] as const) {
    test(`${state} state renders its own lines`, async () => {
      const page = await open(state);
      try {
        if (state === "empty") {
          expect(await page.getByText("Keine Anhänge").count()).toBe(1);
          expect(await page.locator(".k2b-description-list__item", { hasText: "Zugewiesen" }).textContent()).toContain("Niemand");
        }
        if (state === "loading") expect(await page.locator('.mail-details-skeleton[role="status"]').count()).toBe(1);
        if (state === "readonly") {
          expect(await page.getByText("Nur lesen", { exact: true }).count()).toBe(1);
          expect(await page.getByText("Als erledigt markieren").count()).toBe(0);
          expect(await page.getByText("Aufgabe in Spaces erstellen").count()).toBe(0);
        }
        await shot(page, `${name}-light-1440`);
      } finally {
        await page.context().close();
      }
    }, 60_000);
  }

  test("a failed part shows its error where it happened and keeps the rest usable", async () => {
    spacesFail = true;
    const page = await open("normal");
    try {
      const linked = page.locator("section", { has: page.locator("h3", { hasText: "Verknüpft" }) });
      expect(await linked.getByText("Verknüpfungen aus Spaces lassen sich gerade nicht laden.", { exact: false }).count()).toBe(1);
      expect(await linked.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
      expect(await page.locator(".k2b-file-grid__name").count()).toBe(4);
      await shot(page, "08-mail-fehler-light-1440");
    } finally {
      spacesFail = false;
      await page.context().close();
    }
  }, 60_000);

  test("on a phone and on touch, row actions show at once and rows are 3.5rem", async () => {
    const page = await open("normal", phone);
    try {
      await page.evaluate(() => document.documentElement.setAttribute("data-k2b-input", "touch"));
      await settled(page);
      const row = page.locator(".k2b-file-grid__item").first();
      expect(await row.locator(".k2b-file-grid__actions").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(Math.round((await row.boundingBox())!.height)).toBe(56);
      await shot(page, "10-mail-telefon-light-390");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("dark", async () => {
    const page = await open("many", desktop, true);
    try {
      await shot(page, "02-mail-viele-kurz-dark-1440");
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
