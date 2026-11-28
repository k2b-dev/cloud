import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appAccentStyle, appV2InkStyle } from "@k2b/cloud/ssr/app-appearance";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import "../../ssr-test-plugin";
import { app } from "../../../config";
import type { PublicStatus } from "../../../contracts";
import { formatPhone } from "../../../phone-format";
import { type GuestState, guestStates } from "./guest-page.browser-fixture";

// The two guest pages of a venue on v2, as the server renders them inside `MinimalLayout ui="v2"`: the guest page in
// every state of the approved mockup (it reads without a script, so the browser gets the server's page alone), and the
// feedback page, whose form comes alive as its island. Layout rules at 390, 1024, 1440 and 1920 px, the worst case,
// and the feedback flow with a failed send, a rate limit, a send that arrives and feedback that closed meanwhile.
const { MinimalLayout } = await import("@k2b/cloud/ssr");
const { GuestPage, GuestUnavailable } = await import("./guest-page");
const { GuestFeedbackPage } = await import("./feedback/guest-feedback-page");

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;
type Route = Parameters<Extract<Parameters<Page["route"]>[1], (...args: never[]) => unknown>>[0];

const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shotsDir = process.env.CLOUD_VENUE_GUEST_SHOTS;
const shots = shotsDir ? resolve(import.meta.dir, "../../../..", shotsDir) : undefined;

type View = { name: string; width: number; height: number; touch: boolean };
const phone: View = { name: "390", width: 390, height: 844, touch: true };
const tablet: View = { name: "1024", width: 1024, height: 768, touch: true };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const wide: View = { name: "1920", width: 1920, height: 1080, touch: false };

/** The page's HTML as the server sends it: the layout's frame and footer, the venue app's colours on the body. */
const serverPage = (content: () => JSX.Element, address: string) => {
  const page: { appUi?: "v2"; appAccent?: string } = {};
  const context = {
    get: (key: string) =>
      key === "page"
        ? page
        : key === "runtime"
          ? {
              apps: [
                {
                  id: "legal",
                  routes: [],
                  legalLinks: [
                    { label: "Impressum", href: "/impressum" },
                    { label: "Datenschutz", href: "/datenschutz" },
                  ],
                },
              ],
            }
          : undefined,
    req: { raw: { headers: new Headers({ "Accept-Language": "de" }), url: `${origin}${address}` } },
  } as unknown as Parameters<typeof MinimalLayout>[0]["c"];
  const html = renderToString(() =>
    createComponent(MinimalLayout, {
      c: context,
      ui: "v2",
      get children() {
        return content();
      },
    }),
  );
  // the venue app's colour, as the document template puts it on the body of a v2 page
  const accent = app.meta.appearance?.accent;
  const style = [appAccentStyle(accent), appV2InkStyle(accent)].filter(Boolean).join(";");
  return { html, style };
};

const guestHtml = (status: PublicStatus | null) =>
  serverPage(
    () =>
      status
        ? createComponent(GuestPage, { status, feedbackUrl: `/app/venue/public/${status.venue.id}/feedback`, phone: formatPhone })
        : createComponent(GuestUnavailable, {}),
    "/app/venue/public/Cafe01",
  );
const feedbackHtml = (status: PublicStatus | null) =>
  serverPage(
    () => createComponent(GuestFeedbackPage, { status, backUrl: `/app/venue/public/${status?.venue.id ?? "Gone01"}` }),
    "/app/venue/public/Cafe01/feedback",
  );

let browser: Browser;
let css: string;
let island: string;

/** The feedback form's island as the browser runs it: rendered into the server's island in place of hydration. */
const buildIsland = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "feedback/guest-feedback.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-venue-guest-feedback-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Venue guest feedback harness build failed");
  return build.outputs[0]!.text();
};

beforeAll(async () => {
  island = await buildIsland();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const styles = [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type Feedback = { status: number } | "abort" | "hold";
type Opened = { context: BrowserContext; tab: Page; errors: string[]; sends: unknown[]; release: (status: number) => void };

const open = async (view: View, page: { html: string; style: string }, options: { island?: object; answers?: Feedback[] } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
    timezoneId: "Europe/Berlin",
    locale: "de-DE",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const sends: unknown[] = [];
  const answers = [...(options.answers ?? [])];
  let held: Route | undefined;
  const release = (status: number) => void held?.fulfill({ status, json: {} });
  const script = options.island
    ? `<script id="island-props" type="application/json">${JSON.stringify(options.island)}</script><script src="/island.js"></script>`
    : "";
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/island.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: island });
    // the fonts and the Tabler preset with every one of its font faces, as @k2b/ui builds them
    if (url.pathname.startsWith("/ui/")) return route.fulfill({ path: resolve(ui, "dist", url.pathname.slice(4)) });
    if (url.pathname.startsWith("/api/venue/public/") && url.pathname.endsWith("/feedback")) {
      sends.push(JSON.parse(route.request().postData() ?? "null"));
      const answer = answers.shift() ?? { status: 201 };
      if (answer === "abort") return route.abort("failed");
      if (answer === "hold") {
        held = route;
        return;
      }
      return route.fulfill({ status: answer.status, json: answer.status === 201 ? { rating: 4 } : { message: "No" } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404, json: { message: "Not found" } });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<link rel="stylesheet" href="${origin}/ui/plex.css"><link rel="stylesheet" href="${origin}/ui/tabler.css"><style>${css}</style></head>` +
        `<body class="k2b-ui" style="${page.style}">${page.html}${script}</body></html>`,
    });
  });
  await tab.goto(`${origin}/app/venue/public/Cafe01`);
  await tab.evaluate(() => window.document.fonts.ready);
  if (options.island) await tab.waitForSelector("body[data-island-ready]");
  await settled(tab);
  return { context, tab, errors, sends, release } satisfies Opened;
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

/** The layout rules every guest page keeps: no findings in the outline or the measurement, nothing wider than the window. */
const expectClean = async (tab: Page, width: number) => {
  const outline = await describeV2Page(tab, "main");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // the first view comes with its data: nothing loads
  expect(await tab.locator('[data-k2-part="Loading"], [aria-busy="true"]').count()).toBe(0);
};

const box = (tab: Page, selector: string) =>
  tab
    .locator(selector)
    .first()
    .evaluate(
      (element) => element.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number; width: number },
    );

describe("Venue guest page on v2", () => {
  const states: GuestState[] = ["open", "later", "closed", "exception", "nosections", "nobrand", "nofeedback", "bar", "worst", "breaks"];
  for (const state of states)
    for (const view of [phone, tablet, desktop, wide])
      test(`${state} at ${view.name} px keeps the layout rules`, async () => {
        const { context, tab, errors } = await open(view, guestHtml(guestStates[state]()));
        try {
          await expectClean(tab, view.width);
          // the one task stays in the head on the phone too, and leads to the feedback page
          const rate = tab.getByRole("link", { name: "Bewerten" });
          if (state === "nofeedback") expect(await rate.count()).toBe(0);
          else {
            expect(await rate.isVisible()).toBe(true);
            expect(await rate.getAttribute("href")).toMatch(/\/app\/venue\/public\/\w+\/feedback$/);
          }
          // the guest page reads without a script: the server's page is all there is
          expect(await tab.locator("main solid-island, main script").count()).toBe(0);
          await shoot(tab, `guest-${state}-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);

  test("the hero says now first, then the sections in the admin's order, with the week beside them on a wide screen", async () => {
    const status = guestStates.open();
    const { context, tab } = await open(desktop, guestHtml(status));
    try {
      const main = tab.locator('[data-k2-part="Pane"]').first();
      const text = (await main.innerText()).replace(/\s+/g, " ");
      expect(text.indexOf("Geöffnet")).toBeLessThan(text.indexOf("Ab 1. Dezember nur noch Pfandbecher"));
      expect(text).toContain("bis 15:00");
      expect(text).toContain("Morgen geschlossen · Montag ab 08:00");
      const titles = status.sections.map((section) => section.title);
      const places = titles.map((title) => text.indexOf(title));
      expect(places.every((place) => place >= 0)).toBe(true);
      expect(places).toEqual(places.toSorted((a, b) => a - b));
      // the week stands beside the sections, at its fixed width
      const side = await box(tab, '[data-k2-part="Pane"][data-side]');
      const first = await box(tab, '[data-k2-part="Pane"][aria-label="Heute"]');
      expect(side.left).toBeGreaterThan(first.left);
      expect(Math.round(side.width)).toBe(360);
      expect(await tab.locator('[data-k2-part="Pane"][data-side]').innerText()).toContain("Öffnungszeiten");
      // today's row stands out; the changes start tomorrow and name their reason
      expect(await tab.locator('[data-k2-part="Pane"][data-side] [aria-current="true"]').count()).toBeGreaterThan(0);
      const side_text = await tab.locator('[data-k2-part="Pane"][data-side]').innerText();
      expect(side_text).toContain("Geänderte Zeiten");
      expect(side_text).toContain("Personalversammlung");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the prices end at the main column's edge, on a wide screen and on the phone", async () => {
    for (const view of [desktop, phone]) {
      const { context, tab } = await open(view, guestHtml(guestStates.open()));
      try {
        const column = await box(tab, '[data-k2-part="Pane"][aria-label="Heute"]');
        const prices = await tab
          .getByText(/^\d+,\d{2} €$/)
          .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right));
        expect(prices.length).toBeGreaterThan(5);
        for (const right of prices) expect(column.right - right).toBeLessThanOrEqual(24);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("the venue's banner runs across both columns under the head; without one nothing stands there", async () => {
    for (const view of [desktop, phone]) {
      const { context, tab } = await open(view, guestHtml(guestStates.open()));
      try {
        const cover = await box(tab, '[data-k2-part="Cover"]');
        const outer = await box(tab, '[data-k2-part="Pane"]');
        expect(Math.round(cover.width)).toBe(Math.round(outer.width));
        expect(cover.bottom - cover.top).toBeGreaterThanOrEqual(120);
        expect(cover.bottom - cover.top).toBeLessThanOrEqual(180);
        const hero = await box(tab, '[data-k2-part="Pane"][aria-label="Heute"]');
        expect(hero.top).toBeGreaterThanOrEqual(cover.bottom - 1);
      } finally {
        await context.close();
      }
    }
    const plain = await open(desktop, guestHtml(guestStates.nobrand()));
    try {
      expect(await plain.tab.locator('[data-k2-part="Cover"]').count()).toBe(0);
    } finally {
      await plain.context.close();
    }
  }, 60_000);

  test("phone numbers read as the server wrote them, and a profile keeps its name beside its site", async () => {
    const { context, tab } = await open(desktop, guestHtml(guestStates.open()));
    try {
      const links = (await tab.getByRole("region", { name: "Kontakt und Wege" }).innerText()).replace(/\s+/g, " ");
      expect(links).toContain("instagram.example/campuscafenord");
      expect(links).toContain("cafe-nord@example.org");
      expect(links).toContain("+49 30 12345678");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone the week follows the sections, under the hero and the content", async () => {
    const { context, tab } = await open(phone, guestHtml(guestStates.open()));
    try {
      const side = await box(tab, '[data-k2-part="Pane"][data-side]');
      const first = await box(tab, '[data-k2-part="Pane"][aria-label="Heute"]');
      expect(side.top).toBeGreaterThanOrEqual(first.bottom - 1);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a closure today says so in the hero and in today's row, in warn", async () => {
    const { context, tab } = await open(desktop, guestHtml(guestStates.exception()));
    try {
      const main = (await tab.locator('[data-k2-part="Pane"]').first().innerText()).replace(/\s+/g, " ");
      expect(main).toContain("Heute geschlossen");
      expect(main).toContain("Statt 10:00–15:00 · Inventur");
      expect(main).toContain("Öffnet Montag, 30. Nov. um 08:00");
      expect(await tab.locator('[data-k2-part="Pane"][data-side] [data-k2-part="Text"][data-tone="warn"]').innerText()).toBe("Geschlossen");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the worst case keeps its long name, its special opening and eight sections inside the phone's width", async () => {
    const { context, tab } = await open(phone, guestHtml(guestStates.worst()));
    try {
      const text = (await tab.locator("main").innerText()).replace(/\s+/g, " ");
      expect(text).toContain("Sonderöffnung 18:00–23:00 · Lange Nacht der Wissenschaften");
      expect(text).toContain("Geöffnet");
      expect(text).toContain("bis 23:00");
      expect(text).toContain("Morgen 10:00–13:00");
      expect(await tab.getByRole("heading", { level: 1 }).innerText()).toContain("Erdgeschoss");
      expect(await tab.locator('[data-k2-part="Section"], [data-k2-part="Notice"]').count()).toBeGreaterThanOrEqual(10);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("an unknown or switched-off venue shows one page that reveals nothing, with the way to Venues", async () => {
    for (const view of [phone, desktop]) {
      const { context, tab, errors } = await open(view, guestHtml(null));
      try {
        await expectClean(tab, view.width);
        expect(await tab.getByRole("link", { name: "Standorte öffnen" }).getAttribute("href")).toBe("/app/venue");
        await shoot(tab, `guest-unavailable-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});

describe("Venue feedback page on v2", () => {
  const cafe = () => guestStates.open();
  const islandProps = () => ({ venueId: "Cafe01", venueName: "Campus-Café Nord", backUrl: "/app/venue/public/Cafe01" });
  const send = (tab: Page, name: "Feedback senden" | "Erneut senden" = "Feedback senden") => tab.getByRole("button", { name }).click();
  const comment = "Der Dal war super, nur die Schlange an der Kasse war mittags ziemlich lang.";

  for (const view of [phone, tablet, desktop, wide])
    test(`the empty form at ${view.name} px asks for stars first and keeps the layout rules`, async () => {
      const { context, tab, errors } = await open(view, feedbackHtml(cafe()), { island: islandProps() });
      try {
        await expectClean(tab, view.width);
        expect(await tab.getByText("Wie war dein Besuch?").isVisible()).toBe(true);
        expect(await tab.getByText("Wähle 1 bis 5 Sterne.").isVisible()).toBe(true);
        expect(await tab.getByRole("button", { name: "Feedback senden" }).isDisabled()).toBe(true);
        // nothing is chosen before the guest chooses
        expect(await tab.getByRole("radio", { checked: true }).count()).toBe(0);
        expect(await tab.getByRole("textbox", { name: "Kommentar" }).getAttribute("maxlength")).toBe("2000");
        expect(await tab.getByRole("link", { name: "Campus-Café Nord ansehen" }).getAttribute("href")).toBe("/app/venue/public/Cafe01");
        await shoot(tab, `feedback-empty-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("a failed send keeps the stars and the comment and offers “Erneut senden”; the next send arrives and says what arrived", async () => {
    for (const view of [phone, desktop]) {
      const { context, tab, errors, sends, release } = await open(view, feedbackHtml(cafe()), {
        island: islandProps(),
        answers: ["abort", "hold"],
      });
      try {
        await tab.getByRole("radio", { name: "4 von 5 Sternen" }).click();
        expect(await tab.getByText("4 von 5 · Gut").isVisible()).toBe(true);
        await tab.getByRole("textbox", { name: "Kommentar" }).fill(comment);
        await send(tab);
        await tab.getByText("Nicht gesendet").waitFor();
        expect(await tab.getByText("Die Verbindung ist abgebrochen. Deine Sterne und dein Kommentar sind noch da.").isVisible()).toBe(true);
        expect(await tab.getByRole("radio", { name: "4 von 5 Sternen" }).isChecked()).toBe(true);
        expect(await tab.getByRole("textbox", { name: "Kommentar" }).inputValue()).toBe(comment);
        await expectClean(tab, view.width);
        await shoot(tab, `feedback-failed-${view.name}`);

        // while it sends, the comment is locked and a second press does nothing
        await send(tab, "Erneut senden");
        await tab.waitForFunction(() => document.querySelector("textarea")?.disabled === true);
        await tab.getByRole("button", { name: "Erneut senden" }).click({ force: true });
        expect(sends.length).toBe(2);
        release(201);
        await tab.getByText("Danke für dein Feedback!").waitFor();
        const thanks = (await tab.locator("main").innerText()).replace(/\s+/g, " ");
        expect(thanks).toContain("Es ist anonym angekommen.");
        expect(thanks).toContain("4 von 5 · Gut");
        // the stars that were sent, as one picture with their words
        expect(await tab.getByRole("img", { name: "4 von 5 Sternen" }).count()).toBe(1);
        expect(thanks).toContain(comment);
        expect(await tab.getByRole("link", { name: "Campus-Café Nord ansehen" }).getAttribute("href")).toBe("/app/venue/public/Cafe01");
        expect(sends).toEqual([
          { rating: 4, comment },
          { rating: 4, comment },
        ]);
        await expectClean(tab, view.width);
        await shoot(tab, `feedback-thanks-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 90_000);

  test("a chosen rating fills its stars and says its words under them", async () => {
    for (const view of [phone, desktop]) {
      const { context, tab, errors } = await open(view, feedbackHtml(cafe()), { island: islandProps() });
      try {
        await tab.getByRole("radio", { name: "4 von 5 Sternen" }).click();
        await tab.getByText("4 von 5 · Gut").waitFor();
        expect(await tab.getByRole("button", { name: "Feedback senden" }).isEnabled()).toBe(true);
        await expectClean(tab, view.width);
        await shoot(tab, `feedback-chosen-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("too many ratings from one network say so in the same place, and the form stays", async () => {
    const { context, tab, sends } = await open(desktop, feedbackHtml(cafe()), { island: islandProps(), answers: [{ status: 429 }] });
    try {
      await tab.getByRole("radio", { name: "5 von 5 Sternen" }).click();
      await send(tab);
      await tab.getByText("Zu viele Bewertungen aus diesem Netz in kurzer Zeit. Versuch es in einer Minute noch mal.").waitFor();
      expect(await tab.getByRole("button", { name: "Erneut senden" }).isEnabled()).toBe(true);
      // a rating without a comment sends the chosen stars and no comment
      expect(sends).toEqual([{ rating: 5, comment: null }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("feedback that closed between loading and sending shows the closed page in place", async () => {
    const { context, tab } = await open(desktop, feedbackHtml(cafe()), { island: islandProps(), answers: [{ status: 400 }] });
    try {
      await tab.getByRole("radio", { name: "3 von 5 Sternen" }).click();
      await send(tab);
      await tab.getByText("Feedback ist gerade geschlossen: Campus-Café Nord nimmt im Moment keine Bewertungen an.").waitFor();
      expect(await tab.getByRole("link", { name: "Campus-Café Nord ansehen" }).getAttribute("href")).toBe("/app/venue/public/Cafe01");
    } finally {
      await context.close();
    }
  }, 60_000);

  for (const view of [phone, tablet, desktop, wide])
    test(`a venue without feedback says so at ${view.name} px, with the way back to its page`, async () => {
      const closed = { ...cafe(), venue: { ...cafe().venue, feedbackEnabled: false } };
      const { context, tab, errors } = await open(view, feedbackHtml(closed));
      try {
        await expectClean(tab, view.width);
        expect(await tab.getByText("Feedback ist gerade geschlossen").isVisible()).toBe(true);
        expect(await tab.getByRole("link", { name: "Campus-Café Nord ansehen" }).getAttribute("href")).toBe("/app/venue/public/Cafe01");
        expect(await tab.locator("main solid-island").count()).toBe(0);
        await shoot(tab, `feedback-closed-${view.name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("a slim banner above the form says where the guest is", async () => {
    const { context, tab } = await open(desktop, feedbackHtml(cafe()), { island: islandProps() });
    try {
      const cover = await box(tab, '[data-k2-part="Cover"]');
      expect(cover.bottom - cover.top).toBeGreaterThanOrEqual(72);
      expect(cover.bottom - cover.top).toBeLessThanOrEqual(88);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the worst case names the way back in general words and fits the phone", async () => {
    const worst = guestStates.worst();
    const { context, tab, errors } = await open(phone, feedbackHtml(worst), {
      island: { venueId: worst.venue.id, venueName: worst.venue.name, backUrl: `/app/venue/public/${worst.venue.id}` },
    });
    try {
      await expectClean(tab, phone.width);
      expect(await tab.getByRole("link", { name: "Zur Seite des Orts" }).isVisible()).toBe(true);
      await shoot(tab, "feedback-worst-390");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
