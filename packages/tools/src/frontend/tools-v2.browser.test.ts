import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { buildHarness } from "./tools/image-intake/browser-harness";

// Every Tools screen on v2 at 1440, 1024 and 390 px: no outline problem, no layout problem, no loader in the first
// picture, no page error. CLOUD_TOOLS_SHOTS=<dir> keeps a light screenshot and the outline of each.
const SCREENS = ["catalog", "password", "uuid", "lorem", "hash", "encoding", "color", "mailto", "encryption", "qr", "speedtest"];
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
const lead = (page: Page) => page.locator('[data-k2-part="StatusRow"] .k2-status-lead').first().textContent();
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
    expect(await lead(page)).toBe("3 Anfragen");
    expect(await page.locator('[data-k2-part="FilterBar"]').textContent()).toContain("GET");
    const search = page.getByRole("searchbox", { name: "Anfragen durchsuchen" });
    await search.fill("deploy");
    await search.press("Enter");
    await page.getByText("Keine Anfrage passt zu diesen Filtern.").waitFor();
    expect(new URL(page.url()).searchParams.get("q")).toBe("deploy");
    expect(new URL(page.url()).searchParams.get("method")).toBe("GET");
    await page.getByRole("link", { name: "Filter zurücksetzen" }).click();
    await page.waitForURL((url) => !url.searchParams.has("q") && !url.searchParams.has("method"));
    await page.waitForFunction(() => document.querySelector('[data-k2-part="StatusRow"] .k2-status-lead')?.textContent === "24 Anfragen");
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
      expect(await lead(page)).toBe("6 Anfragen");
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
    await page.getByText("Die Anfragen konnten nicht geladen werden.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.getByText("Die Anfragen konnten nicht geladen werden.", { exact: false }).waitFor();
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
    expect(await lead(page)).toBe("1.000 Anfragen");
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
