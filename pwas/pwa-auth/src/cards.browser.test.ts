import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../packages/ui/test/browser";
import { solid } from "../scripts/build";
import { iconStyles } from "../scripts/icons";
import type { CardOptions, CardScenario } from "./cards-fixture.browser-harness";

// The Cloud cards on the home screen: one status line per card, the whole card as the trigger only while a
// request waits, the info and reload buttons as their own targets, and a pending glow that moves nothing. Only a
// real engine resolves that geometry from the shipped styles. CLOUD_PWA_AUTH_SHOTS=<dir> also saves each state.
const shots = process.env.CLOUD_PWA_AUTH_SHOTS;

const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "cards-fixture.browser-harness.tsx"), resolve(import.meta.dir, "styles.css")],
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [solid],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!built.success) throw new AggregateError(built.logs, "Could not bundle the card fixture.");
const script = await built.outputs.find((output) => output.path.endsWith(".js"))!.text();
const css = (await built.outputs.find((output) => output.path.endsWith(".css"))!.text()) + (await iconStyles(script));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`;
const logo = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="9" fill="${color}"/><circle cx="14" cy="20" r="6" fill="#fff"/><circle cx="21" cy="16" r="7" fill="#fff"/><rect x="8" y="20" width="20" height="6" rx="3" fill="#fff"/></svg>`;

const views = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 1024, height: 720 } },
} satisfies Record<string, BrowserContextOptions>;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function context(view: BrowserContextOptions, options: { theme?: "light" | "dark"; reducedMotion?: "reduce" } = {}) {
  const value = await browser.newContext({
    ...view,
    timezoneId: "Europe/Berlin",
    colorScheme: options.theme ?? "light",
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await value.route("https://login.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await value.route("https://cloud.example.org/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: logo("#4f46e5") }));
  await value.route("https://portal.example.com/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: logo("#0f766e") }));
  return value;
}

/** Opens the home screen; a sign-in or device change opens its sheet by itself, and Escape closes it as a person would. */
async function show(page: Page, options: CardOptions, keepSheet = false) {
  const errors = pageErrors(page);
  await page.goto("https://login.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((value) => window.showCards(value), options);
  await page.waitForTimeout(60);
  if (!keepSheet) {
    // Each dismissed sheet lets the next waiting request open its own.
    for (let open = 0; open < 6 && (await page.locator("dialog[open]").count()); open++) {
      await settled(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    }
    expect(await page.locator("dialog[open]").count()).toBe(0);
  }
  await settled(page);
  return errors;
}

const cards = (page: Page) =>
  page.locator(".auth-cloud").evaluateAll((elements) =>
    elements.map((element) => {
      const { top, height, width } = element.getBoundingClientRect();
      const status = element.querySelector(".auth-status")!.getBoundingClientRect();
      return { top, height, width, statusTop: status.top, statusHeight: status.height };
    }),
  );

const all: CardScenario[] = ["idle", "one", "many", "mixed", "error", "actionFailed", "offline", "loading"];

async function openFailedAction(page: Page) {
  // The Action loads when the card is tapped; its failure becomes the card's error line.
  await page.locator(".auth-cloud__open").first().click();
  await page.locator('.auth-status [role="alert"]').waitFor();
}

describe("Cloud cards", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["de", "en"] as const) {
      test(`every status is one line at 390 px, ${theme} ${locale}`, async () => {
        const value = await context(views.phone, { theme });
        try {
          for (const scenario of all) {
            const page = await value.newPage();
            const errors = await show(page, { scenario, locale });
            if (scenario === "actionFailed") await openFailedAction(page);
            const lines = await page.locator(".auth-status").evaluateAll((elements) =>
              elements.map((element) => {
                const text = element.querySelector<HTMLElement>(".auth-status__text") ?? element;
                // The visible text's line boxes; the screen reader's long explanation is left out.
                const rows = new Set<number>();
                const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  if (node.parentElement?.closest(".k2b-sr-only")) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  for (const rect of range.getClientRects()) if (rect.width > 0) rows.add(Math.round(rect.top));
                }
                return {
                  text: element.textContent,
                  height: element.getBoundingClientRect().height,
                  rows: rows.size,
                  clipped: text.scrollWidth > text.clientWidth,
                  // What waits is never cut; only the time after it may end in an ellipsis.
                  summaryCut: (() => {
                    const summary = text.querySelector("b");
                    return !!summary && summary.getBoundingClientRect().right > text.getBoundingClientRect().right;
                  })(),
                  ellipsis: getComputedStyle(text).textOverflow,
                };
              }),
            );
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) {
              // One text line, in the place of "All set"; a longer text is cut, never wrapped.
              expect({ text: line.text, height: line.height, rows: line.rows }).toEqual({ text: line.text, height: 24, rows: 1 });
              expect({ text: line.text, summaryCut: line.summaryCut }).toEqual({ text: line.text, summaryCut: false });
              if (line.clipped) expect(line.ellipsis).toBe("ellipsis");
              // The error and quiet rows fit whole, also in the test machine's wide fallback font.
              if (!line.text?.includes("·"))
                expect({ text: line.text, clipped: line.clipped }).toEqual({ text: line.text, clipped: false });
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
            expect(errors).toEqual([]);
            await page.close();
          }
        } finally {
          await value.close();
        }
      }, 30_000);
    }
  }

  test("only a card with a waiting request is a trigger, and it opens that request", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "idle", locale: "de" });
      expect(await page.locator(".auth-cloud__open").count()).toBe(0);
      await page.locator(".auth-cloud .auth-status").first().click();
      await page.waitForTimeout(100);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      await settled(page);
      expect(
        await page
          .locator(".auth-cloud")
          .first()
          .evaluate((el) => getComputedStyle(el).cursor),
      ).toBe("auto");

      await show(page, { scenario: "one", locale: "de" });
      const trigger = page.locator(".auth-cloud__open");
      expect(await trigger.count()).toBe(1);
      expect(await trigger.getAttribute("aria-label")).toBe(
        "Example Cloud, cloud.example.org. Anmeldeanfrage, Firefox auf macOS, vor 1 Min.",
      );
      // The hit area is the whole card, with its own focus ring.
      const [cardBox, hitBox] = await Promise.all([page.locator(".auth-cloud").first().boundingBox(), trigger.boundingBox()]);
      expect(hitBox).toEqual(cardBox);
      expect(
        await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: cardBox!.x + 30, y: cardBox!.y + 30 }),
      ).toBe("auth-cloud__open");
      await page.locator(".auth-cloud-info").first().focus();
      await page.keyboard.press("Tab");
      await settled(page);
      expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await trigger.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
      // A tap anywhere on the card, here on its status line, opens the sign-in sheet.
      const line = (await page.locator(".auth-cloud .auth-status").first().boundingBox())!;
      await page.mouse.click(line.x + 40, line.y + line.height / 2);
      await page.locator("dialog[open] .auth-comparison").waitFor();
      expect(await page.locator("dialog[open] h2").textContent()).toBe("Anmeldung bei Example Cloud");
      expect(await page.locator("dialog[open] .k2b-panel-dialog__header p").textContent()).toBe("cloud.example.org");
      // The other card, with nothing waiting, stays plain.
      expect(await page.locator(".auth-cloud").nth(1).locator(".auth-cloud__open").count()).toBe(0);

      // When the request is gone, the card stops being a trigger.
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "detached" });
      await page.evaluate(() => window.setInbox("idle"));
      await page.waitForTimeout(30);
      expect(await page.locator(".auth-cloud__open").count()).toBe(0);
      expect(await page.locator(".auth-cloud .auth-status").first().textContent()).toBe("Alles erledigt.");
    } finally {
      await value.close();
    }
  }, 20_000);

  test("several requests name the oldest; an unusual sign-in turns the card amber", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "many", locale: "de" });
      const statuses = await page.locator(".auth-status").allTextContents();
      expect(statuses).toEqual(["2 Anmeldeanfragen·älteste vor 1 Min.", "Ungewöhnliche Anmeldung·vor 2 Min."]);
      expect(await page.locator(".auth-cloud").evaluateAll((els) => els.map((el) => el.getAttribute("data-pending")))).toEqual([
        "",
        "warn",
      ]);
      // A tap opens the oldest request of that Cloud.
      await page.locator(".auth-cloud__open").first().click();
      await page.locator("dialog[open] .auth-comparison").waitFor();
      expect(await page.locator("dialog[open]").textContent()).toContain("Firefox auf macOS");
    } finally {
      await value.close();
    }
  }, 20_000);

  test("the info button opens Details, never the request; Close, Escape and a tap beside it close it", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "one", locale: "de" });
      const info = page.locator(".auth-cloud-info").first();
      const box = (await info.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      // Its whole target lies above the card's trigger.
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".auth-cloud-info") !== null, {
        x: box.x + 2,
        y: box.y + box.height - 2,
      });
      expect(hit).toBe(true);
      for (const close of ["button", "escape", "outside"] as const) {
        await info.click();
        const dialog = page.locator("dialog[open]");
        await dialog.waitFor();
        await settled(page);
        expect(await dialog.locator(".auth-comparison").count()).toBe(0);
        expect(await dialog.locator("h2").textContent()).toBe("Example Cloud");
        if (close === "button") await dialog.locator(".auth-details-close").click();
        if (close === "escape") await page.keyboard.press("Escape");
        if (close === "outside") await page.mouse.click(195, 40);
        await dialog.waitFor({ state: "detached" });
      }
    } finally {
      await value.close();
    }
  }, 20_000);

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`a reload checks again with a turning icon and moves nothing, ${reducedMotion}`, async () => {
      const value = await context(views.phone, { reducedMotion: reducedMotion === "reduce" ? "reduce" : undefined });
      try {
        const page = await value.newPage();
        await show(page, { scenario: "error", locale: "de" });
        expect(await page.locator(".auth-status").allTextContents()).toEqual([
          "Nicht erreichbar. Diese Cloud ist gerade nicht erreichbar. Wir prüfen erneut, solange die App geöffnet ist.",
          "Gerät nicht verfügbar. Dieses Gerät oder dieser Account ist nicht verfügbar. Prüfe Account-Zugang und Gerätestatus in der Cloud.",
        ]);
        // A refused device is not polled again, so only the unreachable Cloud offers a reload.
        const reload = page.locator(".auth-status__reload");
        expect(await reload.count()).toBe(1);
        const box = (await reload.boundingBox())!;
        expect([box.width, box.height]).toEqual([44, 44]);
        const before = await cards(page);
        await page.evaluate(() => window.recheckAnswer(1200, "idle"));
        await reload.click();
        // The turning icon never ends while it checks; settled waits only for finite animations.
        await settled(page);
        expect(await reload.getAttribute("data-busy")).toBe("");
        expect(await page.locator('.auth-cloud [role="status"].k2b-sr-only').first().textContent()).toBe("Wird geprüft…");
        const turning = await reload.locator("i").evaluate((icon) => getComputedStyle(icon).animationName);
        expect(turning).toBe(reducedMotion === "reduce" ? "auth-pulse" : "auth-spin-back");
        expect(await cards(page)).toEqual(before);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("auth-status__reload"))).toBe(true);
        // A second tap while it checks sends nothing more.
        await reload.click();
        expect(await page.evaluate(() => window.rechecks)).toBe(1);
        await page.locator(".auth-status", { hasText: "Alles erledigt." }).first().waitFor();
        expect(await page.locator(".auth-status__reload").count()).toBe(0);
      } finally {
        await value.close();
      }
    }, 20_000);
  }

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`the pending glow and dot appear without moving anything, ${reducedMotion}`, async () => {
      const value = await context(views.phone, { reducedMotion: reducedMotion === "reduce" ? "reduce" : undefined });
      try {
        const page = await value.newPage();
        await show(page, { scenario: "idle", locale: "de" });
        const before = await cards(page);
        expect(
          await page
            .locator(".auth-cloud")
            .first()
            .evaluate((el) => getComputedStyle(el, "::before").content),
        ).toBe("none");
        await page.evaluate(() => window.setInbox("one"));
        await page.waitForTimeout(60);
        // The arriving sign-in opens its sheet; the cards behind it keep every place.
        expect(await cards(page)).toEqual(before);
        const glow = await page
          .locator(".auth-cloud")
          .first()
          .evaluate((el) => {
            const style = getComputedStyle(el, "::before");
            return { animation: style.animationName, duration: style.animationDuration, opacity: style.opacity, z: style.zIndex };
          });
        if (reducedMotion === "reduce") expect(glow).toMatchObject({ animation: "none", opacity: "0.6", z: "-1" });
        else expect(glow).toMatchObject({ animation: "auth-glow", duration: "2s", z: "-1" });
        const ping = await page.locator(".auth-status__dot").evaluate((el) => getComputedStyle(el, "::after").display);
        expect(ping).toBe(reducedMotion === "reduce" ? "none" : "block");
      } finally {
        await value.close();
      }
    }, 20_000);
  }

  test("a tap opens only the request the card showed when the tap began", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "mixed", locale: "de" });
      const card = (await page.locator(".auth-cloud").first().boundingBox())!;
      await page.mouse.move(card.x + 60, card.y + card.height / 2);
      await page.mouse.down();
      // Another Action takes the first one's place between the press and the release.
      await page.evaluate(() => window.setInbox("swapped"));
      await page.waitForTimeout(30);
      await page.mouse.up();
      await page.waitForTimeout(150);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      // The next tap opens what the card now shows.
      await page.mouse.click(card.x + 60, card.y + card.height / 2);
      await page.locator("dialog[open] .auth-action-ask").waitFor();
    } finally {
      await value.close();
    }
  }, 20_000);

  test("an Action that cannot load becomes one error line with a reload", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "actionFailed", locale: "de" });
      expect(await page.locator(".auth-status").first().textContent()).toBe("Freigabeanfrage·vor 4 Min.");
      await openFailedAction(page);
      expect(await page.locator(".auth-status").first().textContent()).toBe(
        "Freigabe nicht geladen. Die Freigabe konnte nicht geladen werden. Prüfe sie in Cloud.",
      );
      expect(await page.locator(".auth-cloud__open").count()).toBe(0);
      expect(await page.locator(".auth-status__reload").count()).toBe(1);
      // Details repeat the long explanation.
      await page.locator(".auth-cloud-info").first().click();
      await page.locator("dialog[open] .auth-details-problem").waitFor();
      expect(await page.locator("dialog[open] .auth-details-problem").textContent()).toBe(
        "Die Freigabe konnte nicht geladen werden. Prüfe sie in Cloud.",
      );
    } finally {
      await value.close();
    }
  }, 20_000);

  test("the Action sheet leads with the request and keeps the address in its head", async () => {
    const value = await context(views.phone);
    try {
      const page = await value.newPage();
      await show(page, { scenario: "mixed", locale: "de" });
      expect(await page.locator(".auth-status").allTextContents()).toEqual([
        "Freigabeanfrage·vor 4 Min.",
        "2 weitere warten in Cloud",
        "2 Anfragen·älteste vor 5 Min.",
      ]);
      await page.locator(".auth-cloud__open").first().click();
      const dialog = page.locator("dialog[open]");
      await dialog.locator(".auth-action-ask").waitFor();
      expect(await dialog.locator("h2").textContent()).toBe("Freigabe bei Example Cloud");
      expect(await dialog.locator(".k2b-panel-dialog__header p").textContent()).toBe("cloud.example.org");
      expect(await dialog.locator(".auth-action-ask").textContent()).toBe("Datei „Q3-Bericht.pdf“ löschen");
      expect(await dialog.locator("dt").allTextContents()).toEqual(["App", "Angefragt von", "Ordner", "Geändert"]);
      expect(await dialog.locator("dd").nth(1).textContent()).toBe("Assistant · Chat „Aufräumen Projektordner“");
      expect(await dialog.locator(".auth-action-meta").textContent()).toBe("Fragt jedes Mal·Läuft in 9 Minuten ab");
      // No quote edge and no danger colour: the contract carries no danger flag.
      expect(await dialog.locator(".auth-action-ask").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
      expect(await dialog.locator(".k2b-button[data-variant='danger']").count()).toBe(0);
    } finally {
      await value.close();
    }
  }, 20_000);

  if (shots) {
    test("saves every state at 390 px and wide", async () => {
      mkdirSync(shots, { recursive: true });
      for (const [name, view] of Object.entries(views)) {
        const value = await context(view);
        try {
          const save = async (page: Page, file: string) => {
            await settled(page);
            await page.screenshot({ path: join(shots, `${name}-${file}.png`), animations: "disabled" });
          };
          for (const scenario of [...all, "empty"] as CardScenario[]) {
            const page = await value.newPage();
            await show(page, { scenario, locale: "de" });
            if (scenario === "actionFailed") await openFailedAction(page);
            await save(page, scenario);
            if (scenario === "one" || scenario === "many") {
              await page.locator(".auth-cloud__open").last().click();
              await page.locator("dialog[open] .auth-comparison").waitFor();
              await save(page, `${scenario}-sheet`);
              if (scenario === "one") {
                await page.evaluate(() => window.expire());
                await page.waitForTimeout(60);
                await save(page, "expired");
              }
            }
            if (scenario === "mixed") {
              await page.locator(".auth-cloud__open").first().click();
              await page.locator("dialog[open] .auth-action-ask").waitFor();
              await save(page, "action-sheet");
            }
            if (scenario === "error") {
              await page.evaluate(() => window.recheckAnswer(60_000, "error"));
              await page.locator(".auth-status__reload").click();
              await save(page, "error-checking");
              await page.locator(".auth-cloud-info").first().click();
              await page.locator("dialog[open] .auth-details-problem").waitFor();
              await save(page, "error-details");
            }
            await page.close();
          }
        } finally {
          await value.close();
        }
      }
    }, 120_000);
  }
});
