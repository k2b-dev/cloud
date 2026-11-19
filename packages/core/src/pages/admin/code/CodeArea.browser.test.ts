import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { codeAreaBrowserFixture } from "./CodeArea.browser-fixture";
import { FIXTURE_PEOPLE, FIXTURE_VERSIONS, fixtureApprovalDetail } from "./CodeArea.fixture-data";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof codeAreaBrowserFixture>>;
let page: Page;
let errors: string[] = [];
const goto = async (query: string, viewport = { width: 1440, height: 1000 }, locale = "de") => {
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
  await page.goto(`${fixture.url}?locale=${locale}&${query}`);
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

/** Position and size of every selected element, to prove a change moved nothing. */
const boxes = (selectors: string[]) =>
  page.evaluate(
    (list) =>
      list.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return `${selector}: missing`;
        const box = element.getBoundingClientRect();
        return `${selector}: ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`;
      }),
    selectors,
  );
const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}\\b`) });

test("an approval keeps its version in one line next to a long title, on a wide screen and a phone", async () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 780 },
  ]) {
    await goto("sec=approvals&state=long", viewport);
    await settled(page);
    const versions = await page.locator(".core-code-approvals__version").evaluateAll((elements) =>
      elements.map((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return { text: element.textContent, lines: Math.round(element.getBoundingClientRect().height / lineHeight) };
      }),
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions)
      expect({ ...version, viewport: viewport.width }).toEqual({ ...version, lines: 1, viewport: viewport.width });
  }
}, 30_000);

test("approval rows give each column the width it needs: changes stay whole, columns line up, nothing overlaps", async () => {
  /** Per row: lines of the title and of the main change, where the change starts, and whether parts overlap. */
  const measure = () =>
    page.locator(".core-code-approvals__row").evaluateAll((elements) =>
      elements.map((row) => {
        const lines = (element: Element | null) => {
          if (!element) return 0;
          const height = Number.parseFloat(getComputedStyle(element).lineHeight);
          return Math.round(element.getBoundingClientRect().height / height);
        };
        const parts = [".core-code-approvals__what", ".core-code-approvals__change", ".core-code-approvals__when"].map((selector) =>
          row.querySelector(selector)!.getBoundingClientRect(),
        );
        const overlaps = parts.some((box, index) =>
          parts.some(
            (other, otherIndex) =>
              otherIndex > index &&
              box.left < other.right - 1 &&
              other.left < box.right - 1 &&
              box.top < other.bottom - 1 &&
              other.top < box.bottom - 1,
          ),
        );
        return {
          title: lines(row.querySelector(".core-code-approvals__title")),
          change: lines(row.querySelector(".core-code-approvals__main span")),
          changeLeft: Math.round(parts[1]!.left),
          overlaps,
        };
      }),
    );
  // The walkthrough's title is longer than its row's share: it wraps alone, every change sentence stays one line.
  await goto("sec=approvals&state=long", { width: 1440, height: 900 });
  await settled(page);
  const wide = await measure();
  expect(wide.map((row) => row.change)).toEqual(wide.map(() => 1));
  expect(new Set(wide.map((row) => row.changeLeft)).size).toBe(1);
  expect(wide.some((row) => row.overlaps)).toBe(false);
  // Decided: short chips leave the title the width it needs.
  await goto("sec=approvals&tab=decided&state=long", { width: 1440, height: 900 });
  await settled(page);
  expect((await measure()).map((row) => row.title)).toEqual([1, 1, 1]);
  // Beside the two navigation columns the list is narrow; it stacks instead of squeezing a column.
  for (const width of [780, 1024, 1180]) {
    await goto("sec=approvals&state=long", { width, height: 900 });
    await settled(page);
    expect({ width, overlaps: (await measure()).some((row) => row.overlaps) }).toEqual({ width, overlaps: false });
  }
}, 60_000);

test("the area without a section shows the approvals next to the area column, and only the area on a phone", async () => {
  await goto("");
  expect(await page.getByRole("heading", { name: "Freigaben" }).first().isVisible()).toBe(true);
  expect(await page.locator(".core-code-approvals__row").first().isVisible()).toBe(true);
  await goto("", { width: 390, height: 780 });
  expect(await page.locator(".core-code-approvals__row").first().isVisible()).toBe(false);
  expect(
    await page
      .getByRole("link", { name: /Freigaben/ })
      .first()
      .isVisible(),
  ).toBe(true);
}, 30_000);

test("a review shows both decision paths and the change list directly", async () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 780 },
  ]) {
    await goto(review, viewport);
    await settled(page);
    expect(await scrolled()).toEqual([]);
    expect(await page.getByRole("tablist").count()).toBe(1);
    for (const name of ["Übersicht", "Code", "Diff"]) expect(await tab(name).count()).toBe(1);
    await page.getByText("Sie darf etwas tun, das andere sehen.", { exact: false }).waitFor();
    expect(await page.locator(".cloud-approval-frame").first().getByRole("button").count()).toBe(2);
    expect(await page.getByRole("button", { name: "Alles ansehen", exact: true }).count()).toBe(0);
    await page.getByRole("heading", { name: "Was sich gegenüber Version 2 ändert" }).waitFor();
    await page
      .getByRole("button", { name: viewport.width === 390 ? "Ablehnen / ändern" : "Ablehnen oder ändern …", exact: true })
      .first()
      .click();
    for (const name of ["Ablehnen …", "Änderungen anfordern …"])
      expect(await page.getByRole("dialog").getByRole("radio", { name, exact: true }).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    // A phone closes the review with the head's back arrow; the close button shows only beside the columns.
    expect(await page.getByRole("link", { name: "Schließen, zurück zur Liste" }).isVisible()).toBe(viewport.width > 600);
  }
}, 30_000);

test("showing unchanged rows stays expanded across review tab changes", async () => {
  await goto(review);
  await page.getByRole("button", { name: "Anzeigen", exact: true }).click();
  expect(await page.getByRole("button", { name: "Anzeigen", exact: true }).count()).toBe(0);
  await tab("Code").click();
  expect(await page.getByRole("button", { name: "Anzeigen", exact: true }).count()).toBe(0);
  await tab("Übersicht").click();
  expect(await page.getByRole("button", { name: "Anzeigen", exact: true }).count()).toBe(0);
}, 30_000);

test("switching tabs keeps head and tabs in place, writes ?tab= and survives a reload", async () => {
  await goto(review);
  await settled(page);
  const fixed = [".k2b-app-workspace__level-head, header", '[role="tablist"]', '[role="tab"]:nth-of-type(1)'];
  const before = await boxes(fixed);
  await tab("Code").click();
  await page.locator(".k2b-code-diff").first().waitFor();
  // Source remains available in the administrator's dedicated approval review.
  expect(await page.locator(".k2b-code-diff").first().innerText()).toContain("@sdk");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("code");
  expect(await boxes(fixed)).toEqual(before);
  await tab("Diff").click();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("diff");
  expect(fixture.requests).toEqual([]);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  expect(await tab("Diff").getAttribute("aria-selected")).toBe("true");
}, 30_000);

test("the + at a line start comments on that line with one tab stop, keeps the thread's height on send, and returns focus", async () => {
  await goto(`${review}&tab=code`);
  await settled(page);
  const plus = page.getByRole("button", { name: "Kommentar zu Zeile 4", exact: true });
  await plus.click();
  const field = page.getByRole("textbox", { name: "Kommentar zu Zeile 4 …" });
  await field.waitFor();
  await page.getByText("Wird mit deiner Entscheidung sichtbar").waitFor();
  await field.fill("Warum alle 15 Minuten?");
  const thread = page.locator(".core-code-review__thread").filter({ has: field });
  await settled(page);
  const writing = await thread.boundingBox();
  const count = await tab("Code").innerText();
  await thread.getByRole("button", { name: "Kommentieren" }).click();
  await page.getByText("Warum alle 15 Minuten?", { exact: true }).waitFor();
  const sent = await page.locator(".core-code-review__thread").filter({ hasText: "Warum alle 15 Minuten?" }).boundingBox();
  // Measured like the concept: under half a pixel.
  expect(Math.abs((sent?.height ?? 0) - (writing?.height ?? -10))).toBeLessThan(0.5);
  expect(fixture.requests.at(-1)).toMatchObject({
    path: "comments/create",
    body: { codeId: "c_rueck", versionId: FIXTURE_VERSIONS.rueckruf3, path: "code.ts", line: 4, body: "Warum alle 15 Minuten?" },
  });
  expect(await tab("Code").innerText()).not.toEqual(count);
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Kommentar zu Zeile 4");
  // One tab stop: arrow keys carry the real focus from line to line.
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Kommentar zu Zeile 5");
}, 30_000);

test("a reply goes under its thread flush, a failed save keeps the text with Try again, and only the author deletes", async () => {
  await goto(`${review}&tab=diff&state=commentfail`);
  await settled(page);
  const thread = page.locator(".core-code-review__thread").filter({ hasText: "Hier bekommt jede ungelesene Mail" });
  await thread.getByRole("textbox", { name: "Antworten …" }).click();
  const field = thread.getByRole("textbox", { name: "Antworten …" });
  await field.fill("Gut, dann so.");
  await thread.getByRole("button", { name: "Kommentieren" }).click();
  await thread.getByText("Nicht gespeichert. Dein Text bleibt hier.").waitFor();
  expect(await field.inputValue()).toBe("Gut, dann so.");
  await thread.getByRole("button", { name: "Erneut versuchen" }).waitFor();
  // Ben wrote the first comment ("Du"), Jana the reply: only Ben's own entry offers deleting.
  expect(await thread.getByRole("button", { name: "Kommentar löschen" }).count()).toBe(1);
  // Every entry is flush: the avatars share one left edge.
  const edges = await thread
    .locator(".k2b-discussion__avatar")
    .evaluateAll((list) => list.map((item) => Math.round(item.getBoundingClientRect().left)));
  expect(new Set(edges).size).toBe(1);
}, 30_000);

test("an unchanged file in Diff shows its commented lines, and the first version locks Diff", async () => {
  await goto(`${review}&tab=diff`);
  await settled(page);
  await page.getByRole("tab", { name: "code.test.ts", exact: false }).click();
  await page.getByText("Diese Datei ist unverändert.", { exact: false }).waitFor();
  await page.getByText("Reicht der Buchhaltung die Nummer der Aufgabe", { exact: false }).waitFor();
  await goto(`sec=approvals&id=${FIXTURE_VERSIONS.lieferzeit1}`);
  expect(await tab("Diff").isDisabled()).toBe(true);
}, 30_000);

test("requesting changes asks for a text in a dialog that names who gets it, keeps its error line, and sends the outcome", async () => {
  await goto(review);
  await settled(page);
  await page.getByRole("button", { name: "Ablehnen oder ändern …", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText(
      "Lea Muster bekommt deine Nachricht. Gustav überarbeitet die Version danach einmal von selbst. Version 2 bleibt eingeschaltet.",
    )
    .waitFor();
  await dialog.getByText("3 Kommentare am Code gehen mit.").waitFor();
  // The decision dialog is Cloud's administration, not AI: it never carries the approval's AI colour scope.
  expect(await page.evaluate(() => document.querySelector("dialog[open]")?.closest("[data-k2b-primary]") === null)).toBe(true);
  await settled(page);
  const buttons = await dialog.getByRole("button", { name: "Änderungen anfordern" }).boundingBox();
  await dialog.getByRole("button", { name: "Änderungen anfordern" }).click();
  await dialog.getByText("Schreib kurz, was sich ändern soll.").waitFor();
  expect(await dialog.getByRole("button", { name: "Änderungen anfordern" }).boundingBox()).toEqual(buttons);
  expect(fixture.requests).toEqual([]);
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  // The text is kept for the next opening.
  await page.getByRole("button", { name: "Ablehnen oder ändern …", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("textbox").fill("Bitte nur Rückrufwünsche.");
  await page.getByRole("dialog").getByRole("button", { name: "Abbrechen" }).click();
  await page.getByRole("button", { name: "Ablehnen oder ändern …", exact: true }).first().click();
  expect(await page.getByRole("dialog").getByRole("textbox").inputValue()).toBe("Bitte nur Rückrufwünsche.");
  await page.getByRole("dialog").getByRole("button", { name: "Änderungen anfordern" }).click();
  await page.waitForLoadState("load");
  const result = page.locator(".cloud-approval-frame[data-review-result]:visible");
  await result.waitFor();
  expect(await result.locator(".k2b-notice-card__title").innerText()).toBe("Jana Probe hat Änderungen an Version 3 angefordert.");
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
  // Decided: comments are frozen, no "+" and no "Reply".
  await tab("Code").click();
  expect(await page.getByRole("button", { name: "Kommentar zu Zeile 4", exact: true }).count()).toBe(0);
  expect(await page.getByRole("textbox", { name: "Antworten …" }).count()).toBe(0);
}, 30_000);

test("a refused decision keeps the dialog with its text; approving sends the binding and reloads into the result", async () => {
  await goto(`${review}&state=dialogfail`);
  await page.getByRole("button", { name: "Ablehnen oder ändern …", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("radio", { name: "Ablehnen …", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Nicht bei uns.");
  await dialog.getByRole("button", { name: "Version 3 ablehnen" }).click();
  await dialog.getByText("Nicht entschieden. Dein Text bleibt hier.", { exact: false }).waitFor();
  expect(await dialog.getByRole("textbox").inputValue()).toBe("Nicht bei uns.");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  fixture.reset();
  await goto(review);
  expect(await sidebarCode().innerText()).toContain("5");
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.waitForLoadState("load");
  await page.getByText("Du hast", { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-review-result") === true);
  expect(fixture.requests).toEqual([
    { path: "decide", body: { binding: fixtureApprovalDetail().binding, approved: true, outcome: "approved" } },
  ]);
  expect(await sidebarCode().innerText()).toContain("4");
}, 30_000);

test("a lost answer leaves only Check state; a conflict and a withdrawal say what happened", async () => {
  await goto(`${review}&state=lost`);
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.getByText("Cloud weiß noch nicht, ob deine Entscheidung zu Version 3 gespeichert ist.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stand prüfen" }).waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).count()).toBe(0);
  expect(await page.getByText("Erneut versuchen").count()).toBe(0);
  await goto(`${review}&state=conflict`);
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.waitForLoadState("load");
  await page.getByText("Jana Probe hat Version 3 inzwischen entschieden.").waitFor();
  fixture.reset();
  await goto(`${review}&state=gone`);
  await page.getByRole("button", { name: "Version 3 freigeben" }).click();
  await page.waitForLoadState("load");
  await page.getByText("Version 3 wurde inzwischen zurückgezogen.", { exact: false }).waitFor();
}, 30_000);

test("an outdated, own or unloaded version cannot be approved and says why", async () => {
  await goto(`${review}&state=newer`);
  await page.getByText("Lea Muster hat Version 4 eingereicht.").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isDisabled()).toBe(true);
  expect(await page.getByRole("link", { name: "Version 4 prüfen" }).getAttribute("href")).toMatch(/a0000000-0000-4000-8000-000000000004/);
  await goto(`${review}&state=own`);
  await page.getByText("Du hast diese Version geschrieben.").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isDisabled()).toBe(true);
  await goto(`${review}&state=sole`);
  await page.getByText("Du bist der einzige Admin und gibst deine eigene Version frei.").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isEnabled()).toBe(true);
  await goto(`${review}&state=difffail&tab=code`);
  await page.getByText("Der Code konnte nicht geladen werden").waitFor();
  expect(await page.getByRole("button", { name: "Version 3 freigeben" }).isDisabled()).toBe(true);
}, 30_000);

test("a policy change names what changes and what pauses before saving, and saves at the read revision", async () => {
  await goto("sec=policy");
  await settled(page);
  const before = await page.locator('[data-row="read"]').boundingBox();
  await page.getByRole("radiogroup", { name: "Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByText("3 Automationen werden pausiert, bis du ihre Version freigibst:", { exact: false }).waitFor();
  await page.getByText("Lieferschein bei Abschluss", { exact: false }).waitFor();
  await settled(page);
  expect(await page.locator('[data-row="read"]').boundingBox()).toEqual(before);
  expect(await page.locator('[data-row="silent_shared"]').getAttribute("data-changed")).toBe("true");
  await page.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Gespeichert.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 7, definition: { preset: "custom" } });
  expect(JSON.stringify(update?.body)).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
}, 30_000);

test("a concurrent policy change keeps my change, rechecks it on the newer revision and saves both", async () => {
  await goto("sec=policy&state=conflict");
  await page.getByRole("radiogroup", { name: "Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByText("Ein anderer Admin hat die Richtlinie inzwischen geändert.").waitFor();
  await page.getByRole("button", { name: "Meine Änderung neu prüfen" }).click();
  await page.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Gespeichert.").waitFor();
  const update = fixture.requests.find((request) => request.path === "policy/update");
  expect(update?.body).toMatchObject({ revision: 9 });
  const saved = JSON.stringify(update?.body);
  expect(saved).toContain('{"groupId":null,"row":"silent_shared","value":"automatic"}');
  expect(saved).toContain('{"groupId":null,"row":"internet","value":"automatic"}');
}, 30_000);

test("a refused policy save keeps the change; a lost answer only offers Check state", async () => {
  await goto("sec=policy&state=savefail");
  await page.getByRole("radiogroup", { name: "Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Cloud hat die Änderung abgelehnt.").waitFor();
  expect(await page.locator('[data-row="silent_shared"]').getAttribute("data-changed")).toBe("true");
  await page.getByRole("button", { name: "Erneut speichern" }).click();
  await page.getByText("Gespeichert.").waitFor();
  await goto("sec=policy&state=lost");
  await page.getByRole("radiogroup", { name: "Für andere sichtbar" }).getByRole("radio", { name: "Automatisch" }).click();
  await page.getByRole("button", { name: "Speichern und 3 pausieren" }).click();
  await page.getByText("Cloud weiß noch nicht, ob die Richtlinie gespeichert ist.").waitFor();
  await page.getByRole("button", { name: "Stand prüfen" }).waitFor();
  expect(await page.getByText("Cloud hat die Änderung abgelehnt.").count()).toBe(0);
}, 30_000);

test("the policy table is one radio group per row with arrow keys, and asking rows always need a person", async () => {
  await goto("sec=policy");
  const group = page.getByRole("radiogroup", { name: "KI-Nutzung" });
  await group.getByRole("radio", { checked: true }).focus();
  const start = await group.getByRole("radio", { checked: true }).getAttribute("aria-label");
  await page.keyboard.press("ArrowRight");
  expect(await group.getByRole("radio", { checked: true }).getAttribute("aria-label")).not.toBe(start);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"))).toBe("true");
  expect(await page.locator('[data-row^="ask_"]').count()).toBe(0);
  await page.getByText("Braucht immer einen Menschen").waitFor();
  expect(await page.getByText("silent: shared").count()).toBe(0);
}, 30_000);

test("a Cloud admin pauses any Code from its detail, and a refused resume says why", async () => {
  await goto("sec=code&id=c_rechn");
  await page.getByRole("button", { name: "Pausieren" }).click();
  // Confirmation dispatches asynchronously. Wait for its reload, rather than the old document's completed load.
  await Promise.all([page.waitForEvent("load"), page.getByRole("dialog").getByRole("button", { name: "Pausieren" }).click()]);
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

test("unused database delete requires confirmation and cancelling preserves the database on a phone", async () => {
  await goto("sec=databases", { width: 390, height: 844 });
  await settled(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const actionBox = await page.getByRole("button", { name: "Jetzt löschen", exact: true }).boundingBox();
  expect(actionBox !== null && actionBox.x >= 0 && actionBox.x + actionBox.width <= 390).toBe(true);
  await page.getByRole("button", { name: "Ausgeblendete Werte der Zeile zeigen" }).click();
  expect(await page.getByText("Lea Muster", { exact: true }).filter({ visible: true }).isVisible()).toBe(true);
  await page.getByRole("button", { name: "Ausgeblendete Werte der Zeile zeigen" }).click();
  const remove = page.getByRole("button", { name: "Jetzt löschen", exact: true });
  await remove.click();
  const dialog = page.getByRole("dialog");
  expect(await dialog.textContent()).toContain("endgültig löschen");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect(fixture.requests).toHaveLength(0);
});

test("confirmed unused database deletion binds the shown incarnation and keeps its geometry on a phone", async () => {
  await goto("sec=databases", { width: 390, height: 844 });
  await settled(page);
  const row = page.getByRole("row").filter({ has: page.locator('a[href="/admin/code?sec=code&id=c_rueck"]') });
  const before = await row.boundingBox();
  const remove = page.getByRole("button", { name: "Jetzt löschen", exact: true });
  await remove.click();
  await page.getByRole("dialog").getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await page.getByText("Löschung beauftragt.", { exact: false }).waitFor();
  expect((await row.boundingBox())?.height).toBe(before?.height);
  expect(fixture.requests).toEqual([
    {
      path: "/api/code/authoring/database/delete",
      body: { codeId: "c_rueck", namespace: "code_c_rueck_fixture", since: "2026-11-01T12:00:00.000Z" },
    },
  ]);
  expect(await page.getByRole("button", { name: "Jetzt löschen", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Neu laden", exact: true }).isVisible()).toBe(true);
});

test("an unconfirmed unused database deletion keeps recovery visible", async () => {
  await goto("sec=databases&state=lost");
  await page.getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  await page.getByText("Löschung unbestätigt.", { exact: false }).waitFor();
  expect(await page.getByRole("button", { name: "Jetzt löschen", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Neu laden", exact: true }).isVisible()).toBe(true);
});

test("unused database pending deletion stays disabled and keeps its geometry in dark mode", async () => {
  await goto("sec=databases&state=saving&theme=dark", { width: 390, height: 844 });
  await settled(page);
  const remove = page.getByRole("button", { name: "Jetzt löschen", exact: true });
  const before = await remove.boundingBox();
  await remove.click();
  await page.getByRole("dialog").getByRole("button", { name: "Jetzt löschen", exact: true }).click();
  expect(await remove.isDisabled()).toBe(true);
  await settled(page);
  expect(await remove.boundingBox()).toEqual(before);
  expect(fixture.requests).toHaveLength(1);
});

for (const locale of ["en", "de"] as const) {
  for (const [code, english, german] of [
    ["SELF_APPROVAL", "Ask that admin to approve it", "Bitte diesen Admin um die Freigabe"],
    ["REAUTHENTICATE", "from the last ten minutes", "aus den letzten zehn Minuten"],
    ["REJECT_ONLY", "Open this version in Cloud in your browser", "Öffne diese Version in Cloud im Browser"],
    ["NOT_FOUND", "no longer available to this account", "für dieses Konto nicht mehr verfügbar"],
    ["BUSY", "Busy right now – try again in a moment", "Gerade beschäftigt – gleich nochmal versuchen"],
    ["UNAVAILABLE", "Cloud cannot handle version decisions right now", "Cloud kann Versionsentscheidungen gerade nicht verarbeiten"],
  ] as const) {
    test(`the approval explains ${code} in ${locale} and offers recovery`, async () => {
      const query = `${review}&decisionRefusal=${code}${code === "REAUTHENTICATE" ? "&state=sole" : ""}`;
      await goto(query, { width: 390, height: 844 }, locale);
      await settled(page);
      const frame = page.locator(".cloud-approval-frame:visible").first();
      const before = await frame.boundingBox();
      const confirm = frame.getByRole("button", { name: locale === "de" ? "Version 3 freigeben" : "Approve version 3", exact: true });
      const buttonBefore = await confirm.boundingBox();
      await confirm.click();
      await page.getByText(locale === "de" ? german : english, { exact: false }).waitFor();
      if (code === "BUSY") {
        expect(await page.locator("#code-review-failure").count()).toBe(0);
        expect(
          await frame
            .getByRole("alert")
            .filter({ hasText: locale === "de" ? german : english })
            .textContent(),
        ).toContain(locale === "de" ? german : english);
        expect(await frame.boundingBox()).toEqual(before);
        const retry = frame.getByRole("button", { name: locale === "de" ? "Version 3 freigeben" : "Approve version 3", exact: true });
        expect(await retry.boundingBox()).toEqual(buttonBefore);
        expect(await retry.isEnabled()).toBe(true);
        await retry.click();
        await page.getByText(locale === "de" ? german : english, { exact: false }).waitFor();
        expect(fixture.requests.filter((request) => request.path === "decide")).toHaveLength(2);
        expect(await frame.boundingBox()).toEqual(before);
        return;
      }
      await page.waitForFunction(() => document.activeElement?.id === "code-review-failure");
      expect(await page.locator("#code-review-failure").evaluate((element) => element.getBoundingClientRect().top >= 0)).toBe(true);
      expect(await page.getByText(code, { exact: false }).count()).toBe(0);
      expect(await page.getByText("Private transport diagnostic", { exact: false }).count()).toBe(0);
      if (code === "REAUTHENTICATE") {
        const href = await page
          .getByRole("link", { name: locale === "de" ? "Erneut anmelden" : "Sign in again", exact: true })
          .getAttribute("href");
        const url = new URL(href!, fixture.url);
        expect(url.pathname).toBe("/auth/login");
        expect(url.searchParams.get("method")).toBeNull();
        expect(url.searchParams.get("redirectTo")).toBe(`/admin/code?locale=${locale}&${query}&reauthenticate=1`);
        await page
          .getByRole("button", { name: locale === "de" ? "Abmelden und Admin-Token nutzen" : "Sign out and use admin token" })
          .waitFor();
      } else {
        await page.getByRole("button", { name: locale === "de" ? "Neu laden" : "Reload", exact: true }).waitFor();
        if (code === "NOT_FOUND")
          expect(
            await page
              .getByRole("link", { name: locale === "de" ? "Zurück zur Liste" : "Back to the list", exact: true })
              .getAttribute("href"),
          ).toBe("/admin/code?sec=approvals");
      }
      expect(await page.getByRole("button", { name: locale === "de" ? "Version 3 freigeben" : "Approve version 3" }).isEnabled()).toBe(
        true,
      );
    }, 20_000);
  }
}

for (const locale of ["en", "de"] as const) {
  for (const status of [200, 409, 503]) {
    test(`emergency sign-in recovery in ${locale} waits for account-bound sign-out (${status})`, async () => {
      const query = `${review}&decisionRefusal=REAUTHENTICATE&state=sole`;
      await goto(`${query}&reauthenticate=1`, { width: 390, height: 844 }, locale);
      expect(new URL(page.url()).searchParams.has("reauthenticate")).toBe(false);
      const logouts: string[] = [];
      await page.route("**/api/auth/logout", (route) => {
        logouts.push(route.request().headers()["x-cloud-logout-user"] ?? "");
        return route.fulfill({ status, contentType: "application/json", body: "{}" });
      });
      await page.route("**/auth/login?**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><head><meta name="view-transition" content="same-origin"><style>@view-transition { navigation: auto; }</style></head><body>Admin token sign-in fixture</body></html>',
        }),
      );
      await page.getByRole("button", { name: locale === "de" ? "Version 3 freigeben" : "Approve version 3" }).click();
      const recover = page.getByRole("button", {
        name: locale === "de" ? "Abmelden und Admin-Token nutzen" : "Sign out and use admin token",
      });
      await recover.click();
      if (status === 200) {
        await page.getByText("Admin token sign-in fixture", { exact: true }).waitFor();
        const url = new URL(page.url());
        expect(url.pathname).toBe("/auth/login");
        expect(url.searchParams.get("method")).toBe("admin");
        expect(url.searchParams.get("redirectTo")).toBe(`/admin/code?locale=${locale}&${query}`);
        expect(url.searchParams.get("redirectTo")).not.toContain("reauthenticate");
      } else {
        await page
          .getByRole("alert")
          .getByText(locale === "de" ? "Das Abmelden konnte nicht abgeschlossen werden." : "Could not finish signing out.", {
            exact: false,
          })
          .waitFor();
        expect(new URL(page.url()).pathname).toBe("/admin/code");
        expect(await recover.isEnabled()).toBe(true);
        expect(await page.locator("#code-review-failure p p").count()).toBe(0);
        await Promise.all([
          page.waitForEvent("load"),
          page.getByRole("button", { name: locale === "de" ? "Neu laden" : "Reload", exact: true }).click(),
        ]);
        await page.waitForSelector('body[data-ready="true"]');
        expect(await page.locator("#code-review-failure").count()).toBe(0);
      }
      expect(logouts).toEqual([FIXTURE_PEOPLE.ben]);
    }, 20_000);
  }
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`approval recovery retains its frame and decision text at ${width}px in ${theme}`, async () => {
      const viewport = { width, height: width === 390 ? 780 : 900 };
      const capture = async (state: string) => {
        const directory = process.env.APPROVAL_RECOVERY_SHOTS;
        if (!directory) return;
        mkdirSync(directory, { recursive: true });
        await settled(page);
        await page.screenshot({ path: resolve(directory, `admin-${state}-${theme}-${width}.png`), fullPage: true });
      };
      await goto(`${review}&state=dialogfail&theme=${theme}`, viewport);
      await page
        .getByRole("button", { name: width === 390 ? "Ablehnen / ändern" : "Ablehnen oder ändern …", exact: true })
        .first()
        .click();
      await capture("decision-dialog");
      await page.getByRole("dialog").getByRole("radio", { name: "Ablehnen …", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").fill("Nicht bei uns.");
      await dialog.getByRole("button", { name: "Version 3 ablehnen" }).click();
      await dialog.getByText("Nicht entschieden. Dein Text bleibt hier.", { exact: false }).waitFor();
      expect(await dialog.getByRole("textbox").inputValue()).toBe("Nicht bei uns.");
      await capture("answer-failed");
      fixture.reset();
      await goto(`${review}&state=lost&theme=${theme}`, viewport);
      await settled(page);
      const frame = () => page.locator(".cloud-approval-frame:visible").first();
      const before = await frame().boundingBox();
      await frame().getByRole("button", { name: "Version 3 freigeben" }).click();
      await page.getByText("Cloud weiß noch nicht, ob deine Entscheidung zu Version 3 gespeichert ist.", { exact: true }).waitFor();
      await frame().getByRole("button", { name: "Stand prüfen" }).waitFor();
      await settled(page);
      expect(await frame().boundingBox()).toEqual(before);
      expect(await frame().getByRole("button", { name: "Erneut versuchen" }).count()).toBe(0);
      await capture("unknown");
    }, 45_000);
