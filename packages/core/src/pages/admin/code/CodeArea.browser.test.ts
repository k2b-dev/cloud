import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { codeAreaBrowserFixture } from "./CodeArea.browser-fixture";
import { FIXTURE_VERSIONS, fixtureApprovalDetail } from "./CodeArea.fixture-data";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof codeAreaBrowserFixture>>;
let page: Page;
let errors: string[] = [];
const goto = async (query: string, viewport = { width: 1440, height: 1000 }) => {
  if (page) {
    expect(errors).toEqual([]);
    await page.close();
  }
  page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((at) => {
    globalThis.Date = new Proxy(Date, {
      construct: (target, args) => Reflect.construct(target, args.length ? args : [at]),
      apply: (target) => new target(at).toString(),
      get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
    });
  }, Date.parse("2026-11-01T12:10:00.000Z"));
  errors = pageErrors(page);
  await page.goto(`${fixture.url}?locale=de&${query}`);
  await page.waitForSelector('body[data-ready="true"]');
};
const review = `sec=approvals&id=${FIXTURE_VERSIONS.rueckruf3}`;

beforeAll(async () => {
  fixture = await codeAreaBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(() => fixture.reset());
afterEach(() => expect(errors).toEqual([]));
afterAll(async () => {
  await page?.close();
  await browser?.close();
  fixture?.close();
});

test("approving sends the unchanged hash binding and shows the result in place", async () => {
  await goto(review);
  await page.getByText("„Bezieht Personen ein“ steht für Lea Muster auf Admin gibt frei, aus dem Standard.").waitFor();
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.getByText("Version 3 ist freigegeben.").waitFor();
  expect(fixture.requests).toEqual([{ path: "decide", body: { binding: fixtureApprovalDetail().binding, approved: true } }]);
  await page.getByRole("link", { name: "Nächste Version prüfen" }).waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).count()).toBe(0);
});

test("rejecting asks first and cancel changes nothing", async () => {
  await goto(review);
  await page.getByRole("button", { name: "Ablehnen …" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Die aktive Version läuft weiter.", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  expect(fixture.requests).toHaveLength(0);
  await page.getByRole("button", { name: "Ablehnen …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Version ablehnen" }).click();
  await page.getByText("Version 3 ist abgelehnt.").waitFor();
  expect(fixture.requests).toEqual([{ path: "decide", body: { binding: fixtureApprovalDetail().binding, approved: false } }]);
});

test("a line reference opens its file and marks the line in the Code difference", async () => {
  await goto(review);
  await page.getByRole("button", { name: "Zeile 11 in code.ts zeigen" }).click();
  await page.locator('[data-marked="true"]').filter({ hasText: "spaces.space" }).waitFor();
});

test("an outdated, own or unloaded version cannot be approved and says why", async () => {
  await goto(`${review}&state=newer`);
  await page.getByText("Lea Muster hat Version 4 eingereicht.").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isDisabled()).toBe(true);
  await page.getByText("Version 3 ist überholt").waitFor();
  expect(await page.getByRole("link", { name: "Version 4 prüfen" }).getAttribute("href")).toMatch(/a0000000-0000-4000-8000-000000000004/);

  await goto(`${review}&state=own`);
  await page.getByText("Du hast diese Version geschrieben.").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).count()).toBe(0);

  await goto(`${review}&state=sole`);
  await page.getByText("Es gibt keinen zweiten Cloud-Admin", { exact: false }).waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isEnabled()).toBe(true);

  await goto(`${review}&state=difffail`);
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isDisabled()).toBe(true);
  await page.getByText("Code nicht geladen").waitFor();
});

test("a policy change previews what pauses, confirms the list and saves at the read revision", async () => {
  await goto("sec=policy");
  const bar = page.locator('[aria-live="polite"]').last();
  await settled(page);
  const before = await page.locator('[data-row="read"]').boundingBox();
  await page.getByRole("radiogroup", { name: "Wert für Löscht" }).getByRole("radio", { name: "Automatisch" }).click();
  await bar.getByText("3 Code pausieren").waitFor();
  await settled(page);
  expect(await page.locator('[data-row="read"]').boundingBox()).toEqual(before);
  expect(await page.locator('[data-row="ask_deletes"]').getAttribute("data-changed")).toBe("true");
  await bar.getByRole("button", { name: "Speichern …" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Lieferschein bei Abschluss").waitFor();
  await dialog.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("3 Code pausiert, weil die neue Richtlinie seine Einstufungen nicht mehr automatisch erlaubt.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 7, definition: { preset: "custom" } });
  expect(JSON.stringify(update?.body)).toContain('{"groupId":null,"row":"ask_deletes","value":"automatic"}');
});

test("a concurrent policy change keeps my change, rechecks it on the newer revision and saves both", async () => {
  await goto("sec=policy&state=conflict");
  await page.getByRole("radiogroup", { name: "Wert für Löscht" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByText("Ein anderer Admin hat die Richtlinie inzwischen geändert.").waitFor();
  expect(await page.locator('[data-row="ask_deletes"]').getAttribute("data-changed")).toBe("true");
  await page.getByRole("button", { name: "Meine Änderung neu prüfen" }).click();
  const bar = page.locator('[aria-live="polite"]').last();
  await bar.getByText("3 Code pausieren").waitFor();
  expect(await page.getByText("Ein anderer Admin hat die Richtlinie inzwischen geändert.").count()).toBe(0);
  await bar.getByRole("button", { name: "Speichern …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Gespeichert.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 9 });
  const saved = JSON.stringify(update?.body);
  expect(saved).toContain('{"groupId":null,"row":"ask_deletes","value":"automatic"}');
  expect(saved).toContain('{"groupId":null,"row":"ask_cannot_undo","value":"automatic"}');
});

test("a refused save keeps the change; saving again previews and confirms the current draft", async () => {
  await goto("sec=policy&state=savefail");
  await page.getByRole("radiogroup", { name: "Wert für Löscht" }).getByRole("radio", { name: "Automatisch" }).click();
  const bar = page.locator('[aria-live="polite"]').last();
  await bar.getByRole("button", { name: "Speichern …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Nicht gespeichert.").waitFor();
  expect(await page.locator('[data-row="ask_deletes"]').getAttribute("data-changed")).toBe("true");
  await page.getByRole("radiogroup", { name: "Wert für Sensibel" }).getByRole("radio", { name: "Automatisch" }).click();
  await bar.getByText("2 Änderungen").waitFor();
  await bar.getByText("3 Code pausieren").waitFor();
  await page.getByRole("button", { name: "Erneut speichern" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Gespeichert.").waitFor();
  const saved = JSON.stringify(fixture.requests.filter((request) => request.path === "policy/update").at(-1)?.body);
  expect(saved).toContain('{"groupId":null,"row":"ask_deletes","value":"automatic"}');
  expect(saved).toContain('{"groupId":null,"row":"ask_sensitive","value":"automatic"}');
});

test("a lost answer never claims that nothing changed", async () => {
  await goto("sec=policy&state=lost");
  await page.getByRole("radiogroup", { name: "Wert für Löscht" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.locator('[aria-live="polite"]').last().getByRole("button", { name: "Speichern …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Die Antwort ist nicht angekommen.").waitFor();
  expect(await page.getByText("Nicht gespeichert.").count()).toBe(0);
  await goto(`${review}&state=lost`);
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.getByText("Die Entscheidung ist vielleicht gespeichert.", { exact: false }).waitFor();
  expect(await page.getByText("Nichts wurde geändert.", { exact: false }).count()).toBe(0);
});

test("a phone shows one level with its decision bar in reach", async () => {
  await goto(review, { width: 390, height: 844 });
  await settled(page);
  const approve = await page.getByRole("button", { name: "Version 3 freigeben" }).boundingBox();
  expect(approve !== null && approve.y + approve.height <= 844).toBe(true);
  await page.getByText("Warum du freigibst").waitFor();
});
