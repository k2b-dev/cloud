import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../ui/test/browser";
import { adminAppsBrowserFixture } from "./AdminApps.browser-fixture";
import { FIXTURE_NOW } from "./AdminApps.fixture-data";

// The real AdminLayout, the v2 Apps screen and styles with fictional apps; no live services. Keys, domains and access
// are still the v1 parts inside the record (rebuilt next); their tests stay as they were.
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
/** The list's row of one app: the table row around its name link. */
const row = (name: string) => page.locator("main tbody tr").filter({ has: page.getByRole("link", { name: new RegExp(`^${name}`) }) });
/** A fact of the open app: a row of the detail beside the list whose quiet second line is its label. */
const fact = (label: string) => page.locator('main [data-k2-part="Pane"][data-detail] [data-k2-part="Row"]').filter({ hasText: label });
const notice = (text: string | RegExp) => page.locator('main [data-k2-part="Notice"]').filter({ hasText: text });

afterAll(async () => {
  await browser?.close();
  fixture?.close();
}, 20_000);

test("the list names every app with its state in words and its most important hint, and keeps the v2 rules", async () => {
  await open("");
  const names = await page
    .locator("main tbody tr")
    .evaluateAll((rows) => rows.map((row) => row.querySelector("a")?.textContent?.trim() ?? ""));
  expect(names.length).toBe(11);
  expect(await page.locator('main [data-k2-part="StatusRow"]').innerText()).toContain(
    "11 Apps · 6 laufen · 2 gestört · 2 laufen nicht · 1 nicht gestartet",
  );
  expect(await row("Grids").innerText()).toContain("Gestört");
  expect(await row("Grids").innerText()).toContain("Fehlerquote 4,3% in 24 h · +2");
  for (const width of [1440, 1024, 390]) {
    await open("?app=grids", width);
    expect({ width, problems: (await measureV2Layout(page, { root: "main.k2-ui", skip: ".k2b-field" })).problems }).toEqual({
      width,
      problems: [],
    });
    expect(await page.locator('main [data-k2-part="Loading"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}, 40_000);

test("every hint has exactly one way out to its view", async () => {
  await open("?app=grids");
  expect(await page.locator('main [data-k2-part="Notice"]').count()).toBe(2);
  await page.locator("main").getByRole("link", { name: "Zustellungen ansehen" }).click();
  await page.waitForURL(/view=events/);
  await page.waitForSelector('body[data-ready="true"]');
  expect(new URL(page.url()).search).toBe("?app=grids&view=events");
  expect(await page.locator("main").getByRole("button", { name: "Erneut zustellen" }).count()).toBe(2);
}, 20_000);

test("an old link lands with a note that says where the page is now", async () => {
  await open("?moved=gateway");
  expect(await notice("ist jetzt hier").innerText()).toContain("„Systembeobachtung › Gateway › Apps“ ist jetzt hier.");
  await open("?moved=credentials");
  expect(await notice("Tokens für Host-Betrieb").count()).toBe(1);
}, 20_000);

test("only an app that is not running can leave the list; a failure keeps it and says so", async () => {
  await open("?app=mail");
  expect(await page.locator("main").innerText()).toContain("nur wenn gestoppt");
  expect(await page.locator("main").getByRole("button", { name: "Entfernen", exact: true }).count()).toBe(0);

  await open("?app=pulse&state=core-fail");
  await page.locator("main").getByRole("button", { name: "Entfernen", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog");
  expect(await dialog.innerText()).toContain("Zugriff, Schlüssel und Abos bleiben.");
  await dialog.getByRole("button", { name: "Entfernen" }).click();
  await notice("Nicht entfernt.").waitFor();
  expect(await notice("Nicht entfernt.").innerText()).toContain("Nicht entfernt. Pulse steht weiter in der Liste.");
}, 20_000);

test("a provider that does not answer says so, and its values say they are unavailable", async () => {
  await open("?app=mail&state=provider");
  expect(await notice("Gateway antwortet gerade nicht.").count()).toBe(1);
  expect(await fact("Verkehr 24 h").innerText()).toContain("Nicht verfügbar");
}, 20_000);

test("routes keep the five windows and say which prefix the router sends elsewhere", async () => {
  await open("?app=spaces&view=routes");
  const tabs = page.locator("main").getByRole("navigation", { name: "Zeitfenster" }).getByRole("link");
  expect(await tabs.allInnerTexts()).toEqual(["1 h", "6 h", "24 h", "7 Tage", "30 Tage"]);
  expect(
    await page.locator('main [data-k2-part="Pane"][data-detail] tbody tr').filter({ hasText: "fehlt im Router" }).innerText(),
  ).toContain("/caldav");
  expect(await notice("/caldav erklärt Spaces, der Router leitet es an Dateien weiter.").count()).toBe(1);
}, 20_000);

test("key states: a running app without a key starts with its environment, and its way out opens Create key", async () => {
  await open("");
  expect(await row("Dateien").innerText()).toContain("Startet noch mit Env");
  await open("?app=files");
  const hint = notice("Dateien holt Datenbank, Valkey und NATS aus der eigenen Env.");
  expect(await hint.getByRole("link", { name: "Umstellung (Fibel)" }).getAttribute("href")).toBe(
    "/docs/en/operations/app-keys#use-the-key-at-start",
  );
  expect(await fact("Schlüssel").first().innerText()).toContain("Kein Schlüssel · startet mit Env");
  expect(await hint.getByRole("link", { name: "Schlüssel erzeugen" }).getAttribute("href")).toBe(
    "/admin/apps?app=files&view=keys&create=1",
  );
}, 20_000);

test("key states: no valid key says so; rotation names the old key", async () => {
  await open("?app=notebooks");
  const hint = notice("Kein gültiger Schlüssel.");
  expect(await hint.getByRole("link", { name: "Neuen Schlüssel erzeugen" }).getAttribute("href")).toBe(
    "/admin/apps?app=notebooks&view=keys&create=1",
  );
  expect(await fact("Schlüssel").first().innerText()).toContain("kein gültiger Schlüssel");
  await open("?app=grids");
  expect(await fact("Schlüssel").first().innerText()).toContain("2 aktiv · Rotation läuft");
}, 20_000);

test("key states: a refused start leads the list and the app page, with one way out", async () => {
  await open("");
  expect(await row("Pulse").innerText()).toContain("Start abgelehnt · Schlüssel widerrufen · +1");
  await open("?app=pulse");
  const hint = notice("Pulse startet nicht.");
  expect(await hint.innerText()).toContain("Core hat den Schlüssel vor 3 Minuten beim Start abgelehnt, weil er widerrufen ist.");
  expect(await notice("Kein gültiger Schlüssel.").count()).toBe(0);
  expect(await hint.getByRole("link", { name: "Neuen Schlüssel erzeugen" }).getAttribute("href")).toBe(
    "/admin/apps?app=pulse&view=keys&create=1",
  );
  await open("?app=pulse&state=start-disabled");
  expect(await notice("Pulse startet nicht.").getByRole("link", { name: "Wieder aktivieren" }).getAttribute("href")).toBe(
    "/admin/apps?app=pulse&view=keys",
  );
  await open("?app=pulse&state=start-replaced");
  const replaced = notice("Ein gültiger Schlüssel existiert");
  expect(await replaced.getByRole("link", { name: "Schlüssel ansehen" }).getAttribute("href")).toBe("/admin/apps?app=pulse&view=keys");
  expect(await replaced.getByRole("link", { name: "Neuen Schlüssel erzeugen" }).count()).toBe(0);
}, 20_000);

test("domains: only an app with public pages has a Domains tab and fact", async () => {
  await open("?app=mail");
  expect(await fact("Domains").count()).toBe(0);
  expect(await page.locator("main").getByRole("link", { name: "Domains" }).count()).toBe(0);
  await open("?app=lager");
  expect(await fact("Domains").innerText()).toContain("lager.example.de +2 · 1 Problem");
  await open("?app=lager&state=domains-error");
  expect(await fact("Domains").innerText()).toContain("Nicht geladen");
}, 20_000);

test("a row opens its app beside the list; search, filter and tab stay in the address", async () => {
  await open("");
  await row("Grids").getByRole("link").first().click();
  await page.waitForURL(/app=grids/);
  await page.waitForSelector('body[data-ready="true"]');
  expect(new URL(page.url()).search).toBe("?app=grids");
  await page
    .locator("main")
    .getByRole("link", { name: /^Probleme/ })
    .click();
  await page.waitForURL(/filter=problems/);
  await page.waitForSelector('body[data-ready="true"]');
  expect(await page.locator("main tbody tr").count()).toBe(8);
  await page.getByRole("searchbox", { name: "App suchen" }).fill("dat");
  await page.getByRole("searchbox", { name: "App suchen" }).press("Enter");
  await page.waitForURL(/q=dat/);
  await page.waitForSelector('body[data-ready="true"]');
  expect(new URL(page.url()).search).toBe("?app=grids&q=dat&filter=problems");
  expect(await page.locator("main tbody tr").count()).toBe(1);
  await fact("Schlüssel").first().getByRole("link").click();
  await page.waitForURL(/view=keys/);
  expect(new URL(page.url()).search).toBe("?app=grids&view=keys&q=dat&filter=problems");
}, 30_000);

test("add app asks for the ID, refuses a wrong one in place, and opens the keys of a new app", async () => {
  await open("");
  await page.getByRole("button", { name: "App hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: /hinzufügen/ });
  const id = dialog.getByRole("textbox");
  await id.fill("Core");
  expect(await dialog.getByRole("button", { name: "Weiter" }).isDisabled()).toBe(true);
  await id.fill("inventar-neu");
  await dialog.getByRole("button", { name: "Weiter" }).click();
  await page.waitForURL(/app=inventar-neu/);
  expect(new URL(page.url()).search).toBe("?app=inventar-neu&view=keys");
}, 20_000);

test("a search that finds nothing says so in place and leads back to every app", async () => {
  await open("?q=zzz");
  expect(await page.locator("main").innerText()).toContain("Keine App passt zur Suche oder zum Filter.");
  expect(await page.locator("main").getByRole("link", { name: "Alle Apps zeigen" }).getAttribute("href")).toBe("/admin/apps");
}, 20_000);

test("on a phone the list keeps name and state with the problem under the name, and the open app is its own page", async () => {
  await open("", 390);
  expect(await page.locator('main .k2-table-phone [data-k2-part="Row"]').filter({ hasText: "Pulse" }).innerText()).toContain(
    "Start abgelehnt",
  );
  await open("?app=mail&view=keys", 390);
  expect(await page.locator('[data-keys="mail"]').isVisible()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}, 20_000);

test("keys: the private key shows once, and closing it unsaved asks first", async () => {
  await open("?app=mail&view=keys");
  const keys = page.locator('[data-keys="mail"]');
  expect(await keys.locator("[data-key]").count()).toBe(1);
  await keys.getByRole("button", { name: /Widerrufen \(1\)/ }).click();
  expect(await keys.locator("[data-key]").count()).toBe(2);
  await keys.getByRole("button", { name: /Tokens für Host-Betrieb \(1\)/ }).click();
  expect(await keys.locator('[data-token="host-override"]').isVisible()).toBe(true);

  // The button turns on once the browser check finds Ed25519, which both test engines have; click waits for that.
  await page.getByRole("button", { name: "Schlüssel erzeugen" }).click();
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

test("keys: a key generation the engine refuses once still creates the key", async () => {
  // Playwright's WebKit on Linux refuses about one Ed25519 generateKey in a hundred with an OperationError (#2286).
  // Refuse the browser check and the first generation that way; a new pair must follow, not "no Ed25519" or a failure.
  await page.addInitScript(() => {
    const generateKey = crypto.subtle.generateKey.bind(crypto.subtle);
    let refusals = 2;
    crypto.subtle.generateKey = ((...args: Parameters<SubtleCrypto["generateKey"]>) =>
      refusals-- > 0
        ? Promise.reject(new DOMException("The operation failed for an operation-specific reason", "OperationError"))
        : generateKey(...args)) as SubtleCrypto["generateKey"];
  });
  await open("?app=mail&view=keys");
  await page.getByRole("button", { name: "Schlüssel erzeugen" }).click();
  await page.locator("[data-key-create]").getByRole("button", { name: "Erzeugen" }).click();
  const once = page.locator("[data-key-once]");
  await once.waitFor();
  expect(await once.innerText()).toContain("Nur jetzt sichtbar.");
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
  expect(await page.getByText("Rotation läuft. Sobald keine Instanz mehr den alten Schlüssel nutzt, widerrufe ihn.").isVisible()).toBe(
    true,
  );
  expect(await page.getByRole("button", { name: "Schlüssel erzeugen" }).isDisabled()).toBe(true);
}, 20_000);

test("key states: when the first keys read fails, the browser read still opens the refused revoked key", async () => {
  await open("?app=pulse&view=keys&state=keys-late");
  const key = page.locator('[data-keys="pulse"] [data-key="pulse-prod"]');
  await key.waitFor();
  expect(await key.innerText()).toContain("Start abgelehnt vor 3 Minuten");
}, 20_000);

/** A domain of the open app: the row whose first line is exactly its host. */
const domain = (host: string) =>
  page.locator('main [data-k2-part="Pane"][data-detail] [data-k2-part="Row"]').filter({ has: page.getByText(host, { exact: true }) });

test("domains: adding keeps the input on a conflict, an alias appears under its primary, and the primary can change", async () => {
  await open("?app=lager&view=domains");
  await page.getByRole("button", { name: "Domain hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: "Domain hinzufügen" });
  await dialog.getByRole("textbox", { name: /^Domain/ }).fill("mail.example.de");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await dialog.getByRole("alert").waitFor();
  expect(await dialog.getByRole("alert").innerText()).toContain("Diese Domain gehört schon zu einer App.");
  expect(await dialog.getByRole("textbox", { name: /^Domain/ }).inputValue()).toBe("mail.example.de");
  await dialog.getByRole("textbox", { name: /^Domain/ }).fill("lager");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await dialog.getByRole("alert").getByText("Das ist kein gültiger Hostname.", { exact: false }).waitFor();
  await dialog.getByRole("textbox", { name: /^Domain/ }).fill("shop.example.de");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await domain("shop.example.de").waitFor();
  expect(await domain("shop.example.de").innerText()).toContain("Erste Prüfung läuft …");

  await page.getByRole("button", { name: "Aktionen für www.lager.example.de" }).click();
  await page.getByRole("menuitem", { name: "Als Hauptdomain setzen" }).click();
  await domain("lager.example.de").getByText("Leitet mit 301 weiter auf www.lager.example.de").waitFor();
  expect(await domain("www.lager.example.de").innerText()).toContain("Hauptdomain");
}, 20_000);

test("domains: a domain others redirect to cannot be removed; removing another asks first", async () => {
  await open("?app=lager&view=domains");
  await page.getByRole("button", { name: "Aktionen für lager.example.de" }).click();
  const blocked = page.getByRole("menuitem", { name: /Entfernen/ });
  expect(await blocked.isDisabled()).toBe(true);
  expect(await blocked.innerText()).toContain("Andere Domains leiten hierher weiter");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Aktionen für bestand.example.de" }).click();
  await page.getByRole("menuitem", { name: "Entfernen …" }).click();
  const dialog = page.getByRole("alertdialog");
  expect(await dialog.innerText()).toContain("Lagerbestand antwortet danach nicht mehr unter bestand.example.de.");
  await dialog.getByRole("button", { name: "Entfernen" }).click();
  await domain("bestand.example.de").waitFor({ state: "detached" });
}, 20_000);

test("domains: a promotion that stops halfway says so and can be finished", async () => {
  await open("?app=lager&view=domains&state=domains-partial");
  await page.getByRole("button", { name: "Aktionen für www.lager.example.de" }).click();
  await page.getByRole("menuitem", { name: "Als Hauptdomain setzen" }).click();
  const alert = page.locator('main [data-k2-part="Notice"][data-tone="bad"]');
  await alert.getByText("Nur teilweise geändert.", { exact: false }).waitFor();
  await alert.getByRole("button", { name: "Änderung abschließen" }).click();
  await domain("lager.example.de").getByText("Leitet mit 301 weiter auf www.lager.example.de").waitFor();
  expect(await alert.count()).toBe(0);
}, 20_000);

test("domains: each domain shows its three checks, and the view keeps the v2 rules", async () => {
  for (const width of [1440, 390]) {
    await open("?app=lager&view=domains", width);
    expect(await domain("lager.example.de").innerText()).toContain("DNS ok");
    expect({ width, problems: (await measureV2Layout(page, { root: "main.k2-ui", skip: ".k2b-field" })).problems }).toEqual({
      width,
      problems: [],
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}, 30_000);
