import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { buildHarness } from "./tools/image-intake/browser-harness";

// Every Tools screen on v2 at 1440, 1024 and 390 px: no outline problem, no layout problem, no loader in the first
// picture, no page error. CLOUD_TOOLS_SHOTS=<dir> keeps a light screenshot and the outline of each.
const SCREENS = ["catalog", "password", "uuid", "lorem", "hash", "encoding", "color", "mailto", "encryption", "qr"];
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
  // the page's fonts as Cloud serves them (fonts.css: IBM Plex), the Latin faces inlined so the page needs no more files
  const plexUrl = import.meta.resolve("@k2b/ui/fonts/plex.css");
  let fontsCss = (await Bun.file(fileURLToPath(plexUrl)).text()).replace(/@font-face\{[^}]*\}/g, (face) =>
    face.includes("plex") && !face.includes("-latin-") ? "" : face,
  );
  for (const match of new Set(fontsCss.match(/\.\/[^)"'?]+\.woff2(?:\?[^)"']*)?/g) ?? [])) {
    const file = fileURLToPath(new URL(match.replace(/\?.*$/, ""), plexUrl));
    fontsCss = fontsCss.replaceAll(match, `data:font/woff2;base64,${Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")}`);
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/fonts.css") return new Response(fontsCss, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.css") return new Response(icons.css, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(icons.font));
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

// One block from the top: a tool page is one pane with its result and its options one under the other, the fields at
// the reading measure. A column of options beside a short result left the rest of the page white (review 27.11.).
const ONE_BLOCK = ["password", "uuid", "lorem", "hash", "encoding", "color", "mailto", "encryption"];
test("a tool page is one block: one pane, its fields at the reading measure", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    for (const name of ONE_BLOCK) {
      await page.goto(`${server.url.href}?screen=${name}`);
      await page.locator('[data-k2-part="Workspace"]').waitFor();
      const found = await page.evaluate(() => {
        const fields = [...document.querySelectorAll('[data-k2-part="Pane"] .k2-field')];
        return {
          panes: document.querySelectorAll('[data-k2-part="Pane"]').length,
          fields: fields.length > 0,
          // 720 px of text between the two text edges of 20 px
          measured: fields.every((field) => field.getBoundingClientRect().width <= 760),
        };
      });
      expect({ name, ...found }).toEqual({ name, panes: 1, fields: true, measured: true });
    }
  } finally {
    await page.close();
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
      // the length is a slider over 8–64: End takes it to the longest
      const length = page.getByRole("slider", { name: /Zeichen/ });
      await length.press("End");
      // the thumb is a native range field: its value, or the ARIA value where it carries one
      await page.waitForFunction(
        (thumb) => (thumb as HTMLInputElement).value === "64" || thumb?.getAttribute("aria-valuenow") === "64",
        await length.elementHandle(),
      );
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

// The deeds of the rebuilt tools, end to end in the browser (review round 1).
const tool = async (screen: string, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, acceptDownloads: true });
  await page.goto(`${server.url.href}?screen=${screen}`);
  await page.locator('[data-k2-part="Workspace"]').waitFor();
  return page;
};
const factValue = (page: Page, label: string) =>
  page.locator('[data-k2-part="Facts"]').getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]").first();

test("encrypting and decrypting with the same key gives the text back", async () => {
  const page = await tool("encryption");
  try {
    await page.getByRole("textbox", { name: "Inhalt" }).fill("Zugang Werkstatt: 4711");
    await page.getByLabel("Schlüssel / Passwort").fill("korrekt Pferd Batterie");
    await page.getByRole("button", { name: "Verschlüsseln", exact: true }).click();
    const output = factValue(page, "Ausgabe");
    await page.waitForFunction(() => document.querySelector('[data-k2-part="Facts"]')?.textContent?.includes("–") === false);
    const sealed = (await output.textContent())?.trim() ?? "";
    expect(sealed.length).toBeGreaterThan(20);
    expect(sealed).not.toContain("Zugang");
    await page.getByRole("textbox", { name: "Inhalt" }).fill(sealed);
    await page.getByRole("button", { name: "Entschlüsseln", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-k2-part="Facts"]')?.textContent?.includes("Zugang Werkstatt: 4711"));
  } finally {
    await page.close();
  }
}, 60_000);

test("the password modes give their kind: words joined by dashes, a PIN of digits", async () => {
  const page = await tool("password");
  try {
    const drawn = () => page.locator('[data-k2-part="Canvas"]').first().innerText();
    await page.getByText("Merkbar", { exact: true }).click();
    await page.waitForFunction(() =>
      /^[A-Za-z]+(-[A-Za-z]+){3}$/.test(document.querySelector('[data-k2-part="Canvas"]')?.textContent?.trim() ?? ""),
    );
    await page.getByText("PIN", { exact: true }).click();
    await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('[data-k2-part="Canvas"]')?.textContent?.trim() ?? ""));
    expect((await drawn()).trim()).toMatch(/^\d{6}$/);
  } finally {
    await page.close();
  }
}, 60_000);

test("a 20-sign password stays on one line on a phone", async () => {
  const page = await tool("password", 390);
  try {
    await page.waitForFunction(() => (document.querySelector('[data-k2-part="Canvas"] span')?.textContent?.length ?? 0) === 20);
    // the signs stand on one line: their tops are all the same
    const tops = await page
      .locator('[data-k2-part="Canvas"] > div > span')
      .first()
      .evaluate((span) => [...new Set([...span.children].map((sign) => Math.round(sign.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    // the drawing sets exactly the v2 mono family (a shorthand that fails falls back to the inherited family)
    const family = await page
      .locator('[data-k2-part="Canvas"] > div > span')
      .first()
      .evaluate((span) => ({
        used: getComputedStyle(span).fontFamily,
        token: getComputedStyle(span).getPropertyValue("--k2-font-mono").trim(),
      }));
    expect(family.used).toBe(family.token);
  } finally {
    await page.close();
  }
}, 60_000);

test("a colour typed as HEX turns up as RGB and HSL", async () => {
  const page = await tool("color");
  try {
    const hex = page.getByLabel("HEX");
    await hex.fill("#ff0000");
    expect(await page.getByLabel("RGB").inputValue()).toBe("255, 0, 0");
    expect(await page.getByLabel("HSL").inputValue()).toBe("0, 100%, 50%");
  } finally {
    await page.close();
  }
}, 60_000);

test("the mail link carries recipient, copies and subject", async () => {
  const page = await tool("mailto");
  try {
    await page.getByRole("textbox", { name: "An", exact: true }).fill("ada@example.org");
    // the field's name carries its "optional" too; "begins with CC" leaves BCC out
    const cc = page
      .getByRole("textbox", { name: /^CC/ })
      .or(page.getByRole("combobox", { name: /^CC/ }))
      .first();
    await cc.fill("jo@example.org");
    await cc.press("Enter");
    await page.getByRole("textbox", { name: /^Betreff/ }).fill("Angebot 2026");
    await page.waitForFunction(() => document.querySelector('[data-k2-part="Facts"]')?.textContent?.includes("mailto:ada%40example.org"));
    const link = (await factValue(page, "Mailto-Link").textContent()) ?? "";
    // the recipient is percent-encoded, as in v1 (encodeURIComponent)
    expect(link).toContain("mailto:ada%40example.org?");
    expect(link).toContain("cc=jo%40example.org");
    expect(link).toContain("subject=Angebot%202026");
  } finally {
    await page.close();
  }
}, 60_000);

test("a QR code downloads as SVG, and an event with an unreadable start says so and makes none", async () => {
  const page = await tool("qr");
  try {
    await page.getByLabel("Link oder Text").fill("https://example.org/kontakt");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "SVG herunterladen" }).first().click();
    expect((await download).suggestedFilename()).toMatch(/\.svg$/);
    await page.getByRole("combobox", { name: "Inhaltstyp" }).click();
    await page.getByRole("option", { name: "Kalendertermin" }).click();
    await page.getByLabel("Termintitel").fill("Wartung");
    await page.getByLabel(/^Beginn/).fill("morgen früh");
    await page.getByText("Datum und Uhrzeit, z. B. 15.06.2026 14:30").first().waitFor();
    expect(await page.getByRole("button", { name: "SVG herunterladen" }).first().isDisabled()).toBe(true);
    await page.getByLabel(/^Beginn/).fill("15.06.2026 14:30");
    await page.waitForFunction(() => !document.body.textContent?.includes("Datum und Uhrzeit, z. B."));
    expect(await page.getByRole("button", { name: "SVG herunterladen" }).first().isDisabled()).toBe(false);
  } finally {
    await page.close();
  }
}, 60_000);

test("six presses on the length leave the history as it was, and Neu keeps the password it leaves", async () => {
  const page = await tool("password");
  try {
    await page.waitForFunction(() => (document.querySelector('[data-k2-part="Canvas"] span')?.textContent?.length ?? 0) === 20);
    const length = page.getByRole("slider", { name: /Zeichen/ });
    for (let press = 0; press < 6; press++) await length.press("ArrowRight");
    await page.waitForFunction(() => (document.querySelector('[data-k2-part="Canvas"] span')?.textContent?.length ?? 0) === 26);
    expect(await page.getByRole("region", { name: "Zuvor erzeugt" }).count()).toBe(0);
    const left = (await page.locator('[data-k2-part="Canvas"] > div > span').first().textContent()) ?? "";
    await page.getByRole("button", { name: "Passwort neu generieren" }).click();
    const history = page.getByRole("region", { name: "Zuvor erzeugt" });
    await history.waitFor();
    expect(await history.locator('[data-k2-part="Facts"]').textContent()).toContain(left);
  } finally {
    await page.close();
  }
}, 60_000);

test("a Wi-Fi password stands masked in the QR content", async () => {
  const page = await tool("qr");
  try {
    await page.getByRole("combobox", { name: "Inhaltstyp" }).click();
    await page.getByRole("option", { name: "WLAN-Netzwerk" }).click();
    await page.getByRole("textbox", { name: /^Netzwerkname/ }).fill("Werkstatt");
    await page
      .getByLabel(/^Passwort/)
      .first()
      .fill("geheim-4711");
    await page.waitForFunction(() => document.querySelector('[data-k2-part="Facts"]')?.textContent?.includes("Werkstatt"));
    const shown = (await page.locator('[data-k2-part="Facts"]').first().textContent()) ?? "";
    expect(shown).toContain("••••••••");
    expect(shown).not.toContain("geheim-4711");
  } finally {
    await page.close();
  }
}, 60_000);

test("an event whose end lies before its start says so and makes no code", async () => {
  const page = await tool("qr");
  try {
    await page.getByRole("combobox", { name: "Inhaltstyp" }).click();
    await page.getByRole("option", { name: "Kalendertermin" }).click();
    await page.getByLabel("Termintitel").fill("Wartung");
    await page.getByLabel(/^Beginn/).fill("15.06.2026 14:30");
    await page.getByLabel(/^Ende/).fill("15.06.2026 10:00");
    await page.getByText("Das Ende liegt vor dem Beginn").first().waitFor();
    expect(await page.getByRole("button", { name: "SVG herunterladen" }).first().isDisabled()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

test("the event's start opens a calendar with its time", async () => {
  const page = await tool("qr");
  try {
    await page.getByRole("combobox", { name: "Inhaltstyp" }).click();
    await page.getByRole("option", { name: "Kalendertermin" }).click();
    await page.getByRole("button", { name: "Im Kalender wählen" }).first().click();
    await page.getByRole("grid").first().waitFor();
    // the time of the moment is part of the picker (hour and minute as spinbuttons)
    expect(await page.getByRole("spinbutton").count()).toBeGreaterThanOrEqual(2);
  } finally {
    await page.close();
  }
}, 60_000);
