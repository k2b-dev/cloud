import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { codeAreaBrowserFixture } from "./CodeArea.browser-fixture";
import { FIXTURE_GROUPS, FIXTURE_VERSIONS, fixtureApprovalDetail } from "./CodeArea.fixture-data";

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

const sidebarCode = () => page.locator('a[href="/admin/code"]').filter({ visible: true }).first();

/** Every element that is scrolled away from its start: an approval must not move a scroller the person did not scroll. */
const scrolled = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((element) => element.scrollTop > 0)
      .map((element) => element.className.toString())
      .concat(window.scrollY > 0 ? ["window"] : []),
  );
const inView = (text: string) =>
  page.getByText(text, { exact: true }).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });

test("an approval opens at its header with the reasons in view", async () => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await goto(review, viewport);
    await settled(page);
    expect({ viewport: viewport.width, scrolled: await scrolled(), why: await inView("Warum du freigibst") }).toEqual({
      viewport: viewport.width,
      scrolled: [],
      why: true,
    });
  }
}, 20_000);

test("the decision bar keeps reject and approve on one row under the binding line", async () => {
  for (const [query, viewport] of [
    [review, { width: 1280, height: 900 }],
    [`${review}&state=difffail`, { width: 1280, height: 900 }],
    [review, { width: 390, height: 844 }],
  ] as const) {
    await goto(query, viewport);
    await settled(page);
    const reject = await page.getByRole("button", { name: "Ablehnen …" }).boundingBox();
    const approve = await page.getByRole("button", { name: "Version 3 freigeben" }).boundingBox();
    const binding = await page.getByText("Gilt genau für Version 3", { exact: false }).boundingBox();
    expect({ query, width: viewport.width, row: reject?.y === approve?.y, below: (binding?.y ?? 0) < (approve?.y ?? 0) }).toEqual({
      query,
      width: viewport.width,
      row: true,
      below: true,
    });
  }
}, 20_000);

test("approving sends the unchanged hash binding, shows the result and lowers the sidebar count", async () => {
  await goto(review);
  await page.getByText("Lieferungen eintragen", { exact: true }).waitFor();
  expect(await page.getByText("lieferungenEintragen", { exact: true }).count()).toBe(1);
  expect(await sidebarCode().innerText()).toContain("4");
  await page.getByText("„Für andere sichtbar“ steht für Lea Muster auf Admin gibt frei, aus dem Standard.").waitFor();
  await page.getByText("https://api.buchhaltung-beispiel.de", { exact: true }).waitFor();
  // The person read down to the diff and decides in the footer.
  await page.getByRole("heading", { name: "Code-Unterschied" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.getByText("Version 3 ist freigegeben.").waitFor();
  await page.waitForLoadState("load");
  // The result opens in view, at the top of the reloaded review, and takes focus once.
  await page.waitForFunction(() => document.activeElement?.id === "code-review-result");
  expect(await scrolled()).toEqual([]);
  expect(await inView("Version 3 ist freigegeben.")).toBe(true);
  await page.getByText("Zurücknehmen geht über „Pausieren“ am Code.", { exact: false }).waitFor();
  expect(fixture.requests).toEqual([{ path: "decide", body: { binding: fixtureApprovalDetail().binding, approved: true } }]);
  await page.getByRole("link", { name: "Code öffnen" }).waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).count()).toBe(0);
  expect(await sidebarCode().innerText()).toContain("3");
  expect(await page.locator(`a[href*="sec=approvals"][href*="id=${FIXTURE_VERSIONS.rueckruf3}"]`).count()).toBe(0);
  await page.reload();
  await page.getByText("Version 3 ist freigegeben.").waitFor();
  expect(await sidebarCode().innerText()).toContain("3");
  expect(await page.locator(`a[href*="sec=approvals"][href*="id=${FIXTURE_VERSIONS.rueckruf3}"]`).count()).toBe(0);
}, 20_000);

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
  await page.waitForLoadState("load");
  await page.getByText("Version 3 ist abgelehnt.").waitFor();
  expect(await sidebarCode().innerText()).toContain("3");
}, 20_000);

test("a line reference opens its file and marks the line in the Code difference without moving the shell", async () => {
  await goto(review, { width: 1280, height: 900 });
  await settled(page);
  await page.getByRole("button", { name: "Zeile 11 in code.ts zeigen" }).click();
  const marked = page.locator('[data-marked="true"]').filter({ hasText: "spaces.space" });
  await marked.waitFor();
  await settled(page);
  // Only the detail column scrolls to the line; the workspace around the list and the detail stays where it was.
  const moved = await scrolled();
  expect(moved.length).toBeGreaterThan(0);
  expect(moved.filter((name) => !name.includes("k2b-app-workspace__level-body"))).toEqual([]);
  expect(await marked.evaluate((row) => row.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
}, 20_000);

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
}, 20_000);

test("a policy change previews what pauses, confirms the list and saves at the read revision", async () => {
  await goto("sec=policy");
  const bar = page.locator('[aria-live="polite"]').last();
  await settled(page);
  const before = await page.locator('[data-row="read"]').boundingBox();
  await page.getByRole("radiogroup", { name: "Wert für Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await bar.getByText("3 Code pausieren").waitFor();
  await settled(page);
  expect(await page.locator('[data-row="read"]').boundingBox()).toEqual(before);
  expect(await page.locator('[data-row="silent_shared"]').getAttribute("data-changed")).toBe("true");
  await bar.getByRole("button", { name: "Speichern …" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Lieferschein bei Abschluss").waitFor();
  await dialog.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("3 Code pausiert, weil die neue Richtlinie seine Einstufungen nicht mehr automatisch erlaubt.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 7, definition: { preset: "custom" } });
  expect(JSON.stringify(update?.body)).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
}, 20_000);

test("a concurrent policy change keeps my change, rechecks it on the newer revision and saves both", async () => {
  await goto("sec=policy&state=conflict");
  await page.getByRole("radiogroup", { name: "Wert für Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByText("Ein anderer Admin hat die Richtlinie inzwischen geändert.").waitFor();
  expect(await page.locator('[data-row="silent_shared"]').getAttribute("data-changed")).toBe("true");
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
  expect(saved).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
  expect(saved).toContain('{"groupId":null,"row":"internet","value":"automatic"}');
}, 20_000);

test("a refused save keeps the change; saving again previews and confirms the current draft", async () => {
  await goto("sec=policy&state=savefail");
  await page.getByRole("radiogroup", { name: "Wert für Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  const bar = page.locator('[aria-live="polite"]').last();
  await bar.getByRole("button", { name: "Speichern …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Nicht gespeichert.").waitFor();
  expect(await page.locator('[data-row="silent_shared"]').getAttribute("data-changed")).toBe("true");
  await page.getByRole("radiogroup", { name: "Wert für KI" }).getByRole("radio", { name: "Automatisch" }).click();
  await bar.getByText("2 Änderungen").waitFor();
  await bar.getByText("3 Code pausieren").waitFor();
  await page.getByRole("button", { name: "Erneut speichern" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Gespeichert.").waitFor();
  const saved = JSON.stringify(fixture.requests.filter((request) => request.path === "policy/update").at(-1)?.body);
  expect(saved).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
  expect(saved).toContain('{"groupId":null,"row":"ai","value":"automatic"}');
}, 20_000);

test("a lost answer never claims that nothing changed", async () => {
  await goto("sec=policy&state=lost");
  await page.getByRole("radiogroup", { name: "Wert für Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.locator('[aria-live="polite"]').last().getByRole("button", { name: "Speichern …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Die Antwort ist nicht angekommen.").waitFor();
  expect(await page.getByText("Nicht gespeichert.").count()).toBe(0);
  await goto(`${review}&state=lost`);
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.getByText("Die Entscheidung ist vielleicht gespeichert.", { exact: false }).waitFor();
  expect(await page.getByText("Nichts wurde geändert.", { exact: false }).count()).toBe(0);
}, 20_000);

test("a Cloud admin pauses any Code from its detail, and a refused resume says why", async () => {
  await goto("sec=code&id=c_rechn");
  await page.getByRole("button", { name: "Pausieren" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pausieren" }).click();
  await page.waitForLoadState("load");
  expect(fixture.requests).toEqual([{ path: "pause", body: { codeId: "c_rechn", paused: true } }]);
  await goto("sec=code&id=c_woche&state=savefail");
  await page.getByRole("button", { name: "Fortsetzen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fortsetzen" }).click();
  await page.getByText("braucht unter der aktuellen Richtlinie eine neue Freigabe", { exact: false }).waitFor();
  await goto("sec=code&id=c_woche&state=conflict");
  await page.getByRole("button", { name: "Fortsetzen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fortsetzen" }).click();
  await page.getByText("verbietet eine Einstufung der aktiven Version", { exact: false }).waitFor();
}, 20_000);

test("a phone shows one level with its decision bar in reach", async () => {
  await goto(review, { width: 390, height: 844 });
  await settled(page);
  const approve = await page.getByRole("button", { name: "Version 3 freigeben" }).boundingBox();
  expect(approve !== null && approve.y + approve.height <= 844).toBe(true);
  await page.getByText("Warum du freigibst").waitFor();
}, 20_000);

test("Code of an app shows its service account and refused call like any Code page, on a computer and a phone", async () => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await goto("sec=code&id=c_portal", viewport);
    await settled(page);
    await page.getByText("Läuft als Dienstkonto „Code von", { exact: false }).waitFor();
    await page.getByText("Kein Zugriff auf Space", { exact: false }).waitFor();
    // N4-l127-schrift: the head line shares the Code page's lead, muted and one step smaller than the page's text.
    const lead = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>(".cloud-code__lead");
      if (!element?.textContent?.startsWith("Läuft als Dienstkonto")) return null;
      const probe = document.createElement("span");
      probe.style.color = "var(--k2b-text-muted)";
      element.parentElement!.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return { size: getComputedStyle(element).fontSize, muted: getComputedStyle(element).color === muted };
    });
    expect(lead).toEqual({ size: "13px", muted: true });
    // N5-admin-hinweis-schrift: the hint under the notice has the size of the notice's text and of the Code page.
    const hint = await page.evaluate(() => {
      const note = document.querySelector<HTMLElement>(".cloud-code__refusal .cloud-code__quiet");
      const detail = note?.parentElement?.querySelector<HTMLElement>(".k2b-notice-card__description");
      return note && detail ? { note: getComputedStyle(note).fontSize, detail: getComputedStyle(detail).fontSize } : null;
    });
    expect(hint).toEqual({ note: "14px", detail: "14px" });
    expect(await page.locator('a[href="/app/spaces/k7qm2x9a"]').count()).toBe(1);
    expect(await page.getByText("Der nächste Lauf versucht es erneut.", { exact: false }).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (process.env.CODE_PAGE_SHOTS)
      await page.screenshot({ path: `${process.env.CODE_PAGE_SHOTS}/admin-app-${viewport.width}.png`, fullPage: false });
  }
}, 30_000);

test("asking rows stay at Never without a choice at desktop and phone widths", async () => {
  for (const width of [1280, 390]) {
    for (const query of ["sec=policy", `sec=groups&id=${FIXTURE_GROUPS.buchhaltung}`]) {
      await goto(query, { width, height: 900 });
      const rows = page.locator('[data-row^="ask_"]');
      expect(await rows.count()).toBe(8);
      for (const row of await rows.all()) {
        expect(await row.getByRole("radiogroup").count()).toBe(0);
        expect(await row.getByText("Nie", { exact: true }).count()).toBe(1);
        expect(await row.getByText("In diesem Release läuft das nicht unbeaufsichtigt.", { exact: true }).count()).toBe(1);
      }
    }
    await goto("sec=policy", { width, height: 900 });
    if (process.env.CODE_PAGE_SHOTS) {
      await page.locator('[data-row="ask_sends"]').evaluate((row) => row.scrollIntoView({ block: "start" }));
      await settled(page);
      await page.screenshot({ path: `${process.env.CODE_PAGE_SHOTS}/policy-fixed-light-${width}.png`, fullPage: false });
      await goto(review, { width, height: 900 });
      await page.getByRole("heading", { name: "Was der Code aufruft" }).scrollIntoViewIfNeeded();
      await settled(page);
      await page.screenshot({ path: `${process.env.CODE_PAGE_SHOTS}/approval-calls-light-${width}.png`, fullPage: false });
    }
  }
}, 30_000);
