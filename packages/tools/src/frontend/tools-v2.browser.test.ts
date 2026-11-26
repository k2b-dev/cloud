import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { buildHarness } from "./tools/image-intake/browser-harness";

// Every Tools screen on v2 at 1440, 1024 and 390 px: no outline problem, no layout problem, no loader in the first
// picture, no page error. CLOUD_TOOLS_SHOTS=<dir> keeps a light screenshot and the outline of each.
const SCREENS = [
  "catalog",
  "password",
  "uuid",
  "lorem",
  "hash",
  "encoding",
  "color",
  "mailto",
  "encryption",
  "qr",
  "image-converter",
  "image",
  "image-one",
  "image-open",
  "image-markup",
  "image-worst",
];
const shots = process.env.CLOUD_TOOLS_SHOTS;
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const harness = await buildHarness(new URL("./tools-v2.browser-harness.tsx", import.meta.url));
  const styles = await appHostCss(resolve(import.meta.dir, "../styles/app.css"));
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  const icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  // the real faces (IBM Plex), so a picture shows the type the product shows
  const plexUrl = import.meta.resolve("@k2b/ui/fonts/plex.css");
  const plex = (await Bun.file(fileURLToPath(plexUrl)).text()).replaceAll("./fonts/", "/fonts/");
  const fontsDir = fileURLToPath(new URL("./fonts/", plexUrl));
  // real photos for the photo editor (the Venue app's café templates)
  const photosDir = resolve(import.meta.dir, "../../../venue/public/templates");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.css") return new Response(icons.css, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(icons.font));
      if (url.pathname === "/fonts.css") return new Response(plex, { headers: { "Content-Type": "text/css" } });
      if (url.pathname.startsWith("/fonts/") && !url.pathname.includes(".."))
        return new Response(Bun.file(resolve(fontsDir, url.pathname.slice("/fonts/".length))));
      if (url.pathname.startsWith("/photos/") && !url.pathname.includes(".."))
        return new Response(Bun.file(resolve(photosDir, url.pathname.slice("/photos/".length))));
      if (url.pathname === "/entry.js")
        return new Response(harness, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tabler-icons.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><div id="app" class="k2-ui" style="display:flex;height:100%"></div><script src="/entry.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const check = async (page: Page, name: string, width: number) => {
  await page.locator('[data-k2-part="Workspace"]').waitFor();
  const loaders = await page.locator('[data-k2-part="Loading"], [aria-busy="true"]').count();
  const outline = await describeV2Page(page);
  const layout = await measureV2Layout(page);
  if (shots) {
    await page.screenshot({ path: resolve(shots, `${name}-${width}.png`) });
    const elements = await page.locator("#app *").count();
    await Bun.write(resolve(shots, `${name}-${width}.txt`), `${outline}\nelements ${elements}\n${JSON.stringify(layout.problems)}`);
  }
  return { loaders, problems: outline.includes("Problems") ? outline : null, layout: layout.problems };
};

for (const name of SCREENS)
  test(`the Tools screen "${name}" holds its v2 shape at 1440, 1024 and 390 px`, async () => {
    for (const width of [1440, 1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const errors = pageErrors(page);
        await page.goto(`${server.url.href}?screen=${name}`);
        expect({ width, errors, ...(await check(page, name, width)) }).toEqual({
          width,
          errors: [],
          loaders: 0,
          problems: null,
          layout: [],
        });
      } finally {
        await page.close();
      }
    }
  }, 60_000);

test("the catalog finds a tool by task and keeps the search in the address", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=catalog`);
    await page.getByRole("searchbox", { name: "Werkzeuge suchen" }).fill("sha256");
    await page
      .getByRole("link", { name: /Prüfsumme/ })
      .first()
      .waitFor();
    expect(new URL(page.url()).searchParams.get("q")).toBe("sha256");
    await page.getByRole("searchbox", { name: "Werkzeuge suchen" }).fill("zzzzzzzzzzzz");
    await page.getByRole("button", { name: "Suche zurücksetzen" }).click();
    expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  } finally {
    await page.close();
  }
});

test("encoding shows its error at the field and the hash of the text", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=encoding`);
    await page.getByRole("radio", { name: "Dekodieren" }).check();
    await page.getByRole("textbox").first().fill("%%%");
    expect(await page.locator('[data-k2-part="Field"]').filter({ hasText: "Base64" }).last().textContent()).not.toBe("");
    await page.goto(`${server.url.href}?screen=hash`);
    await page.getByRole("textbox").first().fill("abc");
    await page.getByText("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").waitFor();
  } finally {
    await page.close();
  }
});

test("the photo editor exports from a dialog, crops on the stage and writes a text mark from a dialog", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const errors = pageErrors(page);
    await page.goto(`${server.url.href}?screen=image-one`);
    await page.locator('[data-k2-part="Workspace"]').waitFor();
    // export: a dialog with the format and the size, closed again without a download
    await page.getByRole("button", { name: "Exportieren" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Bild exportieren" });
    await dialog.getByRole("radio", { name: "PNG" }).check();
    expect(await dialog.getByRole("spinbutton", { name: /Qualität/ }).count()).toBe(0);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await dialog.waitFor({ state: "detached" });
    // crop: the frame and its handles stand on the photo until it is cancelled
    await page.getByRole("button", { name: "Zuschneiden" }).click();
    await page.locator('[data-crop-handle="se"]').waitFor();
    expect(await page.getByRole("button", { name: "Bilder hinzufügen" }).first().isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await page.locator('[data-crop-handle="se"]').waitFor({ state: "detached" });
    // markup: the text tool asks for its words, and the mark counts on its tab
    await page.getByRole("button", { name: "Markieren" }).click();
    await page.getByRole("button", { name: "Text", exact: true }).click();
    const stage = await page.getByAltText("Vorschau").boundingBox();
    if (!stage) throw new Error("The photo is not on the stage");
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    const words = page.getByRole("dialog", { name: "Text hinzufügen" });
    await words.getByRole("textbox", { name: "Text" }).fill("Tisch 4");
    await words.getByRole("button", { name: "Hinzufügen" }).click();
    await words.waitFor({ state: "detached" });
    await page.locator('[data-k2-part="Tabs"]').getByText("1", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Markierung rückgängig machen" }).isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("the photo editor's export names a setting that is not valid at its field and holds the export", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=image-one`);
    await page.locator('[data-k2-part="Workspace"]').waitFor();
    await page.getByRole("button", { name: "Exportieren" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Bild exportieren" });
    const exportButton = dialog.getByRole("button", { name: "Exportieren" });
    await dialog.getByRole("spinbutton", { name: /Qualität/ }).fill("5");
    await dialog.getByText("Gib eine Qualität von 10 bis 100 ein.").waitFor();
    expect(await exportButton.isDisabled()).toBe(true);
    await dialog.getByRole("spinbutton", { name: /Qualität/ }).fill("80");
    await dialog.getByRole("spinbutton", { name: /Maximale Breite/ }).fill("0");
    await dialog.getByText("Gib eine ganze Zahl ab 1 ein oder lass das Feld leer.").waitFor();
    expect(await exportButton.isDisabled()).toBe(true);
    await dialog.getByRole("spinbutton", { name: /Maximale Breite/ }).fill("");
    expect(await exportButton.isDisabled()).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);

test("the photo editor's own picture tiles show where the keyboard is", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=image-open`);
    await page.locator('[data-k2-part="Workspace"]').waitFor();
    const tiles = page.locator("[data-tools-tile]");
    expect(await tiles.count()).toBeGreaterThan(8);
    await page.keyboard.press("Shift");
    for (const index of [0, 4, 6]) {
      await tiles.nth(index).focus();
      expect(await tiles.nth(index).evaluate((tile) => getComputedStyle(tile).outlineStyle)).toBe("solid");
    }
  } finally {
    await page.close();
  }
}, 30_000);

test("the photo editor has one head row: the open photo is the last step of the path, its facts stand in the inspector", async () => {
  for (const width of [1440, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`${server.url.href}?screen=image-open`);
      await page.locator('[data-k2-part="Workspace"]').waitFor();
      // no second full-width row under the head
      expect({ width, rows: await page.locator('[data-k2-part="StatusRow"]').count() }).toEqual({ width, rows: 0 });
      expect(await page.locator('[data-k2-part="Path"]').textContent()).toContain("IMG_20261121_0912_Espresso.jpg");
      const inspector = page.getByRole("region", { name: "Bildwerkzeuge" });
      expect(await inspector.textContent()).toContain("Bild 1 von 4");
    } finally {
      await page.close();
    }
  }
}, 30_000);

test("the photo editor's panels say each word once", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url.href}?screen=image-open`);
    const inspector = page.getByRole("region", { name: "Bildwerkzeuge" });
    await inspector.waitFor();
    for (const tab of ["Bearbeiten", "Markieren"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      // the visible words of headings and buttons in the panel; icon buttons have their own names
      const words = await inspector.evaluate((panel) =>
        [...panel.querySelectorAll("h3, button")].map((element) => element.textContent?.trim() ?? "").filter(Boolean),
      );
      expect({ tab, duplicates: words.filter((word, index) => words.indexOf(word) !== index) }).toEqual({ tab, duplicates: [] });
    }
  } finally {
    await page.close();
  }
}, 30_000);
