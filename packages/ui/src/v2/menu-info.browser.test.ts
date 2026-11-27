import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, pattern, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menu-info.demo";

// An entry that only says something (`info: true`), as the members a space lists in its menu (Spaces, W3): sign, name
// and meta at the full contrast of an entry, plain text for assistive technology, no stop of the keys, and nothing
// happens on a click. In test/v2-menu-info.demo.tsx, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";
const menu = ".k2-menu";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-menu-info"), serverMarkup("../v2-menu-info"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, theme: "light" | "dark" = "light") => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 }, colorScheme: theme });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${theme === "dark" ? ' class="dark"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const open = async (page: Page) => {
  await page.getByRole("button", { name: "Mitglieder" }).focus();
  await page.keyboard.press("Enter");
  await page.locator(menu).waitFor();
  await settled(page);
};
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

test("server markup: the menu's button is sent, no popup", () => {
  expect(markup).toContain("Mitglieder");
  expect(markup).not.toContain("Anna Berger");
});

test("an info entry is plain text in the menu: no menu item, no tab stop, not disabled; its group names it as its description", async () => {
  await withPage(async (page) => {
    await open(page);
    // only the deeds are menu items; the people are text
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Einladen", "Space verlassen"]);
    const found = await page.evaluate(() => {
      const entries = [...document.querySelectorAll<HTMLElement>(".k2-menu [data-info]")];
      return entries.map((entry) => ({
        text: entry.textContent?.replace(/\s+/g, " ").trim(),
        role: entry.getAttribute("role"),
        tabindex: entry.getAttribute("tabindex"),
        disabled: entry.getAttribute("aria-disabled") ?? entry.getAttribute("data-disabled"),
        // the people stand in the group the heading "Mitglieder" names
        group: entry.closest('[role="group"]')?.getAttribute("aria-labelledby")
          ? document.getElementById(entry.closest('[role="group"]')!.getAttribute("aria-labelledby")!)?.textContent
          : null,
      }));
    });
    expect(found).toEqual(
      [
        ["Anna Berger", "Verwaltung"],
        ["Jonas Hartwig", "Mitglied"],
        ["Jule Amsel", "Gast"],
      ].map(([name, meta]) => ({ text: `${name}, ${meta};`, role: null, tabindex: null, disabled: null, group: "Mitglieder" })),
    );
    // the keys pass over them, so the group that holds them names them as its description: a screen reader hears
    // who is in the space once, as the group is entered
    const said = "Anna Berger, Verwaltung; Jonas Hartwig, Mitglied; Jule Amsel, Gast;";
    const described = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>(".k2-menu [data-info]")!.closest('[role="group"]')!;
      const ids = (group.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      return {
        infos: ids.every((id) => document.getElementById(id)?.hasAttribute("data-info")),
        text: ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" "),
      };
    });
    expect(described).toEqual({ infos: true, text: said });
    if (browserName !== "webkit") {
      // the description as the browser computes it for assistive technology
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
        nodes: { role?: { value?: string }; name?: { value?: string }; description?: { value?: string } }[];
      };
      const group = nodes.find((node) => node.role?.value === "group" && node.name?.value === "Mitglieder");
      expect(
        group?.description?.value
          ?.replace(/\s+([,;])/g, "$1")
          .replace(/\s+/g, " ")
          .trim(),
      ).toBe(said);
    }
    // the menu keeps the menu pattern of ui-sdk
    expect(await pattern(page, menu, "menu")).toBe("ok");
  });
});

test("the arrows pass over the info entries: from the first deed to the next deed and back", async () => {
  await withPage(async (page) => {
    await open(page);
    expect(await focused(page)).toBe("Einladen");
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("Space verlassen");
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toBe("Einladen");
    // a click on a person does nothing and the menu stays open
    await page.locator(".k2-menu [data-info]").first().click();
    await settled(page);
    expect([await page.locator(menu).count(), await page.evaluate(() => window.__infoDeeds ?? [])]).toEqual([1, []]);
  });
});

for (const theme of ["light", "dark"] as const)
  test(`${theme}: an info entry reads at the full contrast of an entry, never dimmed`, async () => {
    await withPage(async (page) => {
      await open(page);
      const found = await page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const own = getComputedStyle(element);
          return { color: own.color, opacity: own.opacity };
        };
        return {
          deed: style('.k2-menu [role="menuitem"] .k2-mi-label'),
          info: style(".k2-menu [data-info] .k2-mi-label"),
          entry: getComputedStyle(document.querySelector(".k2-menu [data-info]")!).opacity,
        };
      });
      expect([found.info, found.entry]).toEqual([found.deed, "1"]);
    }, theme);
  });
