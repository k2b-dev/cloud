import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { describeV2 } from "./describe";

// describeV2 is the cheap view an agent reads before a screenshot: it must name every part of the fixtures and the
// problems a person would see, from server markup without layout.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-describe-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
const { fixtures } = await import("../../test/v2-fixtures");
const { Fixture: StatesFixture } = await import("../../test/v2-states-navigation.fixture");

const windows: Window[] = [];
afterAll(async () => {
  for (const window of windows) await window.happyDOM.close();
  rmSync(root, { recursive: true, force: true });
});

const outline = (markup: string) => {
  const window = new Window();
  windows.push(window);
  window.document.body.innerHTML = `<div class="k2-ui">${markup}</div>`;
  return describeV2(window.document.body.firstElementChild as unknown as Element);
};
const fixture = (name: keyof typeof fixtures) => outline(renderToString(() => createComponent(fixtures[name], {})));

describe("describeV2", () => {
  test("outlines the mail fixture part by part", () => {
    const text = fixture("layout");
    expect(text).toContain('Workspace (sidebar, head) primary "Neu"');
    expect(text).toContain('Nav "Mail": 4 entries, current "Posteingang"');
    expect(text).toContain('head: Bar: Tabs "Ansichten": Alle (42) ✓, Handlungsbedarf (5) | ["Neue Nachricht" primary]');
    expect(text).toContain('status: StatusRow "7 ungelesen" · Heute 12 erledigt select-all');
    expect(text).toContain('List "Nachrichten": 4 entries');
    expect(text).toContain("… 1 more");
    expect(text).toContain('Notice ai "Kurz gesagt": "Brandt liefert 14 Eichenplatten in KW 49." ["Bearbeiten" text]');
    expect(text).toContain("Cells: Offen = 12 · Heute erledigt = 31 · Geld = 532,30 €");
    // the way back of the open detail, a part of its own
    expect(text).toContain('Back "Posteingang" link');
    expect(text).not.toContain("Problems");
  });

  test("outlines sections, groups, a folded group, a table and facts", () => {
    const text = fixture("structure");
    expect(text).toContain('head: Tabs "Bereiche": Überblick ✓, Geld (12)');
    expect(text).toContain('Entry 3. Nov. "EL-2611-00009" (Läuft)');
    expect(text).toContain('Section "Anstehend" (2) ["Todo anlegen" text]');
    expect(text).toContain('Group "EL-2611-00009" (18) · angekommen 3. Nov. · Post (Läuft · ok) ["Öffnen" text]');
    expect(text).toContain('Group "EL-2609-00017" folded · ausgezahlt am 12. Nov.');
    expect(text).toContain('Steps "Weg der Einlieferung": Angekommen done → Ausgelaufen now → Ausgezahlt next');
    expect(text).toContain('Table "Abrechnung" 3 columns × 2 rows: Auslauftag, Abrechnung, Auszahlung (end)');
    expect(text).toContain('Canvas "Karte" 176px (free drawing, not measured)');
    expect(text).not.toContain("Problems");
  });

  test("outlines a large table with selection, groups and a path", () => {
    const text = fixture("grid");
    expect(text).toContain("head: Bar: Path: Werkstatt › Aufträge");
    expect(text).toContain('status: StatusRow selecting "1 ausgewählt": ["Exportieren"] ["Auswahl aufheben" text]');
    expect(text).toContain('Table "Aufträge" 5 columns × 8 rows (select, 2 groups, sticky, phone rows)');
    expect(text).not.toContain('List "Aufträge"');
  });

  test("names fields with their errors and the state of every mark", () => {
    const text = fixture("controls");
    expect(text).toContain('Field "Intervall": Input "30" invalid — error "Mindestens 60 Sekunden."');
    expect(text).toContain('Check "Alle Postfächer" mixed');
    expect(text).toContain('Switch "Aktiv" on');
    expect(text).toContain('Field "Wie oft": Choice: Täglich ✓, Wöchentlich');
  });

  test("reports what no primitive owns, nested groups and a second primary action", () => {
    const text = outline(
      `<section class="k2-pane" data-k2-part="Pane" aria-label="Liste"><div class="k2-scroll">` +
        `<div>frei</div>lose<section class="k2-group" data-k2-part="Group" aria-label="Außen"><div class="k2-gh"></div>` +
        `<section class="k2-group" data-k2-part="Group" aria-label="Innen"><div class="k2-gh"></div></section></section>` +
        `<section class="k2-band" data-k2-part="Band"><section class="k2-group" data-k2-part="Group" aria-label="Im Band"><div class="k2-gh"></div></section></section>` +
        `<button class="k2-btn" data-k2-part="Button" data-variant="primary">Eins</button>` +
        `<div class="k2-bar" data-k2-part="Bar"><div class="k2-bar-end"><button class="k2-btn" data-k2-part="Button" data-variant="primary">Zwei</button></div></div>` +
        `</div></section>`,
    );
    expect(text).toContain('- plain <div> in Pane "Liste" "frei": no primitive owns it');
    expect(text).toContain('- loose text "lose" in Pane "Liste": put it in <Text> or <Notice>');
    expect(text).toContain('- Group "Innen" stands in another Group: groups are never nested');
    expect(text).toContain('- Group "Im Band" stands in a Band');
    expect(text).toContain('- Button "Eins" stands alone in Pane');
    expect(text).toContain('- 2 primary buttons ("Eins", "Zwei")');
  });

  test("tells a select's placeholder from a chosen value", () => {
    const text = outline(
      `<div class="k2-field" data-k2-part="Field"><label class="k2-field-label">Land</label>` +
        `<span class="k2-input" data-k2-part="Select"><span class="k2-input-value" data-placeholder="">Bitte wählen</span><select></select></span></div>`,
    );
    expect(text).toContain('Field "Land": Select placeholder "Bitte wählen"');
  });

  test("names a place that loads, and a table that keeps its head while it loads", () => {
    const text = outline(renderToString(() => createComponent(StatesFixture, {})));
    expect(text).toContain("Loading 3 placeholder rows of 3 lines");
    expect(text).toMatch(/Table "[^"]+" \d+ columns × 0 rows loading \(\d+ placeholder rows\)/);
    expect(text).not.toContain("Problems");
  });

  test("names the empty and the failed state, and a failed state in a bar as a problem", () => {
    const state = (part: string, text: string, button: string) =>
      `<div class="k2-state" data-k2-part="${part}"><span class="k2-sign"></span><span class="k2-state-text">${text}</span>` +
      `<button class="k2-btn" data-k2-part="Button"><span class="k2-btn-label">${button}</span></button></div>`;
    const text = outline(
      `<section class="k2-pane" data-k2-part="Pane" aria-label="Liste"><div class="k2-scroll">` +
        state("Empty", "Keine Unterhaltungen in diesem Ordner.", "Filter zurücksetzen") +
        state("Failed", "Unterhaltungen konnten nicht geladen werden.", "Erneut versuchen") +
        `<div class="k2-bar" data-k2-part="StatusRow">${state("Failed", "Verbindung unterbrochen.", "Erneut versuchen")}</div>` +
        `</div></section>`,
    );
    expect(text).toContain('Empty "Keine Unterhaltungen in diesem Ordner." ["Filter zurücksetzen"]');
    expect(text).toContain('Failed "Unterhaltungen konnten nicht geladen werden." ["Erneut versuchen"]');
    expect(text).toContain('- Failed "Verbindung unterbrochen." stands in a bar: Failed replaces the data that did not load');
  });

  test("says so when nothing on the page is v2", () => {
    expect(outline("<p>Hallo</p>")).toContain("no v2 part found");
  });
});
