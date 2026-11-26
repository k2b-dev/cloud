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
    for (const part of ["Montags um 07:00", "Zuletzt: Preisliste von stoffe-nord.example nicht erreichbar", "nächster Lauf Mo, 16.11."])
      expect(text).toContain(part);
    // What the old head and foot said stays: the purpose, the create action, where other Code lives.
    for (const part of ["Dein Code läuft als du, mit deinen Rechten und nicht mehr.", "Im Chat erstellen", "unter „Code“"])
      expect(text).toContain(part);
    // Fewer than eight apps: no filter.
    expect(text).not.toContain("Braucht dich");
  });

  test("English names the same parts", () => {
    const text = visible(apps("normal", "en"));
    for (const part of ["15 runs today", "Create in chat", "Your Code runs as you, with your rights and no more."])
      expect(text).toContain(part);
  });

  test("a long list offers the filters as toggles beside the statement", () => {
    const html = apps("lang");
    expect(html).toMatch(/aria-pressed="false"[^>]*>[\s\S]*?Braucht dich/);
  });

  test("empty says so and offers to create in the chat, without a table", () => {
    const html = apps("leer");
    expect(html).toContain('data-k2-part="Empty"');
    expect(visible(html)).toContain("Im Chat erstellen");
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
