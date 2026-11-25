import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { sentVsLive } from "../../test/sent-vs-live";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-row-select.client";
import { measureV2Layout } from "./testing";

// A row in a selection (`Row select`), as Mail draws "2 ausgewählt": a box in the lead named by the row's title, the
// blue tint of a selected table row, apart from the open row's tint and combined with it. Rendered on the server and
// hydrated in the browser (test/v2-row-select.fixture.tsx), in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// The app colour of the page (teal), so the open row's tint differs from the blue of the selection.
const testCss =
  "html, body { margin: 0; height: 100%; } body { --k2-app: #0f766e; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-row-select-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-row-select.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-row-select.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, dark = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui${dark ? " dark" : ""}"><div id="root">${server.html}</div></body></html>`,
    );
    await page.evaluate(() => {
      window.__k2Sent = document.getElementById("root")!.cloneNode(true);
    });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Hydrated === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each row of the list: its title, whether its box is set, its open state and its background. */
const rowsInPage = () =>
  [...document.querySelectorAll<HTMLElement>('[aria-label="Nachrichten"] > .k2-row')].map((row) => {
    const box = row.querySelector<HTMLInputElement>(':scope > .k2-row-lead input[type="checkbox"]');
    return {
      title: row.querySelector(".k2-row-title")?.textContent,
      box: box ? box.checked : null,
      named: box ? document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent : null,
      current: row.getAttribute("aria-current"),
      background: getComputedStyle(row).backgroundColor,
    };
  });

const tints = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("i");
    document.querySelector(".k2-row")!.append(probe);
    const colour = (value: string) => {
      probe.style.backgroundColor = value;
      return getComputedStyle(probe).backgroundColor;
    };
    const found = { blue: colour("var(--k2-blue-tint)"), app: colour("var(--k2-app-tint)"), plain: "rgba(0, 0, 0, 0)" };
    probe.remove();
    return found;
  });

test("hydration: the live list in a selection is what the server sent", async () => {
  await withPage(async (page) => {
    expect(await page.evaluate(sentVsLive)).toEqual([]);
  });
});

for (const dark of [false, true])
  test(`${dark ? "dark" : "light"}: a selected row is blue, the open row has the app's tint, open and selected stays blue`, async () => {
    await withPage(
      async (page) => {
        const tint = await tints(page);
        expect(tint.blue).not.toBe(tint.app);
        expect(await page.evaluate(rowsInPage)).toEqual([
          { title: "Holzwerk Brandt", box: true, named: "Holzwerk Brandt", current: "true", background: tint.blue },
          { title: "Jonas Hartwig", box: false, named: "Jonas Hartwig", current: null, background: tint.plain },
          { title: "Stadtwerke Auental", box: true, named: "Stadtwerke Auental", current: null, background: tint.blue },
          { title: "Jule Amsel", box: false, named: "Jule Amsel", current: null, background: tint.plain },
        ]);
        // the open row out of the selection keeps the tint of the app
        await page.getByRole("checkbox", { name: "Holzwerk Brandt" }).click();
        await page.getByText("1 ausgewählt").waitFor();
        await settled(page);
        expect((await page.evaluate(rowsInPage))[0]).toMatchObject({ box: false, current: "true", background: tint.app });
      },
      { dark },
    );
  });

test("the box is a checkbox named by the title: a click and the space key change the selection, never open the row", async () => {
  await withPage(async (page) => {
    const hash = () => page.evaluate(() => location.hash);
    const box = page.getByRole("checkbox", { name: "Jonas Hartwig" });
    expect(await box.isChecked()).toBe(false);
    await box.click();
    await page.getByText("3 ausgewählt").waitFor();
    expect(await box.isChecked()).toBe(true);
    expect(await hash()).toBe("");
    // the keyboard reaches the box, shows where it stands, and space sets it
    await page.getByRole("checkbox", { name: "Jule Amsel" }).focus();
    await page.keyboard.press("Space");
    await page.getByText("4 ausgewählt").waitFor();
    await settled(page);
    const ring = await page.evaluate(() => {
      const input = document.activeElement!;
      return getComputedStyle(input.nextElementSibling!).boxShadow;
    });
    expect(ring).not.toBe("none");
    expect(await hash()).toBe("");
    // the rest of the row still opens its entry
    const row = page.locator('.k2-row:has-text("Jonas Hartwig")');
    const rowBox = (await row.boundingBox())!;
    await page.mouse.click(rowBox.x + rowBox.width * 0.6, rowBox.y + rowBox.height / 2);
    expect(await hash()).toBe("#hartwig");
    expect(await box.isChecked()).toBe(true);
  });
});

for (const width of [1440, 390])
  test(`${width} px: no layout rule broken; the box's target stays inside its row, before the title, and a tap beside the mark sets it`, async () => {
    await withPage(
      async (page) => {
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        // on the phone the list is the page while nothing is open: the detail closes through its way back, its one
        // way out there (the × gives way)
        if (width < 768) {
          expect(await page.getByRole("link", { name: "Schließen" }).isVisible()).toBe(false);
          await page.getByRole("link", { name: "Posteingang" }).click();
          await page.locator(".k2-pane[data-detail]").waitFor({ state: "detached" });
          await settled(page);
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        }
        const target = await page.evaluate(() =>
          [...document.querySelectorAll('[aria-label="Nachrichten"] > .k2-row')].map((row) => {
            const input = row.querySelector(".k2-mark-input")!.getBoundingClientRect();
            const box = row.getBoundingClientRect();
            const title = row.querySelector(".k2-row-title")!.getBoundingClientRect();
            return {
              wide: Math.round(input.width),
              high: Math.round(input.height),
              inside: input.top >= box.top - 0.5 && input.bottom <= box.bottom + 0.5 && input.left >= box.left - 0.5,
              beforeTitle: input.right <= title.left + 0.5,
            };
          }),
        );
        for (const each of target) expect(each).toEqual({ wide: 36, high: 36, inside: true, beforeTitle: true });
        // every box stands on one line and every title starts on one edge, the row of a person too
        const edges = await page.evaluate(() =>
          [...document.querySelectorAll('[aria-label="Nachrichten"] > .k2-row')].map((row) => [
            Math.round(row.querySelector(".k2-check")!.getBoundingClientRect().left),
            Math.round(row.querySelector(".k2-row-title")!.getBoundingClientRect().left),
          ]),
        );
        expect(new Set(edges.map((edge) => edge.join())).size).toBe(1);
        const mark = (await page.locator('.k2-row:has-text("Jule Amsel") .k2-check').boundingBox())!;
        await page.mouse.click(mark.x + mark.width + 6, mark.y + mark.height / 2);
        await page.getByText("3 ausgewählt").waitFor();
        expect(await page.getByRole("checkbox", { name: "Jule Amsel" }).isChecked()).toBe(true);
      },
      { width },
    );
  });
