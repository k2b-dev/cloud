import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// On a signed-in phone an open v2 detail's way back (the part `Back`) takes the title's place in the phone bar:
// "‹ Posteingang", then search, help and the app menu, which stay usable. Only the shell's stylesheet does it; the
// page's markup and the app stay as they are.
const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-phone-back-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: LayoutHeader } = await import("./LayoutHeader");
const { ShellDataProvider } = await import("./shell-data");
const { Bar, Pane, Text, Workspace } = await import("@k2b/ui/v2");

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const header = () =>
  renderToString(() =>
    createComponent(ShellDataProvider, {
      data: { apps: [], legalLinks: [], profile: { name: "Demo User" }, theme: "light", searchLinks: {} },
      get children() {
        return createComponent(LayoutHeader, { authenticated: true, title: "Mail", launchpad: true });
      },
    }),
  );

/** Mail's mailbox on v2: the list and, when `open`, a conversation with its way back to the list. */
const workspace = (open: boolean, list = "Posteingang") =>
  renderToString(() =>
    createComponent(Workspace, {
      get head() {
        return createComponent(Bar, { start: "Alle · Handlungsbedarf" });
      },
      get children() {
        return createComponent(Pane.Split, {
          get children() {
            return [
              createComponent(Pane, {
                label: "Liste",
                get children() {
                  return createComponent(Text, { children: "Holzwerk Brandt" });
                },
              }),
              open &&
                createComponent(Pane, {
                  detail: true,
                  label: "Nachricht",
                  back: { label: list, href: "/app/mail/Box001" },
                  get head() {
                    return createComponent(Bar, { start: "Angebot Eichenplatten" });
                  },
                  get children() {
                    return createComponent(Text, { children: "Guten Tag Frau Solberg" });
                  },
                }),
            ];
          },
        });
      },
    }),
  );

/** The page as Layout puts it together on a signed-in phone: the bar, the row of the way up, then the card. */
const shell = (open: boolean, banner = false, list?: string) =>
  `<div class="cloud-app-canvas relative flex h-dvh w-full overflow-hidden" data-layout-header data-layout-authenticated="true">` +
  `<div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col" data-cloud-app-area="">${header()}` +
  (banner ? `<div role="status">Neue Version verfügbar</div>` : "") +
  `<div class="layout-page-head" data-trail="title"></div>` +
  `<main class="layout-content-main min-h-0 min-w-0 flex-1 k2-ui">${workspace(open, list)}</main></div></div>`;

const open = async (markup: string, width = 390): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui">${markup}</body></html>`,
  );
  await settled(page);
  return page;
};

/**
 * What a person sees in the phone bar's row, left to right: each control's name and left edge, whether a tap on its
 * middle reaches it, and whether it runs into the next one (a text's width depends on the engine's font).
 */
const barRow = (page: Page) =>
  page.evaluate(() => {
    const name = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const inRow = Array.from(document.querySelectorAll("a[href], button"))
      .filter((element) => visible(element) && element.getBoundingClientRect().bottom <= 46.5)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return inRow.map((element, index) => {
      const box = element.getBoundingClientRect();
      const tapped = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("a[href], button");
      const next = inRow[index + 1]?.getBoundingClientRect();
      return [
        `${name(element)} at ${Math.round(box.left)}`,
        tapped === element ? "" : ` (a tap reaches ${tapped ? name(tapped) : "nothing"})`,
        next && box.right > next.left ? " (runs into the next)" : "",
      ].join("");
    });
  });

/** The names the keyboard reaches with Tab, from the start of the page. */
const tabOrder = async (page: Page, steps: number) => {
  const names: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("Tab");
    names.push(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? ""),
    );
  }
  return names;
};

/** Where the card (the page's content) begins: below the bar, or at the top when the way back shares the bar's row. */
const cardTop = (page: Page) => page.evaluate(() => document.querySelector(".layout-content-main")!.getBoundingClientRect().top);

test("an open detail's way back takes the title's place in the phone bar; search, help and apps stay usable", async () => {
  const page = await open(shell(true));
  try {
    // One row: the way back where the title was, then the bar's controls, each reached by a tap on it.
    expect(await barRow(page)).toEqual(["Posteingang at 8", "Open global search at 278", "Open help at 314", "Open apps at 350"]);
    expect(await cardTop(page)).toBe(0);
    expect(await page.locator(".layout-header-title").isVisible()).toBe(false);
    // The only way back, named by the list it leads to; the workspace head (the views) gives way (#4085).
    expect(await page.getByRole("link", { name: "Posteingang" }).count()).toBe(1);
    expect(await page.getByText("Alle · Handlungsbedarf").isVisible()).toBe(false);
    // The keyboard meets the bar's controls first and then the way back, the first stop of the content.
    expect(await tabOrder(page, 4)).toEqual(["Open global search", "Open help", "Open apps", "Posteingang"]);
  } finally {
    await page.close();
  }
}, 30_000);

// Known gap of @k2b/ui v2 (reported to lane C, 24.11.): the text button of `Back` does not end a long name in "…"
// but runs past its bar, on any page. It turns red once `Back` shortens its name: then make it a plain test.
test.failing("a long list name ends before the bar's controls", async () => {
  const page = await open(shell(true, false, "Suchergebnisse für Eichenplatten aus dem Lager Nord"));
  try {
    expect(await barRow(page)).toEqual([
      "Suchergebnisse für Eichenplatten aus dem Lager Nord at 8",
      "Open global search at 278",
      "Open help at 314",
      "Open apps at 350",
    ]);
  } finally {
    await page.close();
  }
}, 30_000);

test("without an open detail the phone bar keeps its title and the card starts below it", async () => {
  const page = await open(shell(false));
  try {
    expect(await page.locator(".layout-header-title").isVisible()).toBe(true);
    expect(await cardTop(page)).toBe(46);
    expect(await page.getByText("Alle · Handlungsbedarf").isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);

test("a banner between the bar and the content keeps the bar whole and the way back in its own row", async () => {
  const page = await open(shell(true, true));
  try {
    expect(await page.locator(".layout-header-title").isVisible()).toBe(true);
    const banner = await page.getByRole("status").boundingBox();
    expect(banner?.y).toBe(46);
    const back = await page.getByRole("link", { name: "Posteingang" }).boundingBox();
    expect(back?.y).toBeGreaterThan(46 + (banner?.height ?? 0));
  } finally {
    await page.close();
  }
}, 30_000);

test("from 768 px the way back stays hidden and nothing of the phone bar applies", async () => {
  const page = await open(shell(true), 1024);
  try {
    expect(await page.getByRole("link", { name: "Posteingang" }).isVisible()).toBe(false);
    expect(await page.locator(".layout-header").isVisible()).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);
