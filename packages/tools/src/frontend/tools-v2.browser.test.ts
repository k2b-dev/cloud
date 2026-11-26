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
  "speedtest",
  "image-converter",
  "image",
  "image-one",
  "image-open",
  "image-markup",
  "image-worst",
  "document-markdown",
  "markdown-pdf",
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

// The webhook tester at its own addresses: received, sent, a request open, and its fixtures (empty, failed, huge,
// worst case). The first fixture name per page starts a fresh session, so each address names its own.
const WEBHOOKS: Record<string, string> = {
  webhooks: "/tools/webhooks?fixture=normal",
  "webhooks-send": "/tools/webhooks?mode=send&fixture=normal",
  "webhooks-open": "/tools/webhooks?fixture=normal&request=10000000-0000-4000-8000-000000000001",
  "webhooks-sent-open": "/tools/webhooks?mode=send&fixture=normal&request=20000000-0000-4000-8000-000000000002",
  "webhooks-filtered": "/tools/webhooks?fixture=normal&method=GET&q=zzz",
  "webhooks-empty": "/tools/webhooks?fixture=empty",
  "webhooks-failed": "/tools/webhooks?fixture=error",
  "webhooks-worst": "/tools/webhooks?fixture=worst&request=10000000-0000-4000-8000-000000000001",
};

for (const [name, address] of Object.entries(WEBHOOKS))
  test(`the webhook tester "${name}" holds its v2 shape at 1440, 1024 and 390 px`, async () => {
    for (const width of [1440, 1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const errors = pageErrors(page);
        await page.goto(new URL(address, server.url).href);
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

// ── Webhook tester: the main paths on the invented fixture ──

const webhooks = (page: Page, address: string) => page.goto(new URL(address, server.url).href);
// the head of the requests: their count and the statement of what matters now
const status = (page: Page) => page.locator('[data-k2-part="Section"][aria-label="Anfragen"]').first().textContent();
const FIRST_REQUEST = "10000000-0000-4000-8000-000000000001";

test("a request opens beside the list in place, stays in the address through back and reload, and closes", async () => {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const errors = pageErrors(page);
      await webhooks(page, "/tools/webhooks?fixture=normal");
      await page.locator(`a[href*="request=${FIRST_REQUEST}"]:visible`).first().click();
      await page.getByText("Eingehende Anfrage", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("request")).toBe(FIRST_REQUEST);
      expect(await page.getByText("payment_intent.succeeded", { exact: true }).count()).toBe(1);
      // a reload shows the same request: the address holds it
      await page.reload();
      await page.getByText("Eingehende Anfrage", { exact: true }).waitFor();
      if (width > 768) await page.getByRole("link", { name: "Schließen" }).click();
      else await page.getByRole("link", { name: "Anfragen" }).click();
      await page.getByText("Eingehende Anfrage", { exact: true }).waitFor({ state: "detached" });
      expect(new URL(page.url()).searchParams.has("request")).toBe(false);
      await page.goBack();
      await page.getByText("Eingehende Anfrage", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("request")).toBe(FIRST_REQUEST);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a filter from the address and the search narrow the requests, and an empty result offers the reset", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await webhooks(page, "/tools/webhooks?fixture=normal&method=GET");
    expect(await status(page)).toContain("Letzte Anfrage heute, 10:17");
    expect(await status(page)).toContain("3 Anfragen");
    expect(await page.locator('[data-k2-part="FilterBar"]').textContent()).toContain("GET");
    const search = page.getByRole("searchbox", { name: "Anfragen durchsuchen" });
    await search.fill("deploy");
    await search.press("Enter");
    await page.getByText("Keine Anfrage passt zu diesen Filtern.").waitFor();
    expect(new URL(page.url()).searchParams.get("q")).toBe("deploy");
    expect(new URL(page.url()).searchParams.get("method")).toBe("GET");
    await page.getByRole("link", { name: "Filter zurücksetzen" }).click();
    await page.waitForURL((url) => !url.searchParams.has("q") && !url.searchParams.has("method"));
    await page.waitForFunction(() =>
      document.querySelector('[data-k2-part="Section"][aria-label="Anfragen"]')?.textContent?.includes("24 Anfragen"),
    );
    // a press on an endpoint shows its requests, in the address
    await page.getByRole("link", { name: "Shopify Bestellungen" }).first().click();
    await page.waitForURL((url) => url.searchParams.get("endpoint") === "00000000-0000-4000-8000-000000000002");
    await page.waitForFunction(() =>
      document.querySelector('[data-k2-part="Section"][aria-label="Anfragen"]')?.textContent?.includes("7 Anfragen"),
    );
  } finally {
    await page.close();
  }
}, 30_000);

test("back and forward undo a search and an endpoint press, and the list follows the address", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shows = (count: string) =>
    page.waitForFunction(
      (text) => document.querySelector('[data-k2-part="Section"][aria-label="Anfragen"]')?.textContent?.includes(text),
      count,
    );
  try {
    await webhooks(page, "/tools/webhooks?fixture=normal");
    await shows("24 Anfragen");
    const search = page.getByRole("searchbox", { name: "Anfragen durchsuchen" });
    await search.fill("deploy");
    await search.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("q") === "deploy");
    await page.getByRole("link", { name: "Shopify Bestellungen" }).first().click();
    await page.waitForURL((url) => url.searchParams.get("endpoint") === "00000000-0000-4000-8000-000000000002");
    await page.goBack();
    await page.waitForURL((url) => !url.searchParams.has("endpoint") && url.searchParams.get("q") === "deploy");
    await page.goBack();
    await page.waitForURL((url) => !url.searchParams.has("q"));
    await shows("24 Anfragen");
    expect(await search.inputValue()).toBe("");
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("q") === "deploy");
    expect(await search.inputValue()).toBe("deploy");
    expect(await status(page)).not.toContain("24 Anfragen");
  } finally {
    await page.close();
  }
}, 30_000);

test("an endpoint is created in a dialog and deleted after a question", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await webhooks(page, "/tools/webhooks?fixture=normal");
    await page.getByRole("button", { name: "Endpunkt", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Neuer Endpunkt" });
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Gib einen Namen ein.").waitFor();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Mollie Test");
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.getByText("Endpunkt erstellt", { exact: true }).waitFor();
    await page.getByText("Mollie Test", { exact: true }).waitFor();
    expect(await page.getByText("https://cloud.example.test/tools/api/webhooks/receive/wh_new1", { exact: true }).count()).toBe(1);

    await page.getByRole("button", { name: "Aktionen für Paperless Eingang" }).click();
    await page.getByRole("menuitem", { name: "Endpunkt Paperless Eingang löschen" }).click();
    const question = page.getByRole("alertdialog", { name: "Paperless Eingang löschen?" });
    await question.getByRole("button", { name: "Löschen" }).click();
    await page.getByText("Endpunkt gelöscht", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Aktionen für Paperless Eingang" }).waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 30_000);

test("a request is sent from its dialog, the form names what is wrong, and the answer opens beside the list", async () => {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await webhooks(page, "/tools/webhooks?mode=send&fixture=normal");
      expect(await status(page)).toContain("3 Antworten mit Fehler");
      expect(await status(page)).toContain("6 Anfragen");
      await page.getByRole("button", { name: "Anfrage senden" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Anfrage senden" });
      await dialog.getByRole("button", { name: "Senden" }).click();
      await dialog.getByText("Gib die Adresse ein, die aufgerufen wird.").waitFor();
      await dialog.getByRole("textbox", { name: "Ziel-URL" }).fill("https://hooks.example.test/neu?x=1");
      await dialog.getByRole("textbox", { name: "Header" }).fill("{");
      await dialog.getByRole("button", { name: "Senden" }).click();
      await dialog.getByText("Header müssen ein JSON-Objekt sein.").waitFor();
      await dialog.getByRole("textbox", { name: "Header" }).fill('{ "x-test": "1" }');
      await dialog.getByRole("button", { name: "Senden" }).click();
      await page.getByText("Anfrage gesendet", { exact: true }).waitFor();
      await page.getByText("Ausgehende Anfrage", { exact: true }).last().waitFor();
      expect(new URL(page.url()).searchParams.get("mode")).toBe("send");
      expect(new URL(page.url()).searchParams.get("request")).toMatch(/^40000000-/);
      expect(await page.getByText("https://hooks.example.test/neu?x=1", { exact: true }).count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a list that cannot be read says so in place and offers to try again", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await webhooks(page, "/tools/webhooks?fixture=error");
    // both reads failed: one statement, one way to try again; no offer to create a first endpoint
    await page.getByText("Endpunkte und Anfragen konnten nicht geladen werden.", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
    expect(await page.getByText("Noch kein Endpunkt.", { exact: false }).count()).toBe(0);
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.getByText("Endpunkte und Anfragen konnten nicht geladen werden.", { exact: false }).waitFor();
  } finally {
    await page.close();
  }
}, 30_000);

test("1,000 received requests are ready quickly and never scroll the page sideways", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const started = performance.now();
    await webhooks(page, "/tools/webhooks?fixture=huge");
    await page.locator('[data-k2-part="Table"]').waitFor();
    const ready = performance.now() - started;
    expect(await status(page)).toContain("1.000 Anfragen");
    const nodes = await page.locator("#app *").count();
    const rows = await page.locator('[data-k2-part="Table"] tbody tr').count();
    if (shots) await Bun.write(resolve(shots, "webhooks-huge.txt"), `ready ${Math.round(ready)} ms\nnodes ${nodes}\nrows ${rows}\n`);
    expect(ready).toBeLessThan(1_500);
    // only the rows in view (and a margin) are in the page, however long the log is
    expect(rows).toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);

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

// ── Documents: the main paths against an answering API ──

test("a chosen document converts to Markdown, and a refused one says why at the place", async () => {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      let refuse = false;
      await page.route("**/tools/api/documents/markdown", (route) =>
        refuse
          ? route.fulfill({ status: 422, json: { message: "Das PDF enthält keinen lesbaren Text." } })
          : route.fulfill({
              json: {
                filename: "angebot-1047.docx",
                format: "docx",
                markdown: "# Angebot 1047\n\n- Küchenfront Eiche",
                inputBytes: 18_432,
                outputBytes: 42,
                truncated: false,
              },
            }),
      );
      await page.goto(`${server.url.href}?screen=document-markdown`);
      const choose = async () => {
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Dokument wählen" }).first().click();
        await (await chooser).setFiles({ name: "angebot-1047.docx", mimeType: "application/octet-stream", buffer: Buffer.from("fixture") });
      };
      await choose();
      // one head row: the converted document is the last step of the path, no status row under the head
      // (on the phone the path gives way to the shell's bar, so it is only attached there)
      await page
        .locator('[data-k2-part="Path"]')
        .getByText("angebot-1047.docx")
        .waitFor({ state: width > 768 ? "visible" : "attached" });
      expect(await page.locator('[data-k2-part="StatusRow"]').count()).toBe(0);
      expect(await page.getByRole("group", { name: "Reines Markdown, extrahiert aus angebot-1047.docx" }).textContent()).toContain(
        "# Angebot 1047",
      );
      refuse = true;
      await choose();
      await page.getByText("Das PDF enthält keinen lesbaren Text.").waitFor();
      expect(await page.locator('[data-k2-part="Notice"]').textContent()).toContain("Konvertierung fehlgeschlagen");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("Markdown becomes a PDF in the preview, and a change marks it stale", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route("**/tools/api/markdown/pdf", (route) =>
      route.fulfill({ contentType: "application/pdf", body: Buffer.from("%PDF-1.4\n%fixture\n") }),
    );
    await page.goto(`${server.url.href}?screen=markdown-pdf`);
    await page.getByRole("textbox", { name: "Markdown" }).fill("# Angebot 1047\n\nKüchenfront Eiche, 2 Stück");
    await page.getByRole("button", { name: "PDF erstellen" }).first().click();
    await page.getByText("PDF erstellt.").waitFor();
    expect(await page.locator('iframe[title="Vorschau des erstellten PDFs"]').count()).toBe(1);
    expect(await page.getByRole("button", { name: "PDF herunterladen" }).isEnabled()).toBe(true);
    await page.getByRole("textbox", { name: "Markdown" }).fill("# Angebot 1048");
    await page.getByText("Erstelle das PDF erneut, damit es deine letzten Änderungen enthält.").waitFor();
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
