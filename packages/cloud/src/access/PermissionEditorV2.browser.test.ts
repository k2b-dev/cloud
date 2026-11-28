import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";

// The permission editor on v2: a level change applies at once, a removal asks first, the last manager keeps Manage, a
// failed change says so in its row and tries again, a group shows its members. Invented people only.
const ui = resolve(import.meta.dir, "../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_PERMISSIONS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "PermissionEditorV2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-permissions-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Permissions v2 harness build failed");
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
    if (url.pathname === "/settings")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          '<!doctype html><html lang="en" class="light"><head><meta charset="utf-8">' +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
          `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
          '<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>',
      });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}/settings${query}`);
  await tab.evaluate(() => document.fonts.ready);
  await tab.locator('[data-k2-part="Row"]').first().waitFor();
  await settled(tab);
  return { context, tab, errors };
};
const calls = (tab: Page) => tab.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const row = (tab: Page, name: string) => tab.locator('[data-k2-part="Row"]').filter({ hasText: name }).first();
const clean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
};

describe("the permission editor on v2", () => {
  for (const view of views)
    test(`${view.name} px: every entry with its face, kind and level, clean`, async () => {
      const { context, tab, errors } = await open(view);
      try {
        for (const name of ["Mia Hoffmann", "Jonas Weber", "Logistik", "Lagerbot"]) await row(tab, name).waitFor();
        expect(await tab.locator('[data-k2-part="Mark"]').count()).toBeGreaterThanOrEqual(2);
        await clean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `01-permissions-v2-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("a level change applies at once and says it saved", async () => {
    const { context, tab } = await open(views[0]!);
    try {
      await row(tab, "Jonas Weber").getByRole("button", { name: "Edit", exact: true }).click();
      await tab.getByRole("menuitemradio", { name: /View/ }).click();
      await row(tab, "Jonas Weber").getByText("Saved").waitFor();
      expect(await calls(tab)).toEqual([{ update: "00000000-0000-4000-8000-000000000002", permission: "read" }]);
    } finally {
      await context.close();
    }
  });

  test("removing asks first, then the row leaves", async () => {
    const { context, tab } = await open(views[0]!);
    try {
      await row(tab, "Lagerbot")
        .getByRole("button", { name: /Remove Lagerbot/ })
        .click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Remove/ })
        .click();
      await tab.waitForFunction(() => (window as unknown as { calls: unknown[] }).calls.length > 0);
      await tab.locator('[data-k2-part="Row"]').filter({ hasText: "Lagerbot" }).waitFor({ state: "detached" });
      expect(await calls(tab)).toEqual([{ revoke: "00000000-0000-4000-8000-000000000004" }]);
    } finally {
      await context.close();
    }
  });

  test("removing the last row moves the focus to the Remove of the row before it", async () => {
    const { context, tab } = await open(views[0]!);
    try {
      const last = tab.locator('[data-k2-part="Row"]').last();
      const name = (await last.getByRole("button", { name: /^Remove / }).getAttribute("aria-label")) ?? "";
      await last.getByRole("button", { name: /^Remove / }).click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Remove/ })
        .click();
      await tab.getByRole("button", { name, exact: true }).waitFor({ state: "detached" });
      await settled(tab);
      expect(await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Remove Lagerbot");
    } finally {
      await context.close();
    }
  });

  test("removing a row in the middle moves the focus to the Remove of the row after it", async () => {
    const { context, tab } = await open(views[0]!);
    try {
      await row(tab, "Jonas Weber")
        .getByRole("button", { name: /Remove Jonas Weber/ })
        .click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Remove/ })
        .click();
      await tab.getByRole("button", { name: "Remove Jonas Weber", exact: true }).waitFor({ state: "detached" });
      await settled(tab);
      expect(await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Remove Logistik");
    } finally {
      await context.close();
    }
  });

  test("the last manager keeps Manage and cannot be removed", async () => {
    const { context, tab } = await open(views[0]!);
    try {
      const mia = row(tab, "Mia Hoffmann");
      expect(
        await mia
          .getByRole("button", { name: /only|last|Manage/i })
          .last()
          .isDisabled(),
      ).toBe(true);
      await mia.getByRole("button", { name: "Manage", exact: true }).click();
      expect(await tab.getByRole("menuitemradio", { name: /View/ }).isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("a failed change says so in its row and tries again", async () => {
    const { context, tab } = await open(views[0]!, "?fail");
    try {
      await row(tab, "Jonas Weber").getByRole("button", { name: "Edit", exact: true }).click();
      await tab.getByRole("menuitemradio", { name: /View/ }).click();
      await row(tab, "Jonas Weber").getByText("The change could not be saved.").waitFor();
      await row(tab, "Jonas Weber").getByRole("button", { name: "Try again" }).click();
      await row(tab, "Jonas Weber").getByText("Saved").waitFor();
    } finally {
      await context.close();
    }
  });

  // review of #4222: a check before the change that throws (`beforeChange`, before the row saves) said nothing in v2
  test("a check that fails before the change says so in its row and tries again", async () => {
    const { context, tab } = await open(views[0]!, "?guard");
    try {
      await row(tab, "Jonas Weber").getByRole("button", { name: "Edit", exact: true }).click();
      await tab.getByRole("menuitemradio", { name: /View/ }).click();
      await row(tab, "Jonas Weber").getByText("The policy could not be checked.").waitFor();
      await row(tab, "Jonas Weber").getByRole("button", { name: "Try again" }).click();
      await row(tab, "Jonas Weber").getByText("Saved").waitFor();
      expect(await calls(tab)).toEqual([{ update: "00000000-0000-4000-8000-000000000002", permission: "read" }]);
    } finally {
      await context.close();
    }
  });

  test("a failed removal says so in its row, keeps the row and tries again", async () => {
    const { context, tab } = await open(views[0]!, "?failrevoke");
    try {
      await row(tab, "Lagerbot")
        .getByRole("button", { name: /Remove Lagerbot/ })
        .click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Remove/ })
        .click();
      await row(tab, "Lagerbot").getByText("The access could not be removed.").waitFor();
      expect(await calls(tab)).toEqual([]);
      await row(tab, "Lagerbot").getByRole("button", { name: "Try again" }).click();
      await tab
        .getByRole("alertdialog")
        .getByRole("button", { name: /Remove/ })
        .click();
      await tab.locator('[data-k2-part="Row"]').filter({ hasText: "Lagerbot" }).waitFor({ state: "detached" });
      expect(await calls(tab)).toEqual([{ revoke: "00000000-0000-4000-8000-000000000004" }]);
    } finally {
      await context.close();
    }
  });

  test("a group shows who receives access through it", async () => {
    const { context, tab } = await open(views[2]!);
    try {
      await row(tab, "Logistik")
        .getByRole("button", { name: /Members/ })
        .click();
      await tab.getByText("Noah Becker").waitFor();
      await tab.getByText("Lea Schmitt").waitFor();
    } finally {
      await context.close();
    }
  });

  test("read-only shows levels in words, without controls", async () => {
    const { context, tab } = await open(views[0]!, "?readonly");
    try {
      expect(await tab.getByRole("button", { name: /^(View|Edit|Manage)$/ }).count()).toBe(0);
      expect(await tab.getByRole("button", { name: /Remove/ }).count()).toBe(0);
      await row(tab, "Jonas Weber").getByText("Edit").waitFor();
    } finally {
      await context.close();
    }
  });

  for (const view of [views[0]!, views[2]!])
    test(`${view.name} px: the worst case stays readable and nothing overflows`, async () => {
      const { context, tab, errors } = await open(view, "?worst");
      try {
        await row(tab, "山田 花子").waitFor();
        await clean(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
