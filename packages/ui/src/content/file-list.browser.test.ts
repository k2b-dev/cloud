import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// A details panel with an open file list, a row with a secondary action, and a closed section with a summary.
// Whether actions keep their slot, a fill covers a whole row, and a row keeps its height is a question of layout
// and paint, which happy-dom does not model, so a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "file-list.fixture.ts");
const fixture = `
import { createComponent as c, render } from "solid-js/web";
import { DetailPanel, FileGrid, FileTypeIcon, IconButton, fileKindLabel } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const pixel = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#7c9cd6"/></svg>');
const files = [
  ["Brochure-v3.pdf", "4.2 MB"], ["Costing.xlsx", "64 KB"], ["Briefing.docx", "48 KB"], ["Colour-profile.icc", "12 KB"],
  ["Print-data.zip", "48 MB"], ["Page-4.jpg", "1.8 MB"], ["Page-7.jpg", "2.0 MB"], ["Setup-01.jpg", "2.4 MB"],
].map(([name, size]) => ({ name, size }));
const isImage = (file) => file.name.endsWith(".jpg");
window.opened = [];
const icon = (name) => Object.assign(document.createElement("i"), { className: "ti " + name, ariaHidden: "true" });
const actions = (file) => [
  c(IconButton, { size: "sm", variant: "ghost", label: "Download " + file.name, get children() { return icon("ti-download"); } }),
  c(IconButton, { size: "sm", variant: "ghost", label: "Save " + file.name, get children() { return icon("ti-folder-down"); } }),
];
const list = () => c(FileGrid, {
  rows: files, label: "Attachments", layout: "list", limit: 5, actionVisibility: "progressive",
  getRowId: (file) => file.name,
  renderPreview: (file) => isImage(file) ? Object.assign(document.createElement("img"), { src: pixel, alt: "" }) : c(FileTypeIcon, { name: file.name }),
  renderLabel: (file) => file.name,
  renderMeta: (file) => fileKindLabel(file, "en") + " · " + file.size,
  renderActions: actions,
  moreMeta: "2 duplicates merged",
  toolbar: "8 files",
  groups: (rows) => [
    { id: "files", label: "Files", rows: rows.filter((file) => !isImage(file)) },
    { id: "images", label: "Images", rows: rows.filter(isImage), layout: "tiles" },
  ],
  onOpen: (file) => window.opened.push(file.name),
});
render(() => c(DetailPanel, { surface: "plain", get children() { return c(DetailPanel.Body, { scrollFade: false, get children() { return [
  c(DetailPanel.Section, { title: "Attachments", count: files.length, get children() { return list(); } }),
  c(DetailPanel.Section, { title: "Linked", get children() { return c(DetailPanel.Action, {
    title: "Brochure task", href: "#task", secondaryAction: { icon: "ti ti-unlink", label: "Unlink Brochure task", onClick() {} },
  }); } }),
  c(DetailPanel.Group, { title: "More about this conversation", get children() { return [
    c(DetailPanel.Section, { title: "Activity", count: 4, collapsible: true, summary: "Lena Hoffmann assigned herself", children: "Assigned, tagged, received" }),
    c(DetailPanel.Section, { title: "Technical details", collapsible: true, summary: "Sender, headers, original", children: "Message-ID" }),
  ]; } }),
]; } }); } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the file list fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, theme: "light" | "dark", input?: "touch") => {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.route(`${assets}**`, (route) => route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }));
  await page.setContent(
    `<!doctype html><html lang="en"${input ? ` data-k2b-input="${input}"` : ""}><head><style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important}</style></head>" +
      `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface)">` +
      `<div id="app" style="width:min(25rem,100%);height:68rem;padding:0.75rem;box-sizing:border-box"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByRole("list", { name: "Attachments" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(width - 2, 1090);
  return page;
};

/** Every box in the panel; a hover, focus, or reveal must leave all of them where they are. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".k2b-detail-panel *"))
      .filter((element) => getComputedStyle(element).display !== "none" && !element.closest("[hidden]"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.className || element.tagName} ${[box.x, box.y, box.width, box.height].map((value) => value.toFixed(2)).join(" ")}`;
      }),
  );
const actionOpacity = (page: Page, name: string) =>
  page.evaluate((name) => {
    const item = Array.from(document.querySelectorAll(".k2b-file-grid__item")).find((element) => element.textContent?.includes(name))!;
    return Number(getComputedStyle(item.querySelector(".k2b-file-grid__actions")!).opacity);
  }, name);

describe("@k2b/ui open file list and K1 detail rows", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: shows the first five, opens the full list in place as files and image tiles, and closes it again`, async () => {
      const page = await load(1440, theme);
      try {
        const names = () => page.locator(".k2b-file-grid__name").allTextContents();
        expect(await names()).toEqual(["Brochure-v3.pdf", "Costing.xlsx", "Briefing.docx", "Colour-profile.icc", "Print-data.zip"]);
        expect(await page.locator(".k2b-file-grid__meta").allTextContents()).toEqual([
          "PDF · 4.2 MB",
          "Spreadsheet · 64 KB",
          "Document · 48 KB",
          "ICC · 12 KB",
          "Archive · 48 MB",
        ]);
        // Rows are 3rem tall with a 2.25rem preview; the actions keep their slot while hidden.
        const row = (await page.locator(".k2b-file-grid__item").first().boundingBox())!;
        expect(Math.round(row.height)).toBe(48);
        expect(Math.round((await page.locator(".k2b-file-grid__preview").first().boundingBox())!.width)).toBe(36);
        await page.screenshot({ path: `/tmp/k2b-ui-file-list-short-${theme}.png`, fullPage: true });

        const more = page.getByRole("button", { name: /Show all 8/ });
        expect(await more.textContent()).toContain("2 duplicates merged");
        await more.click();
        expect(await page.getByRole("button", { name: "Show less" }).evaluate((button) => button === document.activeElement)).toBe(true);
        expect(await page.locator(".k2b-file-grid-stack__toolbar").textContent()).toBe("8 files");
        expect(await page.locator(".k2b-file-grid-stack__label").allTextContents()).toEqual(["Files5", "Images3"]);
        const tiles = page.locator('.k2b-file-grid[data-layout="tiles"] .k2b-file-grid__item');
        expect(await tiles.count()).toBe(3);
        const tile = (await tiles.first().boundingBox())!;
        expect(Math.abs(tile.width / tile.height - 4 / 3)).toBeLessThan(0.02);
        await page.screenshot({ path: `/tmp/k2b-ui-file-list-full-${theme}.png`, fullPage: true });

        // A tile opens like a row; its name is the button's accessible name.
        await page.getByRole("button", { name: "Page-7.jpg", exact: true }).click();
        expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["Page-7.jpg"]);

        await page.getByRole("button", { name: "Show less" }).click();
        expect(await names()).toHaveLength(5);
        expect(await page.getByRole("button", { name: /Show all 8/ }).evaluate((button) => button === document.activeElement)).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("with a mouse, row actions show on hover and focus inside the row's surface without moving anything", async () => {
    const page = await load(1440, "light");
    try {
      const rest = await boxes(page);
      expect(await actionOpacity(page, "Costing.xlsx")).toBe(0);
      const box = (await page.locator(".k2b-file-grid__item").nth(1).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      expect(await actionOpacity(page, "Costing.xlsx")).toBe(1);
      expect(await actionOpacity(page, "Brochure-v3.pdf")).toBe(0);
      // The actions lie inside the hovered surface.
      const actions = (await page.locator(".k2b-file-grid__actions").nth(1).boundingBox())!;
      expect(actions.x + actions.width).toBeLessThanOrEqual(box.x + box.width + 0.01);
      expect(await boxes(page)).toEqual(rest);

      await page.mouse.move(1438, 1090);
      await page.getByRole("button", { name: "Briefing.docx", exact: true }).focus();
      expect(await actionOpacity(page, "Briefing.docx")).toBe(1);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Download Briefing.docx");
      expect(await boxes(page)).toEqual(rest);

      // A DetailPanel.Action row fills as one surface: the fill reaches past its secondary button.
      const linked = page.locator(".k2b-detail-panel__action-row");
      const rowBox = (await linked.boundingBox())!;
      await page.mouse.move(rowBox.x + 20, rowBox.y + rowBox.height / 2);
      const fill = await linked.evaluate((row) => {
        const before = getComputedStyle(row, "::before");
        const secondary = row.querySelector(".k2b-detail-panel__action-secondary")!.getBoundingClientRect();
        const own = row.getBoundingClientRect();
        return { color: before.backgroundColor, right: own.right + Number.parseFloat(before.right) * -1, secondaryRight: secondary.right };
      });
      expect(fill.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(fill.right).toBeGreaterThan(fill.secondaryRight);
      expect(await boxes(page)).toEqual(rest);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("on touch, row actions always show", async () => {
    const touch = await load(390, "light", "touch");
    try {
      for (const name of ["Brochure-v3.pdf", "Print-data.zip"]) expect(await actionOpacity(touch, name)).toBe(1);
      await touch.screenshot({ path: "/tmp/k2b-ui-file-list-touch.png", fullPage: true });
    } finally {
      await touch.close();
    }
  }, 30_000);

  test("a closed section with a summary says what it holds, keeps 2.75rem in both states, and hides the line while open", async () => {
    const page = await load(1440, "light");
    try {
      const title = page.locator(".k2b-detail-panel__group-title");
      expect(await title.textContent()).toBe("More about this conversation");
      expect(await page.getByRole("group", { name: "More about this conversation" }).count()).toBe(1);
      const toggle = page.getByRole("button", { name: /Activity/ });
      expect(await toggle.textContent()).toContain("Lena Hoffmann assigned herself");
      const closed = (await toggle.boundingBox())!;
      expect(Math.round(closed.height)).toBe(44);
      const next = (await page.getByRole("button", { name: /Technical details/ }).boundingBox())!;
      // The rows stand flush below the title.
      expect(Math.round(next.y - (closed.y + closed.height))).toBe(0);
      await toggle.click();
      const header = page.locator('.k2b-detail-panel__section[data-open="true"] .k2b-detail-panel__section-header');
      expect(Math.round((await header.boundingBox())!.height)).toBe(44);
      expect(await page.locator(".k2b-detail-panel__section-preview").first().isVisible()).toBe(false);
      await page.screenshot({ path: "/tmp/k2b-ui-detail-more-open.png", fullPage: true });
    } finally {
      await page.close();
    }
  }, 30_000);
});
