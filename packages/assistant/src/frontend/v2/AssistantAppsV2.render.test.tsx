import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// My apps & automations on v2 (screen brief 1, recipe "overview") in every state, from the fixtures v1's test uses.

const root = mkdtempSync(join(tmpdir(), "assistant-apps-v2-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

const fixtures = await import("../code-overview.fixture");
beforeAll(() => setSystemTime(new Date(fixtures.FIXTURE_NOW)));
afterAll(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
});
const [{ default: AppsV2 }, { LocaleProvider }] = await Promise.all([import("./AssistantAppsV2"), import("@k2b/ui")]);

type Locale = "de" | "en";
const apps = (state: import("../code-overview.fixture").AppsState, locale: Locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AppsV2, {
          userId: "fixture",
          timeZone: fixtures.FIXTURE_TIME_ZONE,
          ...fixtures.myAppsFixture(state),
          onCreateInChat: () => {},
        });
      },
    }),
  );
const visible = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("My apps & automations on v2", () => {
  test("one statement of today's runs, the day line, then one table row per app in the server's order", () => {
    const html = apps("normal");
    const text = visible(html);
    // The hero: today's runs, the number of apps beside it.
    expect(html).toContain('data-k2-part="StatusRow"');
    expect(text).toContain("15 Läufe heute");
    expect(text).toMatch(/4\s*Apps/);
    // The day line as the hero's picture, with every run opening that run.
    expect(text).toContain("9 Läufe erfolgreich, 1 fehlgeschlagen, 4 geplante Starts, 1 läuft gerade");
    expect(count(html, "?tab=runs&amp;run=")).toBe(11);
    // The table: one row per app, each opening its Code, in the server's order.
    expect(html).toContain('data-k2-part="Table"');
    const order = [">Wochenbericht Vertrieb<", ">Rückfragen sammeln<", ">Stoffpreise prüfen<", ">Angebote nachfassen<"].map((part) =>
      html.indexOf(part),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(count(html, 'href="/app/assistant/code/c_')).toBeGreaterThanOrEqual(4);
    // State as the recipe says it: a chip only where it needs the person, plain words otherwise.
    expect(html).toMatch(/data-k2-part="Chip"[^>]*>[\s\S]*?Letzter Lauf fehlgeschlagen/);
    expect(html).toMatch(/data-k2-part="Chip"[^>]*>[\s\S]*?Pausiert/);
    expect(html).not.toMatch(/data-k2-part="Chip"[^>]*>[^<]*Eingeschaltet/);
    // One meaning per column: the schedule, what happened last, the next run (else "–").
    for (const part of ["Montags um 07:00", "Preisliste von stoffe-nord.example nicht erreichbar", "Mo, 16.11."])
      expect(text).toContain(part);
    expect(text).not.toContain("nächster Lauf");
    expect(text).toContain("–");
    // B rule 1: the exceptions stand beside the hero, each with the first one it names; the create action beside them.
    // "Im Chat erstellen" stands in the page's head (AssistantPageFrame), not in the status row.
    for (const part of ["1 braucht dich · Stoffpreise prüfen", "1 läuft · Rückfragen sammeln", "1 pausiert"]) expect(text).toContain(part);
    // Explanations belong to the empty state, not to every day.
    expect(text).not.toContain("Dein Code läuft als du");
  });

  // The name column leads with Gustav's mark per trigger once a table column can carry a mark (#4223).
  test.todo("each app's name leads with Gustav's mark, its symbol from what starts the Code (#4223)", () => {
    const html = apps("normal");
    expect(html).toMatch(/data-name="clock"/);
    expect(html).toMatch(/data-name="bolt"/);
  });

  test("English names the same parts", () => {
    const text = visible(apps("normal", "en"));
    for (const part of ["15 runs today", "1 needs you · Stoffpreise prüfen", "1 running · Rückfragen sammeln"])
      expect(text).toContain(part);
  });

  test("the exceptions beside the hero are the filters: pressing one shows only those apps", () => {
    const html = apps("lang");
    expect(html).toMatch(/aria-pressed="false"[^>]*>[\s\S]*?brauchen dich/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>[\s\S]*?pausiert/);
  });

  test("empty says so without a table; the page's head offers to create in the chat, once", () => {
    const html = apps("leer");
    expect(html).toContain('data-k2-part="Empty"');
    expect(visible(html)).not.toContain("Im Chat erstellen");
    // The empty state explains what Code is here.
    expect(visible(html)).toContain("Dein Code läuft als du, mit deinen Rechten und nicht mehr.");
    expect(html).not.toContain('data-k2-part="Table"');
  });

  test("loading holds the table's place without a statement that is not true yet", () => {
    const html = apps("laedt");
    expect(html).toContain('data-k2-part="Table"');
    expect(html).not.toContain('data-k2-part="StatusRow"');
  });

  test("an error says the automations stay as they are and offers to try again", () => {
    const html = apps("fehler");
    expect(html).toContain('data-k2-part="Failed"');
    expect(visible(html)).toContain("Das Laden ändert nichts an ihnen.");
  });
});
