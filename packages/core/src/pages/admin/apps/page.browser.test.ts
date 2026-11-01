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
  expect(await grids.innerText()).toContain("Fehlerquote 4,3% in 24 h · +2");
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

test("key states: a running app without a key says it still starts with its environment, and its way out opens Create key", async () => {
  await open("");
  expect(await page.locator('[data-app="files"]').innerText()).toContain("Startet noch mit Env");
  await open("?app=files");
  const notice = page.locator('[data-hint="envStart"]');
  expect(await notice.innerText()).toContain("Dateien holt Datenbank, Valkey und NATS aus der eigenen Env.");
  expect(await notice.getByRole("link", { name: "Umstellung (Fibel)" }).getAttribute("href")).toBe(
    "/docs/en/operations/app-keys#use-the-key-at-start",
  );
  expect(await page.locator('[data-row="Schlüssel"]').innerText()).toContain("Kein Schlüssel · startet mit Env");
  await notice.getByRole("link", { name: "Schlüssel erzeugen" }).click();
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator("[data-key-create]").waitFor();
  expect(new URL(page.url()).search).toBe("?app=files&view=keys");
  // The way out opens exactly one dialog.
  expect(await page.locator("[data-key-create]").count()).toBe(1);
  expect(await page.locator('[data-keys="files"]').innerText()).toContain(
    "Bis dahin startet Dateien mit den Zugängen aus der eigenen Env.",
  );
}, 20_000);

test("key states: no valid key carries the page's one filled action; rotation names the old key", async () => {
  await open("?app=notebooks");
  const notice = page.locator('[data-hint="keyRevoked"]');
  expect(await notice.innerText()).toContain("Kein gültiger Schlüssel.");
  const action = notice.getByRole("link", { name: "Neuen Schlüssel erzeugen" });
  expect(await action.getAttribute("href")).toBe("/admin/apps?app=notebooks&view=keys&create=1");
  expect(await action.getAttribute("data-variant")).toBe("primary");
  expect(await page.locator('[data-row="Schlüssel"]').innerText()).toContain("kein gültiger Schlüssel");
  await open("?app=notebooks&view=keys");
  const keys = page.locator('[data-keys="notebooks"]');
  expect(await keys.innerText()).toContain("Kein gültiger Schlüssel.");
  expect(await keys.locator('[data-key="erststart"]').isVisible()).toBe(true);

  await open("?app=grids&view=keys");
  expect(await page.getByText("Rotation läuft. Sobald keine Instanz mehr den alten Schlüssel nutzt, widerrufe ihn.").isVisible()).toBe(
    true,
  );
  expect(await page.locator('[data-key="produktion-2026-10"]').innerText()).toContain("produktion-2026-10 (alt)");
  expect(await page.locator('[data-key="rotation-2026-11"]').innerText()).not.toContain("(alt)");
  await open("?app=grids");
  expect(await page.locator('[data-row="Schlüssel"]').innerText()).toContain("2 aktiv · Rotation läuft");
  expect(await page.locator('[data-hint="rotation"]').count()).toBe(0);
}, 20_000);

test("key states: a refused start leads the list and the app page, and the keys column marks the refused key", async () => {
  await open("");
  expect(await page.locator('[data-app="pulse"]').innerText()).toContain("Start abgelehnt · Schlüssel widerrufen · +1");
  await open("?app=pulse");
  const notice = page.locator('[data-hint="startRejected"]');
  expect(await notice.innerText()).toContain(
    "Pulse startet nicht. Core hat den Schlüssel vor 3 Minuten beim Start abgelehnt, weil er widerrufen ist.",
  );
  // The refusal already says there is no valid key; the page keeps one filled action.
  expect(await page.locator('[data-hint="keyRevoked"]').count()).toBe(0);
  const action = notice.getByRole("link", { name: "Neuen Schlüssel erzeugen" });
  expect(await action.getAttribute("href")).toBe("/admin/apps?app=pulse&view=keys&create=1");
  expect(await action.getAttribute("data-variant")).toBe("primary");
  expect(await notice.getByRole("link", { name: "Was tun? (Fibel)" }).count()).toBe(1);
  await open("?app=pulse&view=keys");
  const key = page.locator('[data-keys="pulse"] [data-key="pulse-prod"]');
  expect(await key.isVisible()).toBe(true);
  expect(await key.innerText()).toContain("Start abgelehnt vor 3 Minuten");

  // Background access off: the way out is turning it on again, in the keys column.
  await open("?app=pulse&state=start-disabled");
  const disabled = page.locator('[data-hint="startRejected"]');
  expect(await disabled.innerText()).toContain("weil der Hintergrundzugriff der App aus ist");
  expect(await disabled.getByRole("link", { name: "Wieder aktivieren" }).getAttribute("href")).toBe("/admin/apps?app=pulse&view=keys");
  await open("?app=pulse&view=keys&state=start-disabled");
  expect(await page.locator("[data-background-off]").getByRole("button", { name: "Wieder aktivieren" }).isVisible()).toBe(true);
}, 20_000);

test("key states: once Core would take a start again, the refusal asks only for the deployment and a restart", async () => {
  await open("?app=pulse&state=start-replaced");
  const notice = page.locator('[data-hint="startRejected"]');
  expect(await notice.innerText()).toContain(
    "Ein gültiger Schlüssel existiert und der Hintergrundzugriff ist an: Hinterlege den Schlüssel im Deployment und starte die App neu.",
  );
  const action = notice.getByRole("link", { name: "Schlüssel ansehen" });
  expect(await action.getAttribute("href")).toBe("/admin/apps?app=pulse&view=keys");
  expect(await action.getAttribute("data-variant")).toBe("secondary");
  expect(await notice.getByRole("link", { name: "Neuen Schlüssel erzeugen" }).count()).toBe(0);
}, 20_000);

test("key states: when the first keys read fails, the browser read still opens the refused revoked key", async () => {
  await open("?app=pulse&view=keys&state=keys-late");
  const key = page.locator('[data-keys="pulse"] [data-key="pulse-prod"]');
  await key.waitFor();
  expect(await key.innerText()).toContain("Start abgelehnt vor 3 Minuten");
}, 20_000);

test("domains: only an app with public pages has a Domains row; its column shows each domain's checks and redirect", async () => {
  await open("?app=mail");
  expect(await page.locator('[data-row="Domains"]').count()).toBe(0);
  await open("?app=lager");
  expect(await page.locator('[data-row="Domains"]').innerText()).toContain("lager.example.de +2 · 1 Problem");
  await open("?app=lager&view=domains");
  const column = page.locator('[data-domains="lager"]');
  expect(await column.locator("[data-domain]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-domain")))).toEqual([
    "lager.example.de",
    "www.lager.example.de",
    "bestand.example.de",
  ]);
  expect(await column.locator('[data-domain="lager.example.de"]').innerText()).toContain("Hauptdomain");
  expect(await column.locator('[data-domain="www.lager.example.de"]').innerText()).toContain("Leitet mit 301 weiter auf lager.example.de");
  const broken = column.locator('[data-domain="bestand.example.de"]');
  expect(await broken.locator("[data-domain-status]").innerText()).toContain("Zertifikat fehlgeschlagen");
  expect(await broken.innerText()).toContain("certificate has expired");
  const check = broken.getByRole("button", { name: "Prüfen bestand.example.de" });
  await check.click();
  await page
    .getByRole("button", { name: "Prüfen bestand.example.de" })
    .getByText(/Erneut prüfen in \d+ s/)
    .waitFor();
  expect(await check.isDisabled()).toBe(true);
}, 20_000);

test("domains: adding keeps the input on a conflict, an alias appears under its primary, and the primary can change", async () => {
  await open("?app=lager&view=domains");
  await page.getByRole("button", { name: "Domain hinzufügen" }).click();
  const dialog = page.locator("[data-domain-add]");
  await dialog.getByRole("textbox", { name: "Domain" }).fill("mail.example.de");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await dialog.getByRole("alert").waitFor();
  expect(await dialog.getByRole("alert").innerText()).toContain("Diese Domain gehört schon zu einer App.");
  expect(await dialog.getByRole("textbox", { name: "Domain" }).inputValue()).toBe("mail.example.de");
  await dialog.getByRole("textbox", { name: "Domain" }).fill("lager");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await dialog.getByRole("alert").getByText("Das ist kein gültiger Hostname.", { exact: false }).waitFor();
  await dialog.getByRole("textbox", { name: "Domain" }).fill("shop.example.de");
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  const added = page.locator('[data-domain="shop.example.de"]');
  await added.waitFor();
  expect(await added.innerText()).toContain("Erste Prüfung läuft …");

  await page.getByRole("button", { name: "Aktionen für www.lager.example.de" }).click();
  await page.getByRole("menuitem", { name: "Als Hauptdomain setzen" }).click();
  await page.locator('[data-domain="lager.example.de"]').getByText("Leitet mit 301 weiter auf www.lager.example.de").waitFor();
  expect(await page.locator('[data-domain="www.lager.example.de"]').innerText()).toContain("Hauptdomain");
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
  await page.locator('[data-domain="bestand.example.de"]').waitFor({ state: "detached" });
}, 20_000);

test("domains: an empty list and a failed read each say so in place", async () => {
  await open("?app=lager&view=domains&state=domains-empty");
  expect(await page.locator('[data-domains="lager"]').innerText()).toContain("Noch keine Domain.");
  await open("?app=lager&view=domains&state=domains-error");
  expect(await page.locator('[data-domains="lager"]').innerText()).toContain("Die Domains konnten nicht geladen werden.");
  expect(await page.getByRole("button", { name: "Erneut versuchen" }).isVisible()).toBe(true);
  await open("?app=lager&state=domains-error");
  expect(await page.locator('[data-row="Domains"]').innerText()).toContain("Nicht geladen");
}, 20_000);

test("domains: a promotion that stops halfway says so and can be finished", async () => {
  await open("?app=lager&view=domains&state=domains-partial");
  await page.getByRole("button", { name: "Aktionen für www.lager.example.de" }).click();
  await page.getByRole("menuitem", { name: "Als Hauptdomain setzen" }).click();
  const alert = page.locator('[data-domains="lager"] [role="alert"]');
  await alert.getByText("Nur teilweise geändert.", { exact: false }).waitFor();
  await alert.getByRole("button", { name: "Änderung abschließen" }).click();
  await page.locator('[data-domain="lager.example.de"]').getByText("Leitet mit 301 weiter auf www.lager.example.de").waitFor();
  expect(await alert.count()).toBe(0);
}, 20_000);
