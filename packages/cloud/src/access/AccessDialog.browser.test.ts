import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// The dialog's layout and its marks depend on the real layout engine: rows must not move when a change is staged.
let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };

const buildHarness = async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AccessDialog.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-access-dialog-test",
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
  if (!build.success) throw new AggregateError(build.logs, "AccessDialog harness build failed");
  return build.outputs[0]!.text();
};
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  harness = await buildHarness();
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  icons = { css: source.replace(font, "https://harness.test/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Set ACCESS_DIALOG_SHOTS to a directory to keep screenshots of each state for a visual review. */
const shots = process.env.ACCESS_DIALOG_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

const open = async (width: number, locale: string, scene?: "normal" | "lesen") => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route("https://harness.test/tabler.woff2*", (route) => route.fulfill({ path: icons.font, contentType: "font/woff2" }));
  await page.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${icons.css}</style><style>${css}</style></head>` +
      `<body class="k2b-ui"><script>window.accessDialogScene = ${JSON.stringify(scene ?? null)};</script><script>${harness}</script></body></html>`,
  );
  await page.waitForSelector("dialog[open]");
  await settled(page);
  return page;
};

const rowTop = (page: Page, name: string) =>
  page.evaluate((text) => {
    const row = Array.from(document.querySelectorAll("dialog li")).find((item) => item.textContent?.includes(text));
    return row ? Math.round(row.getBoundingClientRect().top) : -1;
  }, name);

describe("AccessDialog in a browser", () => {
  for (const [width, locale] of [
    [1440, "de"],
    [390, "de"],
    [390, "en"],
  ] as const)
    test(`${locale} ${width}px: staging changes moves no row and nothing overflows`, async () => {
      const page = await open(width, locale);
      try {
        await shot(page, `${locale}-${width}-normal`);
        const before = await Promise.all(["Jonas Weber", "Logistik", "Lagerbot", "Lea Schmitt"].map((name) => rowTop(page, name)));
        const lea = page.locator("dialog li", { hasText: "Lea Schmitt" });
        await lea.locator("button[aria-haspopup]").first().click();
        await page
          .locator('[role="option"]', { hasText: locale === "de" ? "Bearbeiten" : "Edit" })
          .last()
          .click();
        await page.locator(`dialog button[aria-label="${locale === "de" ? "Lagerbot entfernen" : "Remove Lagerbot"}"]`).click();
        await settled(page);
        const after = await Promise.all(["Jonas Weber", "Logistik", "Lagerbot", "Lea Schmitt"].map((name) => rowTop(page, name)));
        expect(after).toEqual(before);
        await page.locator("dialog input[type=checkbox]").first().check();
        await settled(page);
        await shot(page, `${locale}-${width}-changes`);
        const overflow = await page.evaluate(() => {
          const dialog = document.querySelector("dialog")!;
          return (
            Array.from(dialog.querySelectorAll<HTMLElement>("*"))
              // Inputs scroll their own text, and a switch hides its checkbox; neither pushes the layout.
              .filter((element) => element.tagName !== "INPUT")
              .filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible")
              .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
          );
        });
        expect(overflow).toEqual([]);
        expect(await page.locator("dialog").textContent()).toContain(locale === "de" ? "3 Änderungen" : "3 changes");
      } finally {
        await page.close();
      }
    });

  // Mockup v31 `editor · A · suche-kennung`: an identifier in the search for people finds the service account.
  for (const width of [1280, 390])
    test(`de ${width}px: an identifier in the search shows the marked hit in the sheet and adds it under Dienstkonten`, async () => {
      const page = await open(width, "de");
      try {
        await page.locator("dialog input[role=combobox]").fill("code-7k2q9m4xwt");
        const option = page.locator('[role="option"]', { hasText: "Code von info@beispiel.de" });
        await option.waitFor();
        await settled(page);
        await shot(page, `de-${width}-suche-kennung`);
        expect(await option.locator("small").textContent()).toBe("Dienstkonto eines Postfachs · kommt in den Abschnitt Dienstkonten");
        const fit = await option.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const badge = element.querySelector(".k2b-choice-option__badge")!.getBoundingClientRect();
          const text = element.querySelector("span")!.getBoundingClientRect();
          return {
            inViewport: box.left >= 0 && box.right <= window.innerWidth,
            badgeInside: badge.right <= box.right && badge.left >= text.right,
            badgeOneLine: badge.height < 24,
            badge: element.querySelector(".k2b-choice-option__badge")!.textContent,
          };
        });
        expect(fit).toEqual({ inViewport: true, badgeInside: true, badgeOneLine: true, badge: "Dienstkonto" });
        await option.click();
        const section = page.locator("dialog section", { has: page.locator("h2, h3", { hasText: "Dienstkonten" }) });
        await section.locator("li", { hasText: "Code von info@beispiel.de" }).waitFor();
        await section.scrollIntoViewIfNeeded();
        await settled(page);
        await shot(page, `de-${width}-suche-kennung-added`);
        expect(await section.locator("li", { hasText: "Code von info@beispiel.de" }).textContent()).toContain("Neu");
        expect(await page.locator("dialog").textContent()).toContain("Code von info@beispiel.de bekommt");
      } finally {
        await page.close();
      }
    });

  // Mockup v31 `editor · A`: the section Dienstkonten in the states leer, normal, dienst-hinzu, dienst-neu and lesen.
  const section = (page: Page) => page.locator("dialog section", { has: page.locator("h3", { hasText: "Dienstkonten" }) });
  /** The button shares the title's line, and the text below follows the header without an empty gap. */
  const head = (page: Page) =>
    section(page).evaluate((element) => {
      const header = element.querySelector("header")!.getBoundingClientRect();
      const title = element.querySelector("h3")!.getBoundingClientRect();
      const button = element.querySelector("header button")?.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>(".k2b-panel-dialog__section-body")!;
      const first = body.firstElementChild!.getBoundingClientRect();
      const inner = body.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(body).paddingTop);
      return {
        besideTitle: button ? button.top < title.bottom && button.bottom > title.top && button.left > title.right : null,
        titleOneLine: title.height < 24,
        headerInside: header.right <= element.getBoundingClientRect().right + 0.5 && (!button || button.right <= header.right + 0.5),
        gap: Math.round(first.top - inner),
      };
    });
  for (const width of [1280, 390]) {
    test(`de ${width}px leer: the count is 0, the button beside the title, the empty text without a gap`, async () => {
      const empty = await open(width, "de");
      try {
        await section(empty).scrollIntoViewIfNeeded();
        await settled(empty);
        await shot(empty, `de-${width}-leer`);
        expect(await section(empty).locator("h3").textContent()).toBe("Dienstkonten 0");
        expect(await head(empty)).toEqual({ besideTitle: true, titleOneLine: true, headerInside: true, gap: 0 });
      } finally {
        await empty.close();
      }
    });

    test(`de ${width}px normal, dienst-hinzu, dienst-neu: rows as the server says, the field and its hit in view`, async () => {
      const page = await open(width, "de", "normal");
      try {
        await section(page).scrollIntoViewIfNeeded();
        await settled(page);
        await shot(page, `de-${width}-normal`);
        expect(await section(page).locator("h3").textContent()).toBe("Dienstkonten 2");
        expect(await head(page)).toMatchObject({ besideTitle: true, titleOneLine: true, headerInside: true });
        const mailbox = section(page).locator("li", { hasText: "Code von einkauf@beispiel.de" });
        expect(await mailbox.textContent()).toContain("Dienstkonto eines Postfachs · darf bearbeiten");
        // The line wraps rather than cutting off the level.
        expect(
          await mailbox
            .getByText("Dienstkonto eines Postfachs · darf bearbeiten")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        expect(await section(page).locator("li", { hasText: "Code von Werkstatt" }).textContent()).toContain(
          "Dienstkonto einer App · darf ansehen",
        );
        expect(await mailbox.getByRole("link", { name: "Code von einkauf@beispiel.de" }).getAttribute("href")).toBe(
          "/app/mail/Mb4kd2/code",
        );
        expect(await mailbox.locator("button[aria-haspopup]").first().getAttribute("aria-label")).toBe(
          "Stufe für Code von einkauf@beispiel.de",
        );

        // Move the section's top to the bottom of the sheet: opening the field must bring it into view by itself.
        await page.evaluate(() => {
          const body = document.querySelector("dialog .k2b-panel-dialog__body") ?? document.querySelector("dialog");
          const heading = Array.from(document.querySelectorAll("dialog h3")).find((item) => item.textContent?.startsWith("Dienstkonten"))!;
          const scroller =
            (function find(element: Element | null): Element | null {
              if (!element) return null;
              const style = getComputedStyle(element);
              return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight
                ? element
                : find(element.parentElement);
            })(heading) ?? body;
          scroller!.scrollTop += heading.getBoundingClientRect().top - window.innerHeight + 80;
        });
        await section(page).getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
        const field = section(page).getByLabel("Kennung des Dienstkontos", { exact: true });
        await field.fill("code-7k2q9m4xwt");
        const hit = section(page).locator("li button", { hasText: "Code von info@beispiel.de" });
        await hit.waitFor();
        await settled(page);
        await shot(page, `de-${width}-dienst-hinzu`);
        expect(await section(page).getByRole("button", { name: "Dienstkonto hinzufügen" }).count()).toBe(0);
        const fit = await hit.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const field = element.closest("li")!.querySelector("input")!.getBoundingClientRect();
          return {
            // Above the footer, not only inside the window: the sheet scrolls the field and its hit into view.
            fieldInView:
              field.top >= 0 &&
              box.bottom <= document.querySelector("dialog footer, dialog .k2b-panel-dialog__footer")!.getBoundingClientRect().top,
            hitInside: box.left >= 0 && box.right <= window.innerWidth,
            mark: element.querySelector(".k2b-status-badge")?.textContent?.trim(),
            line: element.textContent?.includes("Dienstkonto eines Postfachs"),
          };
        });
        expect(fit).toEqual({ fieldInView: true, hitInside: true, mark: "Dienstkonto", line: true });

        await hit.click();
        const added = section(page).locator("li", { hasText: "Code von info@beispiel.de" });
        await added.waitFor();
        await settled(page);
        expect(await section(page).locator("h3").textContent()).toBe("Dienstkonten 3");
        expect(await added.textContent()).toContain("Dienstkonto eines Postfachs · darf bearbeiten");
        const dialogText = await page.locator("dialog").textContent();
        expect(dialogText).toContain("Code von info@beispiel.de bekommt Bearbeiten");
        expect(dialogText).toContain("Der Code darf alles, was Bearbeiten erlaubt, nicht nur das, was er heute aufruft.");
        await shot(page, `de-${width}-dienst-neu`);
      } finally {
        await page.close();
      }
    });

    test(`de ${width}px lesen: the level under the name, no controls`, async () => {
      const reader = await open(width, "de", "lesen");
      try {
        await section(reader).scrollIntoViewIfNeeded();
        await settled(reader);
        await shot(reader, `de-${width}-lesen`);
        const row = section(reader).locator("li", { hasText: "Code eines Postfachs" });
        expect(await row.textContent()).toContain("Darf bearbeiten");
        expect(await row.locator("button, [role=combobox]").count()).toBe(0);
        expect(await section(reader).getByRole("button", { name: "Dienstkonto hinzufügen" }).count()).toBe(0);
      } finally {
        await reader.close();
      }
    });
  }
});
