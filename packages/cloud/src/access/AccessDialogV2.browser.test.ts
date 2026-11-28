import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";

// The access dialog on v2: a person adds someone, changes a level, removes and undoes, switches General, saves in
// order after confirming a removal, and leaves with staged changes only after confirming. Invented people only.
const ui = resolve(import.meta.dir, "../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_SHARING_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AccessDialogV2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-sharing-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Sharing v2 harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", await build.outputs[0]!.text(), v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 1024, height: 768, touch: false, name: "1024" },
  { width: 390, height: 844, touch: true, name: "390" },
];

const open = async (view: View, query = "") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/share")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="${url.searchParams.has("de") ? "de" : "en"}" class="light"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
          `<style>${css}</style></head><body class="k2b-ui"><script src="/harness.js"></script></body></html>`,
      });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}/share${query}`);
  await tab.evaluate(() => document.fonts.ready);
  const dialog = tab.getByRole("dialog");
  await dialog.waitFor();
  await settled(tab);
  return { context, tab, errors, dialog };
};
const calls = (tab: Page) => tab.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const result = (tab: Page) => tab.evaluate(() => (window as unknown as { result?: boolean }).result);
const row = (dialog: ReturnType<Page["getByRole"]>, name: string) => dialog.locator('[data-k2-part="Row"]').filter({ hasText: name });
const clean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, '[data-k2-part="Dialog"]');
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
};

describe("the access dialog on v2", () => {
  for (const view of views)
    test(`${view.name} px: who has access, General and nothing staged, clean`, async () => {
      const { context, tab, errors, dialog } = await open(view);
      try {
        await dialog.getByRole("region", { name: /People/ }).waitFor();
        for (const name of ["Mia Hoffmann", "Jonas Weber", "Logistik", "Lagerbot", "Lea Schmitt"])
          await row(dialog, name).first().waitFor();
        expect(await dialog.getByRole("button", { name: /^Save/ }).isDisabled()).toBe(true);
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `01-sharing-v2-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("adding someone, changing a level and removing one save in order after the removal is confirmed", async () => {
    const { context, tab, dialog } = await open(views[0]!);
    try {
      await dialog.getByRole("searchbox").fill("noah");
      // each result's Add is named by its words and then the name (review of #4222), so ten results are told apart
      await row(dialog, "Noah Becker").getByRole("button", { name: "Add: Noah Becker", exact: true }).click();
      await row(dialog, "Noah Becker").getByText("New").waitFor();
      await row(dialog, "Lea Schmitt").getByRole("button", { name: /View/ }).click();
      await tab.getByRole("menuitemradio", { name: /Edit/ }).click();
      await row(dialog, "Jonas Weber").getByRole("button", { name: /Edit/ }).click();
      await tab.getByRole("menuitem", { name: "Remove" }).click();
      await row(dialog, "Jonas Weber").getByRole("button", { name: "Undo" }).waitFor();
      await dialog.getByRole("region", { name: /What changes/ }).waitFor();
      await dialog.getByRole("button", { name: /^Save/ }).click();
      const question = tab.getByRole("alertdialog");
      await question.waitFor();
      await question.getByRole("button", { name: /Remove/ }).click();
      await tab.waitForFunction(() => (window as unknown as { result?: boolean }).result === true);
      const made = (await calls(tab)) as Record<string, unknown>[];
      expect(made.some((call) => "grant" in call)).toBe(true);
      expect(made.some((call) => "update" in call && call.permission === "write")).toBe(true);
      expect(made.some((call) => "revoke" in call)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("Undo brings a removed row back, and the last manager cannot be removed", async () => {
    const { context, tab, dialog } = await open(views[0]!);
    try {
      await row(dialog, "Lea Schmitt").getByRole("button", { name: /View/ }).click();
      await tab.getByRole("menuitem", { name: "Remove" }).click();
      await row(dialog, "Lea Schmitt").getByRole("button", { name: "Undo" }).click();
      await row(dialog, "Lea Schmitt").getByRole("button", { name: /View/ }).waitFor();
      await row(dialog, "Mia Hoffmann")
        .getByRole("button", { name: /Manage/ })
        .click();
      expect(await tab.getByRole("menuitem", { name: "Remove" }).isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("leaving with staged changes asks first; keeping them leaves the dialog open", async () => {
    const { context, tab, dialog } = await open(views[2]!);
    try {
      await dialog.getByRole("switch", { name: /signed-in/i }).check({ force: true });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      const question = tab.getByRole("alertdialog");
      await question.waitFor();
      await question.getByRole("button", { name: /Keep/ }).click();
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Discard/ })
        .click();
      await tab.waitForFunction(() => (window as unknown as { result?: boolean }).result === false);
      expect(await calls(tab)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("public access warns and offers its link to copy", async () => {
    const { context, dialog } = await open(views[0]!, "?public");
    try {
      await dialog.getByRole("switch", { name: /Public/ }).check({ force: true });
      await dialog.getByText("https://cloud.example.org/s/lager-nord").waitFor();
      await dialog.locator('[data-k2-part="Notice"]').first().waitFor();
    } finally {
      await context.close();
    }
  });

  test("read-only shows who has access and who manages it, without controls", async () => {
    const { context, dialog } = await open(views[0]!, "?readonly");
    try {
      // one quiet line names who manages it; no notice
      await dialog.getByText(/manage it can change access: Mia Hoffmann/).waitFor();
      expect(await dialog.locator('[data-k2-part="Notice"]').count()).toBe(0);
      expect(await dialog.getByRole("searchbox").count()).toBe(0);
      expect(await dialog.getByRole("switch").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("API keys: a name is required, the token shows once to copy, and revoking asks first", async () => {
    const { context, tab, dialog } = await open(views[0]!, "?keys");
    try {
      const keys = dialog.getByRole("region", { name: "API keys" });
      await keys.getByText("Lagerimport").waitFor();
      await keys.getByRole("button", { name: "Add" }).click();
      const create = tab.getByRole("dialog", { name: "Create API key" });
      await create.getByRole("button", { name: "Create key" }).click();
      await create.getByText(/name/i).first().waitFor();
      await create.getByRole("textbox").first().fill("Nachtlauf");
      await create.getByRole("button", { name: "Create key" }).click();
      const shown = tab.getByRole("dialog", { name: /API key created/i });
      await shown.getByText("k2b_Zx9-invented-token-for-the-test").waitFor();
      await shown.getByRole("button", { name: "Done" }).click();
      await keys.getByText("Nachtlauf").waitFor();
      await keys.getByRole("button", { name: "Actions for Lagerimport" }).click();
      await tab.getByRole("menuitem", { name: "Revoke" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await tab.waitForFunction(() => (window as unknown as { calls: { revokeKey?: string }[] }).calls.some((call) => call.revokeKey));
      expect(await keys.getByText("Lagerimport").count()).toBe(0);
      expect(((await calls(tab)) as Record<string, unknown>[]).find((call) => "createKey" in call)).toEqual({
        createKey: "Nachtlauf",
        permission: "read",
        expires: true,
      });
      await clean(tab);
    } finally {
      await context.close();
    }
  });

  test("API keys: an expiry on a picked day must lie ahead and goes with the key", async () => {
    const { context, tab, dialog } = await open(views[0]!, "?keys");
    try {
      await dialog.getByRole("region", { name: "API keys" }).getByRole("button", { name: "Add" }).click();
      const create = tab.getByRole("dialog", { name: "Create API key" });
      await create.getByRole("textbox").first().fill("Monatsabschluss");
      await create.getByRole("radio", { name: "On a date" }).check({ force: true });
      const day = create.getByRole("textbox", { name: "Expires on" });
      await day.fill("2020-01-01");
      await day.press("Enter");
      await create.getByRole("button", { name: "Create key" }).click();
      await create.getByText("Pick a day in the future.").waitFor();
      await day.fill("2099-12-31");
      await day.press("Enter");
      await create.getByRole("button", { name: "Create key" }).click();
      await tab.getByRole("dialog", { name: /API key created/i }).waitFor();
      expect(((await calls(tab)) as Record<string, unknown>[]).find((call) => "createKey" in call)).toEqual({
        createKey: "Monatsabschluss",
        permission: "read",
        expires: true,
      });
    } finally {
      await context.close();
    }
  });

  test("a key that cannot be revoked stays, and the toast says so with Try again", async () => {
    const { context, tab, dialog } = await open(views[0]!, "?keys&revokeFails");
    try {
      const keys = dialog.getByRole("region", { name: /API keys/ });
      await keys.getByRole("button", { name: "Actions for Lagerimport" }).click();
      await tab.getByRole("menuitem", { name: "Revoke" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await tab.getByText("Not revoked").waitFor();
      await tab.getByRole("button", { name: "Try again" }).waitFor();
      expect(await keys.getByText("Lagerimport").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  for (const view of [views[0]!, views[2]!])
    test(`${view.name} px: the worst case stays readable and nothing overflows`, async () => {
      const { context, tab, errors, dialog } = await open(view, "?worst");
      try {
        await row(dialog, "山田 花子").first().waitFor();
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `02-sharing-v2-worst-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  // In a notebook (German, as the review sees it): only its owner, no service account yet, nobody found, the handle of
  // a code account, and staged changes. Every empty state is one quiet line; the field's words fit on the phone.
  for (const view of [views[0]!, views[2]!])
    test(`${view.name} px: a notebook's dialog in each state, every empty one a quiet line`, async () => {
      const { context, tab, errors, dialog } = await open(view, "?notebook&de");
      try {
        await row(dialog, "Mia Hoffmann").first().waitFor();
        const services = dialog.getByRole("region", { name: /Dienstkonten/ });
        await services.getByText("Noch kein Dienstkonto.").waitFor();
        expect(await dialog.getByText(/Postfach|Base/).count()).toBe(0);
        // the search field's words fit, in the size of its text
        const field = await dialog.getByRole("searchbox").evaluate((input: HTMLInputElement) => ({
          fits: input.scrollWidth <= input.clientWidth,
          placeholder: getComputedStyle(input, "::placeholder").fontSize,
          text: getComputedStyle(input).fontSize,
          words: input.placeholder,
        }));
        expect(field.fits, field.words).toBe(true);
        expect(field.placeholder).toBe(field.text);
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `03-notebook-${view.name}.png`) });

        // nobody is found: one quiet line, no box
        await dialog.getByRole("searchbox").fill("zz");
        await dialog.getByText("Niemand heißt „zz“.", { exact: false }).waitFor();
        expect(await dialog.locator('[data-k2-part="Empty"]').count()).toBe(0);
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `04-notebook-nobody-${view.name}.png`) });

        // found: rows that add
        await dialog.getByRole("searchbox").fill("noah");
        await row(dialog, "Noah Becker").waitFor();
        if (shots) await tab.screenshot({ path: join(shots, `05-notebook-search-${view.name}.png`) });
        await row(dialog, "Noah Becker").getByRole("button", { name: "Hinzufügen" }).click();

        // a code account by its handle
        await services.getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
        const handle = services.getByRole("textbox", { name: "Kennung des Dienstkontos" });
        // the empty line gives way to the field that adds one
        await handle.waitFor();
        expect(await services.getByText("Noch kein Dienstkonto.").count()).toBe(0);
        await handle.fill("code-7k2q9m4xwt");
        await handle.press("Enter");
        await row(services, "Code von Protokolle Vorstand").waitFor();
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `06-notebook-handle-${view.name}.png`) });
        await row(services, "Code von Protokolle Vorstand").getByRole("button", { name: "Dienstkonto hinzufügen" }).click();

        // staged: marks and what changes; the body scrolls, and the search field keeps its height
        await dialog.getByRole("region", { name: /Was sich ändert/ }).waitFor();
        expect(
          (await dialog.getByRole("searchbox").evaluate((input) => input.closest(".k2-input")!.getBoundingClientRect().height)) >= 32,
        ).toBe(true);
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `07-notebook-staged-${view.name}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  for (const view of [views[0]!, views[2]!])
    test(`${view.name} px: a notebook read without the right to change it says who manages it`, async () => {
      const { context, tab, errors, dialog } = await open(view, "?notebook&de&readonly");
      try {
        await row(dialog, "Mia Hoffmann").first().waitFor();
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `08-notebook-readonly-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
