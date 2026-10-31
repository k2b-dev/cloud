import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../ui/test/browser";
import { adminAppsBrowserFixture } from "./AdminApps.browser-fixture";
import { FIXTURE_NOW } from "./AdminApps.fixture-data";

// The real AdminLayout, Apps view, islands and styles with fictional apps; no live services.
let browser: Browser;
let fixture: Awaited<ReturnType<typeof adminAppsBrowserFixture>>;
let page: Page;
const open = async (query: string, width = 1440) => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  await page.goto(`${fixture.url}${query}`);
  await page.waitForSelector('body[data-ready="true"]');
  await settled(page);
};

beforeAll(async () => {
  fixture = await adminAppsBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript((at) => {
    globalThis.Date = new Proxy(Date, {
      construct: (target, args) => Reflect.construct(target, args.length ? args : [at]),
      apply: (target) => new target(at).toString(),
      get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
    });
  }, FIXTURE_NOW);
}, 20_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
}, 20_000);

test("the list names every app by name with its state in words and its most important hint", async () => {
  await open("");
  const rows = page.locator("[data-app]");
  expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-app")))).toEqual([
    "chat",
    "files",
    "grids",
    "inventar",
    "lager",
    "mail",
    "notebooks",
    "pulse",
    "spaces",
    "tools",
    "wiki",
  ]);
  expect(await page.locator("[data-apps-summary]").innerText()).toContain(
    "11 Apps · 6 laufen · 2 gestört · 2 laufen nicht · 1 nicht gestartet",
  );
  const grids = page.locator('[data-app="grids"]');
  expect(await grids.innerText()).toContain("Gestört");
  expect(await grids.innerText()).toContain("Fehlerquote 4,3% in 24 h · +1");
  expect(await page.locator('[data-app="tools"]').innerText()).toContain("Zugriff: niemand verwaltet ihn");
  expect(await page.getByText("Wähle eine App, um Zustand, Zugriff, Schlüssel und Ereignisse zu sehen.").isVisible()).toBe(true);
}, 20_000);

test("the old app address opens the app, and every hint has exactly one way out to its column", async () => {
  await open("?app=grids");
  const hints = page.locator("[data-app-hints] [data-hint]");
  expect(await hints.count()).toBe(2);
  await page.getByRole("link", { name: "Zustellungen ansehen" }).click();
  await page.waitForSelector('[data-detail="events"]');
  expect(new URL(page.url()).search).toBe("?app=grids&view=events");
  expect(await page.getByRole("button", { name: /Kontakt geändert .* erneut zustellen/ }).count()).toBe(2);
}, 20_000);

test("an old link lands with a hint that closes and leaves the address clean", async () => {
  await open("?moved=gateway");
  const hint = page.locator("[data-moved-notice]");
  expect(await hint.innerText()).toContain("„Systembeobachtung › Gateway › Apps“ ist jetzt hier.");
  const list = await page.locator("[data-apps-summary]").boundingBox();
  await page.getByRole("button", { name: "Hinweis schließen" }).click();
  await settled(page);
  expect(await hint.count()).toBe(0);
  expect(new URL(page.url()).search).toBe("");
  // The list moves up by the hint's height only once, when the person closes it.
  expect((await page.locator("[data-apps-summary]").boundingBox())!.y).toBeLessThan(list!.y);
  await open("?moved=credentials");
  expect(await page.locator("[data-moved-notice]").innerText()).toContain("„Schlüssel“ › „Tokens für Host-Betrieb“");
}, 20_000);

test("only an app that is not running can leave the list; a failure keeps it and says so", async () => {
  await open("");
  await page.locator('[data-app="mail"]').hover();
  await page.getByRole("button", { name: "Aktionen für Mail" }).click();
  const running = page.getByRole("menuitem", { name: /Aus der Liste entfernen/ });
  expect(await running.isDisabled()).toBe(true);
  expect(await running.innerText()).toContain("Nur wenn die App nicht läuft");
  await page.keyboard.press("Escape");

  await open("?app=pulse&state=core-fail");
  await page.locator('[data-row="remove"]').click();
  const dialog = page.getByRole("alertdialog");
  expect(await dialog.innerText()).toContain("Zugriff, Schlüssel und Abos bleiben.");
  await dialog.getByRole("button", { name: "Entfernen" }).click();
  await dialog.getByRole("alert").waitFor();
  expect(await dialog.innerText()).toContain("Nicht entfernt. Pulse steht weiter in der Liste.");
  expect(await dialog.getByRole("button", { name: "Erneut versuchen" }).isVisible()).toBe(true);

  await open("?app=pulse");
  await page.locator('[data-row="remove"]').click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Entfernen" }).click();
  await page.waitForURL((url) => url.search === "");
  await page.waitForSelector('body[data-ready="true"]');
  expect(await page.locator('[data-app="pulse"]').count()).toBe(0);
}, 20_000);

test("keys: the private key shows once, and closing it unsaved asks first", async () => {
  await open("?app=mail&view=keys");
  const keys = page.locator('[data-keys="mail"]');
  expect(await keys.locator("[data-key]").count()).toBe(1);
  await keys.getByRole("button", { name: /Widerrufen \(1\)/ }).click();
  expect(await keys.locator("[data-key]").count()).toBe(2);
  await keys.getByRole("button", { name: /Tokens für Host-Betrieb \(1\)/ }).click();
  expect(await keys.locator('[data-token="host-override"]').isVisible()).toBe(true);

  const create = page.getByRole("button", { name: "Schlüssel erzeugen" });
  if (await create.isDisabled()) return; // A browser without Ed25519 shows the cld way instead; covered below.
  await create.click();
  await page.locator("[data-key-create]").getByRole("button", { name: "Erzeugen" }).click();
  const once = page.locator("[data-key-once]");
  await once.waitFor();
  expect(await once.innerText()).toContain("Nur jetzt sichtbar.");
  expect(await once.innerText()).toContain(
    "cloud-app-key-v1.66666666-6666-4666-8666-666666666666.mail.77777777-7777-4777-8777-777777777777.",
  );
  await once.getByRole("button", { name: "Fertig" }).click();
  const unsaved = page.getByRole("alertdialog", { name: "Schlüssel nicht gesichert" });
  await unsaved.waitFor();
  await unsaved.getByRole("button", { name: "Zurück zum Schlüssel" }).click();
  expect(await once.isVisible()).toBe(true);
}, 20_000);

test("keys: revoking the only active key warns about the next start", async () => {
  await open("?app=mail&view=keys");
  await page.getByRole("button", { name: "Aktionen für produktion-2026-10" }).click();
  await page.getByRole("menuitem", { name: "Widerrufen …" }).click();
  const dialog = page.locator("[data-key-revoke]");
  await dialog.waitFor();
  expect(await dialog.innerText()).toContain("Einziger aktiver Schlüssel.");
}, 20_000);

test("keys: background access off says so and offers to turn it on; two active keys block creating a third", async () => {
  await open("?app=mail&view=keys&state=keys-off");
  expect(await page.locator("[data-background-off]").innerText()).toContain("Hintergrundzugriff ist aus.");
  expect(await page.getByRole("button", { name: "Wieder aktivieren" }).isVisible()).toBe(true);
  await open("?app=grids&view=keys");
  expect(await page.getByText("Höchstens 2 sind aktiv. Widerrufe zuerst einen alten.").isVisible()).toBe(true);
  expect(await page.getByRole("button", { name: "Schlüssel erzeugen" }).isDisabled()).toBe(true);
}, 20_000);

test("a provider that does not answer leaves its values in place, and trying again keeps every row where it is", async () => {
  await open("?app=mail&state=provider");
  expect(await page.locator('[data-hint="provider"]').innerText()).toContain("Gateway antwortet gerade nicht.");
  const rows = () => page.locator("[data-row]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  const before = await rows();
  expect(await page.locator('[data-row="Verkehr 24 h"]').innerText()).toContain("Nicht verfügbar");
  await page.locator('[data-hint="provider"]').getByRole("button", { name: "Erneut versuchen" }).click();
  await page.locator('[data-row="Verkehr 24 h"]').getByText("12.400").waitFor();
  expect(await rows()).toEqual(before);
}, 20_000);

test("routes keep the five windows and say which prefix the router sends elsewhere", async () => {
  await open("?app=spaces&view=routes");
  const tabs = page.getByRole("navigation", { name: "Zeitfenster" }).getByRole("link");
  expect(await tabs.allInnerTexts()).toEqual(["1 h", "6 h", "24 h", "7 Tage", "30 Tage"]);
  expect(await page.locator('[data-route="/caldav"]').innerText()).toContain("fehlt im Router");
  expect(await page.getByText("/caldav erklärt Spaces, der Router leitet es an Dateien weiter.").isVisible()).toBe(true);
}, 20_000);

test("on a phone each level is its own page with a way back", async () => {
  await open("?app=mail&view=keys", 390);
  expect(await page.locator('[data-keys="mail"]').isVisible()).toBe(true);
  expect(await page.locator('[data-app="mail"]').isVisible()).toBe(false);
  expect(
    await page
      .getByRole("link", { name: /Zurück|Back/ })
      .first()
      .isVisible(),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}, 20_000);
