import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { codeAreaBrowserFixture } from "./CodeArea.browser-fixture";
import { FIXTURE_NOW, FIXTURE_VERSIONS, fixtureApprovalDetail } from "./CodeArea.fixture-data";

// Administration › Code on v2: every section keeps the layout rules at every width with the worst case included, the
// sections stand nested in the admin bar, a review is decided with its dialogs and recoveries, comments are written at
// their lines, the policy saves with what it pauses, and an automation pauses and its unused database is deleted.
setDefaultTimeout(30_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof codeAreaBrowserFixture>>;
let page: Page;
let errors: string[] = [];
const goto = async (query: string, viewport = { width: 1440, height: 900 }, locale = "de") => {
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
  }, FIXTURE_NOW);
  errors = pageErrors(page);
  await page.goto(`${fixture.url}?locale=${locale}&${query}`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const reload = async () => {
  await page.waitForLoadState("load");
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const review = `sec=approvals&id=${FIXTURE_VERSIONS.rueckruf3}`;
const main = () => page.locator("main");
const button = (name: string) => main().getByRole("button", { name, exact: true }).filter({ visible: true });
const tab = (name: string) =>
  main()
    .getByRole("navigation", { name: "Ansichten" })
    .getByRole("link", { name: new RegExp(`^${name}\\b`) });

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

test("every section keeps the v2 rules at every width, the worst case included, with no loader in the first picture", async () => {
  const paths = [
    "sec=approvals",
    review,
    `${review}&tab=code`,
    "sec=approvals&tab=decided",
    "sec=code",
    "sec=code&id=c_rechn",
    "sec=code&id=c_portal",
    "sec=policy",
    "sec=groups",
    "sec=groups&id=66666666-6666-4666-8666-666666666666",
    "sec=effective&id=33333333-3333-4333-8333-333333333333",
    "sec=history",
    "sec=cleanup",
    "sec=databases",
    "sec=limits",
    "sec=runners",
    "sec=approvals&state=worst",
    `${review}&state=worst`,
    "sec=code&state=worst",
    "sec=code&id=c_anfrag&state=worst",
    "sec=groups&state=worst",
    "sec=databases&state=worst",
    "sec=runners&state=worst",
    "sec=code&state=huge",
  ];
  for (const path of paths)
    for (const width of [1440, 1024, 390]) {
      await goto(path, { width, height: 900 });
      // The code field, the line threads and the Code page's refusal notice are @k2b/ui v1 inside a Canvas (k2b-ui gaps).
      const problems = (await measureV2Layout(page, { root: "main.k2-ui", skip: '[data-k2-part="Canvas"]' })).problems;
      expect({ path, width, problems }).toEqual({ path, width, problems: [] });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
}, 240_000);

test("the sections stand nested under Code in the admin bar, with the waiting approvals counted and the open one current", async () => {
  await goto("sec=code");
  const nav = page.locator('[data-k2-part="Nav"]').first();
  for (const label of [
    "Freigaben",
    "Alle Automationen",
    "Richtlinie",
    "Gruppen",
    "Wirksame Rechte",
    "Verlauf",
    "Aufräumen",
    "Datenbanken",
    "Grenzen",
    "Runner",
  ])
    await nav.getByRole("link", { name: new RegExp(`^${label}`) }).waitFor();
  expect(await nav.getByRole("link", { name: /^Freigaben/ }).innerText()).toContain("4");
  expect(await nav.getByRole("link", { name: /^Alle Automationen/ }).getAttribute("aria-current")).toBe("page");
  // The notification links still land on the open entry.
  await goto(`sec=approvals&id=${FIXTURE_VERSIONS.rueckruf3}`);
  await main().getByText("Version 3 von Rückruf bestätigen freigeben?").waitFor();
  await goto("sec=code&id=c_rechn");
  await main().getByText("Eine Version wartet auf die Freigabe.", { exact: false }).waitFor();
});

test("switching the review's views keeps the head in place, writes ?tab= without loading, and survives a reload", async () => {
  await goto(review);
  await settled(page);
  const head = await main().getByRole("button", { name: "Version 3 freigeben" }).boundingBox();
  await tab("Code").click();
  await page.locator(".k2b-code-diff").first().waitFor();
  expect(await page.locator(".k2b-code-diff").first().innerText()).toContain("@sdk");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("code");
  // A plain click as a person makes it; Playwright would first scroll the tab into view, which moves the frame itself.
  await tab("Änderungen").dispatchEvent("click", { button: 0 });
  await page.waitForURL(/tab=diff/);
  await settled(page);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("diff");
  expect(await main().getByRole("button", { name: "Version 3 freigeben" }).boundingBox()).toEqual(head);
  expect(fixture.requests).toEqual([]);
  await page.reload();
  await reload();
  expect(await tab("Änderungen").getAttribute("aria-current")).toBeTruthy();
  // The first version has nothing to compare: no changes view.
  await goto(`sec=approvals&id=${FIXTURE_VERSIONS.lieferzeit1}`);
  expect(await tab("Änderungen").count()).toBe(0);
});

test("the + at a line comments on that line, and the focus returns to it", async () => {
  await goto(`${review}&tab=code`);
  await settled(page);
  await page.getByRole("button", { name: "Kommentar zu Zeile 4", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Kommentar zu Zeile 4 …" });
  await field.fill("Warum alle 15 Minuten?");
  await page.locator(".core-code-review__thread").filter({ has: field }).getByRole("button", { name: "Kommentieren" }).click();
  await page.getByText("Warum alle 15 Minuten?", { exact: true }).waitFor();
  expect(fixture.requests.at(-1)).toMatchObject({
    path: "comments/create",
    body: { codeId: "c_rueck", versionId: FIXTURE_VERSIONS.rueckruf3, path: "code.ts", line: 4, body: "Warum alle 15 Minuten?" },
  });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Kommentar zu Zeile 4");
});

test("a failed reply keeps its text with Try again, and only the author deletes", async () => {
  await goto(`${review}&tab=diff&state=commentfail`);
  await settled(page);
  const thread = page.locator(".core-code-review__thread").filter({ hasText: "Hier bekommt jede ungelesene Mail" });
  const field = thread.getByRole("textbox", { name: "Antworten …" });
  await field.click();
  await field.fill("Gut, dann so.");
  await thread.getByRole("button", { name: "Kommentieren" }).click();
  await thread.getByText("Nicht gespeichert. Dein Text bleibt hier.").waitFor();
  expect(await field.inputValue()).toBe("Gut, dann so.");
  expect(await thread.getByRole("button", { name: "Kommentar löschen" }).count()).toBe(1);
});

test("requesting changes asks for a text that names who gets it, keeps the draft, and sends the outcome", async () => {
  await goto(review);
  await settled(page);
  await button("Ablehnen / ändern").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Lea Muster bekommt deine Nachricht.", { exact: false }).waitFor();
  await dialog.getByText("3 Kommentare am Code gehen mit.").waitFor();
  for (const name of ["Ablehnen …", "Änderungen anfordern …"])
    expect(await dialog.getByRole("radio", { name, exact: true }).count()).toBe(1);
  await dialog.getByRole("button", { name: "Änderungen anfordern" }).click();
  await dialog.getByText("Schreib kurz, was sich ändern soll.").waitFor();
  expect(fixture.requests).toEqual([]);
  await dialog.getByRole("textbox").fill("Bitte nur Rückrufwünsche.");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await button("Ablehnen / ändern").click();
  expect(await page.getByRole("dialog").getByRole("textbox").inputValue()).toBe("Bitte nur Rückrufwünsche.");
  await page.getByRole("dialog").getByRole("button", { name: "Änderungen anfordern" }).click();
  await reload();
  await main().getByText("Jana Probe hat Änderungen an Version 3 angefordert.").waitFor();
  expect(fixture.requests).toEqual([
    {
      path: "decide",
      body: {
        binding: fixtureApprovalDetail().binding,
        approved: false,
        outcome: "changes_requested",
        comment: "Bitte nur Rückrufwünsche.",
      },
    },
  ]);
  // Decided: comments are frozen.
  await tab("Code").click();
  expect(await page.getByRole("button", { name: "Kommentar zu Zeile 4", exact: true }).count()).toBe(0);
});

test("a refused decision keeps the dialog with its text; approving sends the binding and reloads into the result", async () => {
  await goto(`${review}&state=dialogfail`);
  await button("Ablehnen / ändern").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Ablehnen …", exact: true }).click();
  await dialog.getByRole("textbox").fill("Nicht bei uns.");
  await dialog.getByRole("button", { name: "Version 3 ablehnen" }).click();
  await dialog.getByText("Nicht entschieden. Dein Text bleibt hier.", { exact: false }).waitFor();
  expect(await dialog.getByRole("textbox").inputValue()).toBe("Nicht bei uns.");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  fixture.reset();
  await goto(review);
  await button("Version 3 freigeben").click();
  await reload();
  await main().getByText("Du hast Version 3 freigegeben.", { exact: false }).waitFor();
  expect(fixture.requests).toEqual([
    { path: "decide", body: { binding: fixtureApprovalDetail().binding, approved: true, outcome: "approved" } },
  ]);
  // The waiting count of the admin bar drops with it.
  expect(
    await page
      .locator('[data-k2-part="Nav"]')
      .first()
      .getByRole("link", { name: /^Freigaben/ })
      .innerText(),
  ).toContain("3");
});

test("a lost answer leaves only Check state; a conflict and a withdrawal say what happened", async () => {
  await goto(`${review}&state=lost`);
  await button("Version 3 freigeben").click();
  await main().getByText("Cloud weiß noch nicht, ob deine Entscheidung zu Version 3 gespeichert ist.").waitFor();
  await button("Stand prüfen").waitFor();
  expect(await button("Version 3 freigeben").count()).toBe(0);
  await goto(`${review}&state=conflict`);
  await button("Version 3 freigeben").click();
  await reload();
  await main().getByText("Jana Probe hat Version 3 inzwischen entschieden.").waitFor();
  fixture.reset();
  await goto(`${review}&state=gone`);
  await button("Version 3 freigeben").click();
  await reload();
  await main().getByText("Version 3 wurde inzwischen zurückgezogen.", { exact: false }).waitFor();
});

test("an outdated, own or unloaded version cannot be approved and says why", async () => {
  await goto(`${review}&state=newer`);
  await main().getByText("Lea Muster hat Version 4 eingereicht.").waitFor();
  expect(await button("Version 3 freigeben").isDisabled()).toBe(true);
  expect(await main().getByRole("link", { name: "Version 4 prüfen" }).getAttribute("href")).toMatch(/a0000000-0000-4000-8000-000000000004/);
  await goto(`${review}&state=own`);
  await main().getByText("Du hast diese Version geschrieben.").waitFor();
  expect(await button("Version 3 freigeben").isDisabled()).toBe(true);
  await goto(`${review}&state=sole`);
  expect(await button("Version 3 freigeben").isEnabled()).toBe(true);
  await goto(`${review}&state=difffail&tab=code`);
  expect(await button("Version 3 freigeben").isDisabled()).toBe(true);
});

for (const [code, german] of [
  ["SELF_APPROVAL", "Bitte diesen Admin um die Freigabe"],
  ["REAUTHENTICATE", "aus den letzten zehn Minuten"],
  ["REJECT_ONLY", "Öffne diese Version in Cloud im Browser"],
  ["NOT_FOUND", "für dieses Konto nicht mehr verfügbar"],
  ["UNAVAILABLE", "Cloud kann Versionsentscheidungen gerade nicht verarbeiten"],
] as const)
  test(`a refused approval (${code}) says why in place and offers its way out`, async () => {
    await goto(`${review}&decisionRefusal=${code}${code === "REAUTHENTICATE" ? "&state=sole" : ""}`);
    await button("Version 3 freigeben").click();
    await main().getByText(german, { exact: false }).waitFor();
    if (code === "REAUTHENTICATE") await main().getByRole("link", { name: "Erneut anmelden" }).first().waitFor();
    if (code === "NOT_FOUND") await main().getByRole("link", { name: "Zurück zur Liste" }).first().waitFor();
  });

test("a review opens as its own page on the phone, with the way back to the list", async () => {
  await goto(review, { width: 390, height: 844 });
  await main().getByText("Version 3 von Rückruf bestätigen freigeben?").waitFor();
  const back = main().getByRole("link", { name: "Freigaben" }).filter({ visible: true }).first();
  expect(await back.getAttribute("href")).toBe("/admin/code?sec=approvals");
  // The approval floats as the page's one main action.
  await main().getByRole("button", { name: "Version 3 freigeben" }).filter({ visible: true }).first().waitFor();
  await back.click();
  await reload();
  await main().getByText("4 Freigaben warten").waitFor();
});

test("a policy change names what changes and what pauses before saving, and saves at the read revision", async () => {
  await goto("sec=policy");
  await settled(page);
  await main().getByRole("combobox", { name: "Für andere sichtbar" }).click();
  await page.getByRole("option", { name: "Automatisch" }).click();
  await main().getByText("3 Automationen werden pausiert, bis du ihre Version freigibst:", { exact: false }).waitFor();
  await main().getByText("geändert · vorher Admin gibt frei", { exact: false }).waitFor();
  await button("Speichern und 3 pausieren").click();
  await page.getByText("Gespeichert.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 7, definition: { preset: "custom" } });
  expect(JSON.stringify(update?.body)).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
});

test("a concurrent policy change keeps my change and rechecks it on the newer revision", async () => {
  await goto("sec=policy&state=conflict");
  await main().getByRole("combobox", { name: "Für andere sichtbar" }).click();
  await page.getByRole("option", { name: "Automatisch" }).click();
  await main().getByText("Ein anderer Admin hat die Richtlinie inzwischen geändert.").waitFor();
  await button("Meine Änderung neu prüfen").click();
  await button("Speichern und 3 pausieren").click();
  await page.getByText("Gespeichert.").waitFor();
  const saved = JSON.stringify(fixture.requests.find((request) => request.path === "policy/update")?.body);
  expect(saved).toContain('"revision":9');
  expect(saved).toContain('{"groupId":null,"row":"internet","value":"automatic"}');
});

test("a refused policy save keeps the change; a lost answer only offers Check state", async () => {
  await goto("sec=policy&state=savefail");
  await main().getByRole("combobox", { name: "Für andere sichtbar" }).click();
  await page.getByRole("option", { name: "Automatisch" }).click();
  await button("Speichern und 3 pausieren").click();
  await main().getByText("Cloud hat die Änderung abgelehnt.").waitFor();
  await button("Erneut speichern").click();
  await page.getByText("Gespeichert.").waitFor();
  await goto("sec=policy&state=lost");
  await main().getByRole("combobox", { name: "Für andere sichtbar" }).click();
  await page.getByRole("option", { name: "Automatisch" }).click();
  await button("Speichern und 3 pausieren").click();
  await main().getByText("Cloud weiß noch nicht, ob die Richtlinie gespeichert ist.").waitFor();
  await button("Stand prüfen").waitFor();
});

test("choosing a group opens its rules by address", async () => {
  await goto("sec=groups");
  await button("Gruppe hinzufügen").click();
  await page.getByRole("dialog").getByRole("combobox").or(page.getByRole("dialog").getByRole("searchbox")).first().waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Abbrechen" }).click();
  await main()
    .getByRole("link", { name: /Buchhaltung/ })
    .first()
    .click();
  await reload();
  expect(new URL(page.url()).searchParams.get("id")).toBe("66666666-6666-4666-8666-666666666666");
  await main().getByText("Wie Standard", { exact: false }).first().waitFor();
});

test("filtering all automations writes the address with the old parameter names and loads that list", async () => {
  await goto("sec=code");
  await button("Filter").click();
  await page
    .getByRole("menuitem", { name: /Status/ })
    .or(page.getByRole("option", { name: /Status/ }))
    .first()
    .click();
  await page.getByRole("option", { name: "Pausiert" }).click();
  await page.waitForURL(/status=paused/);
  await reload();
  expect(new URL(page.url()).searchParams.get("sec")).toBe("code");
  await main().getByText("Lieferschein bei Abschluss").first().waitFor();
  expect(await main().getByText("Anfragen sortieren").count()).toBe(0);
});

test("a Cloud admin pauses any automation from its detail, and a refused resume says why", async () => {
  await goto("sec=code&id=c_rechn");
  await button("Pausieren").click();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Pausieren" }).click(),
  ]);
  expect(fixture.requests).toEqual([{ path: "pause", body: { codeId: "c_rechn", paused: true } }]);
  await goto("sec=code&id=c_woche&state=savefail");
  await button("Fortsetzen").click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Fortsetzen" }).click();
  await main().getByText("braucht unter der aktuellen Richtlinie eine neue Freigabe", { exact: false }).waitFor();
});

test("deleting an unused database asks first, cancelling keeps it, and a confirmed delete binds the shown incarnation", async () => {
  await goto("sec=databases");
  const remove = button("Jetzt löschen").first();
  await remove.click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  expect(await confirm.textContent()).toContain("endgültig löschen");
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect(fixture.requests).toHaveLength(0);
  await remove.click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await button("Neu laden").first().waitFor();
  expect(fixture.requests).toEqual([
    {
      path: "/api/code/authoring/database/delete",
      body: { codeId: "c_rueck", namespace: "code_c_rueck_fixture", since: "2026-11-01T12:00:00.000Z" },
    },
  ]);
  await goto("sec=databases&state=lost");
  await button("Jetzt löschen").first().click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await button("Neu laden").first().waitFor();
});

test("the huge Cloud keeps its pages bounded: one page of rows with Load more, ready at once", async () => {
  const started = Date.now();
  await goto("sec=code&state=huge");
  const ready = Date.now() - started;
  expect(await main().getByRole("row").count()).toBeLessThanOrEqual(21);
  await main().getByRole("link", { name: "Weitere laden" }).waitFor();
  await main().getByText("25.000 Automationen von 640 Besitzern").waitFor();
  expect(ready).toBeLessThan(5000);
});
