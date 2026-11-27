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
  "document-markdown",
  "document-result",
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
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.css") return new Response(icons.css, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(icons.font));
      if (url.pathname === "/entry.js")
        return new Response(harness, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tabler-icons.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><div id="app" class="k2-ui" style="display:flex;height:100%"></div><script src="/entry.js"></script></body></html>`,
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
  // a part that runs past the window's right edge is cut there: measureV2Layout let a reading column at 1024 px pass
  const beyond = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-k2-part]")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .map((element) => `${element.dataset.k2Part} runs past the window's edge`),
  );
  return { loaders, problems: outline.includes("Problems") ? outline : null, layout: [...layout.problems, ...new Set(beyond)] };
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

// break-ui: the realistic worst cases through the harness address (the same props the server passes), never a switch
// in the product. A long task typed into the search, a search with exactly one hit, the English catalog, and the
// longest password the generator allows with symbols. Each holds at 390 and 1440 px without sideways scrolling.
const worstCases: { name: string; query: string; act?: (page: Page) => Promise<void>; expect?: (page: Page) => Promise<void> }[] = [
  {
    name: "worst-search-long",
    query: "screen=catalog&q=" + encodeURIComponent("Rechnung als PDF mit eigenem Briefkopf und Fußzeile erstellen"),
  },
  {
    name: "worst-search-one",
    query: "screen=catalog&q=uuid",
    expect: async (page) => void (await page.getByText("1 passendes Werkzeug", { exact: true }).waitFor()),
  },
  { name: "worst-catalog-en", query: "screen=catalog&locale=en" },
  {
    name: "worst-password-64",
    query: "screen=password",
    act: async (page) => {
      await page
        .getByRole("spinbutton", { name: /Zeichen/ })
        .or(page.getByRole("textbox", { name: /Zeichen/ }))
        .first()
        .fill("64");
      // the switch draws its own mark over its input: press its words, as a person does
      await page.getByText("Symbole", { exact: true }).click();
      await page.getByRole("switch", { name: "Symbole" }).and(page.locator(":checked")).waitFor({ state: "attached" });
    },
    // the whole password stands in its drawing: nothing cut at its edge, nothing to scroll
    expect: async (page) => {
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-k2-part="Canvas"] > div');
        return element !== null && element.textContent?.length === 64 && element.scrollHeight <= element.clientHeight;
      });
    },
  },
];
for (const worst of worstCases)
  test(`break-ui: ${worst.name} holds at 390 and 1440 px`, async () => {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } });
      try {
        const errors = pageErrors(page);
        await page.goto(`${server.url.href}?${worst.query}`);
        await page.locator('[data-k2-part="Workspace"]').waitFor();
        await worst.act?.(page);
        await worst.expect?.(page);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect({ width, errors, sideways, ...(await check(page, worst.name, width)) }).toEqual({
          width,
          errors: [],
          sideways: false,
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
