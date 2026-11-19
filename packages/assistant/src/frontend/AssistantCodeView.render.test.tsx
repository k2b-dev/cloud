import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// "My apps & automations" and "Waiting for you" in every state of concept gustav-ui-neu v12, in German and English,
// from the same fixtures the screenshots use.

const root = mkdtempSync(join(tmpdir(), "assistant-apps-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

const fixtures = await import("./code-overview.fixture");
beforeAll(() => setSystemTime(new Date(fixtures.FIXTURE_NOW)));
afterAll(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
});
const [{ default: CodeView }, { default: ApprovalsView }, { default: WaitingAutomations }, { LocaleProvider }] = await Promise.all([
  import("./AssistantCodeView"),
  import("./AssistantApprovalsView"),
  import("./AssistantWaitingAutomations"),
  import("@k2b/ui"),
]);

type Locale = "de" | "en";
const inLocale = (locale: Locale, render: () => import("solid-js").JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return render();
      },
    }),
  );
const apps = (state: import("./code-overview.fixture").AppsState, locale: Locale) =>
  inLocale(locale, () =>
    createComponent(CodeView, {
      userId: "fixture",
      timeZone: fixtures.FIXTURE_TIME_ZONE,
      ...fixtures.myAppsFixture(state),
      onCreateInChat: () => {},
    }),
  );
const waiting = (state: import("./code-overview.fixture").WaitingState, locale: Locale) =>
  inLocale(locale, () => createComponent(ApprovalsView, fixtures.waitingFixture(state)));

/** What a person reads: text between tags, with the few entities the renderer writes. */
const visible = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const count = (html: string, needle: string) => html.split(needle).length - 1;

const STATES = ["normal", "leer", "laedt", "fehler", "lang"] as const;
const V5_APPS = ["chat", "chat-fehlt"] as const;

describe("My apps & automations", () => {
  test("normal shows head, the day line, four cards and the footer in this order (picture 27)", () => {
    const html = apps("normal", "de");
    const text = visible(html);
    for (const part of [
      "Meine Apps & Automationen",
      "Dein Code läuft als du, mit deinen Rechten und nicht mehr.",
      "Im Chat erstellen",
      "Heute",
      "9 Läufe erfolgreich, 1 fehlgeschlagen, 4 geplante Starts, 1 läuft gerade",
      "Code eines Postfachs oder eines anderen Orts steht an diesem Ort unter „Code“.",
    ])
      expect(text).toContain(part);
    // Head, day line, cards, footer: in this order, and the cards in the server's order.
    const order = [
      "assistant-page-head",
      "assistant-apps__today",
      "assistant-apps__cards",
      ">Wochenbericht Vertrieb<",
      ">Rückfragen sammeln<",
      ">Stoffpreise prüfen<",
      ">Angebote nachfassen<",
      "assistant-apps__quiet",
    ].map((part) => html.indexOf(part));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The create action is Gustav's: plum, with the AI sign.
    expect(html).toMatch(/data-variant="ai"[^>]*>[\s\S]*?ti-sparkles/);
    // Axis every six hours, "now" in plum, legend below.
    for (const hour of ["00:00", "06:00", "12:00", "18:00", "24:00"]) expect(text).toContain(hour);
    expect(text).toContain("jetzt");
    expect(text).toContain("erfolgreich fehlgeschlagen geplant");
    expect(html).toContain('role="img" aria-label="Läufe heute: 9 Läufe erfolgreich, 1 fehlgeschlagen, 4 geplante Starts, 1 läuft gerade"');
    // Every run on the line opens that run; a planned start opens its Code.
    expect(count(html, "?tab=runs&amp;run=")).toBe(11);
    expect(html).toContain('href="/app/assistant/code/c_stoff1"');
    // Cards: schedule, last result, status word with sign, and when.
    for (const part of [
      "Montags um 07:00",
      "Bei einem Ereignis",
      "Täglich um 06:30",
      "Freitags um 15:00",
      "Zuletzt: 1 Notiz „Wochenbericht KW 45“ angelegt",
      "Zuletzt: Preisliste von stoffe-nord.example nicht erreichbar",
      "Eingeschaltet",
      "Läuft gerade",
      "Letzter Lauf fehlgeschlagen",
      "Pausiert",
      "nächster Lauf Mo, 16.11.",
      "seit 3 Sekunden",
      "heute, 06:30",
      "seit 29.10.",
    ])
      expect(text).toContain(part);
    expect(count(html, "assistant-apps__bars")).toBe(4);
    expect(count(html, 'href="/app/assistant/code/c_')).toBeGreaterThanOrEqual(4);
    // Fewer than eight entries: no filter.
    expect(text).not.toContain("Alle 4");
  });

  test("English names the same parts", () => {
    const text = visible(apps("normal", "en"));
    for (const part of [
      "My apps & automations",
      "Your Code runs as you, with your rights and no more.",
      "Create in chat",
      "Today",
      "9 runs succeeded, 1 failed, 4 planned starts, 1 running",
      "Mondays at 07:00",
      "On an event",
      "Last: 1 Notiz „Wochenbericht KW 45“ angelegt",
      "Last run failed",
      "Paused",
      "since 3 seconds",
      "today, 06:30",
      "Code of a mailbox or another place is listed at that place, under “Code”.",
    ])
      expect(text).toContain(part);
  });

  test("empty says so without the head action and offers to create in the chat", () => {
    for (const [locale, title] of [
      ["de", "Noch keine eigene Automation."],
      ["en", "No automation of your own yet."],
    ] as const) {
      const html = apps("leer", locale);
      expect(visible(html)).toContain(title);
      expect(count(html, 'data-variant="ai"')).toBe(1);
      expect(html).not.toContain("assistant-apps__today");
    }
    expect(visible(apps("leer", "de"))).toContain("„Fass mir jeden Montag meine offenen Angebote zusammen“");
  });

  test("loading holds the day line and four cards of the same size", () => {
    for (const locale of ["de", "en"] as const) {
      const html = apps("laedt", locale);
      expect(html).toContain('aria-busy="true"');
      expect(count(html, 'assistant-apps__card"')).toBe(4);
      expect(html).toContain("assistant-apps__today");
      expect(html).not.toContain("assistant-apps__now");
    }
  });

  test("an error says the automations stay as they are and offers to try again", () => {
    const de = visible(apps("fehler", "de"));
    expect(de).toContain("Deine Automationen konnten nicht geladen werden.");
    expect(de).toContain("Das Laden ändert nichts an ihnen.");
    expect(de).toContain("Erneut versuchen");
    const en = visible(apps("fehler", "en"));
    expect(en).toContain("Your automations could not be loaded.");
    expect(en).toContain("Loading does not change them.");
  });

  test("a long list offers filter chips with their counts", () => {
    const html = apps("lang", "de");
    const text = visible(html);
    for (const chip of ["Alle 14", "Braucht dich 2", "Pausiert 3"]) expect(text).toContain(chip);
    expect(html).toContain('aria-pressed="true"');
    expect(count(html, "assistant-apps__bars")).toBe(14);
    expect(visible(apps("lang", "en"))).toContain("Needs you 2");
  });
});

describe("My apps & automations: a Code that writes to its own chat (Automationen als Code v5, a-apps)", () => {
  test("the card names its chat after its schedule; a missing chat needs the person, in German and English", () => {
    const bound = apps("chat", "de");
    const card = (html: string) => html.slice(html.indexOf(">Morgenbriefing<") - 600, html.indexOf(">Wochenbericht Vertrieb<"));
    expect(visible(card(bound))).toContain("Mo–Fr um 07:00 · in „Morgenbriefing“");
    // "in" stays with the chat's name: a line never breaks between them.
    expect(card(bound)).toContain("in\u00a0„Morgenbriefing“");
    expect(visible(card(bound))).toContain("Zuletzt: Briefing mit 2 Terminen, 2 Angeboten und 2 Kundenmails");
    expect(visible(card(bound))).toContain("Eingeschaltet");
    const missing = apps("chat-fehlt", "de");
    for (const part of ["Mo–Fr um 07:00 · Chat fehlt", "Zuletzt: Der Chat „Morgenbriefing“ ist archiviert", "Braucht dich", "heute, 07:00"])
      expect(visible(card(missing))).toContain(part);
    expect(card(missing)).toMatch(/class="assistant-apps__state" data-tone="danger"><i class="ti ti-alert-circle"/);
    expect(missing).toContain('href="/app/assistant/code/c_brief1"');
    const english = visible(card(apps("chat-fehlt", "en")));
    for (const part of ["· Chat missing", "Last: The chat “Morgenbriefing” is archived", "Needs you"]) expect(english).toContain(part);
    expect(visible(card(apps("chat", "en")))).toContain("· in “Morgenbriefing”");
  });
});

describe("Waiting for you", () => {
  test("normal lists approvals with their chat and versions from the row's own list", () => {
    const html = waiting("normal", "de");
    const text = visible(html);
    for (const part of [
      "Wartet auf dich",
      "Nichts davon passiert, bevor du zustimmst.",
      "Freigaben 2",
      "Angebot an Jana Probe",
      "Versionen 1",
      "Version 2 einschalten",
      "in Lieferungen eintragen",
      "Ansehen",
    ])
      expect(text).toContain(part);
    // The shared approval card, not a copy of it.
    expect(count(html, 'class="cloud-approval"')).toBe(2);
    expect(html).toContain('aria-label="Ansehen: Version 2 einschalten"');
    // Only what the row lists: Code of places is no "waiting for you" entry.
    expect(text).not.toContain("du verwaltest");
    expect(visible(waiting("normal", "en"))).toContain("None of it happens before you agree.");
  });

  test("an approval from an automation names it and its chat; the automation that needs a chat has a row with the way out", () => {
    const html = waiting("automation", "de");
    const text = visible(html);
    expect(text).toContain("Freigaben 1");
    expect(text).toContain("Aus der Automation „Morgenbriefing“ · im Chat „Morgenbriefing“ ·");
    expect(html).toContain('<a href="/app/assistant/code/c_brief1">Aus der Automation „Morgenbriefing“</a>');
    expect(html).toContain('<a href="/app/assistant?conversation=Brief1">im Chat „Morgenbriefing“</a>');
    // The server renders the section with the page, after the approvals, so nothing appears later and moves.
    for (const part of [
      "Automationen 1",
      "Morgenbriefing braucht einen Chat",
      "Sie schreibt nichts, bis du einen Chat wählst.",
      "Chat wählen …",
    ])
      expect(text).toContain(part);
    expect(html.indexOf("assistant-waiting-automations")).toBeGreaterThan(html.indexOf('class="cloud-approval"'));
    expect(visible(waiting("automation", "en"))).toContain("From the automation “Morgenbriefing” · in the chat “Morgenbriefing”");
    // Nothing else waits: the page is not empty while an automation needs the person.
    const onlyAutomation = visible(
      inLocale("de", () =>
        createComponent(ApprovalsView, {
          ...fixtures.waitingFixture("automation"),
          initial: { items: [], nextCursor: null, count: 0, elsewhere: 0 },
        }),
      ),
    );
    expect(onlyAutomation).toContain("Morgenbriefing braucht einen Chat");
    expect(onlyAutomation).not.toContain("Nichts wartet auf dich.");
  });

  test.each([
    [
      "chat_missing",
      "Morgenbriefing braucht einen Chat",
      "Sie schreibt nichts, bis du einen Chat wählst.",
      "Chat wählen …",
      "It writes nothing until you choose a chat.",
      "Choose a chat …",
    ],
    [
      "secret",
      "Kontostand braucht ein Secret",
      "Sie läuft erst wieder, wenn ihr Secret gesetzt ist.",
      "Ansehen",
      "It runs again once its secret is set.",
      "View",
    ],
    [
      "mandate",
      "Rückfragen sammeln braucht deine Bestätigung",
      "Sie läuft erst wieder, wenn du sie bestätigst.",
      "Ansehen",
      "It runs again once you confirm it.",
      "View",
    ],
    [
      "access",
      "Stoffpreise prüfen braucht Zugriff",
      "Ihr fehlt Zugriff auf eines ihrer Ziele.",
      "Ansehen",
      "It lacks access to one of its targets.",
      "View",
    ],
  ] as const)(
    "the automations section says what %s means and names its way out, in German and English",
    (reason, short, meaning, action, english, englishAction) => {
      const entry = fixtures.WAITING_AUTOMATIONS.find((item) => item.reason === reason)!;
      const section = (locale: Locale) =>
        inLocale(locale, () => createComponent(WaitingAutomations, { entries: [entry], onRetry: () => {} }));
      const html = section("de");
      for (const part of ["Automationen 1", short, meaning, action]) expect(visible(html)).toContain(part);
      expect(html).toContain(`<a aria-label="${action}: ${short}" href="${entry.href!.replace(/&/g, "&amp;")}"`);
      for (const part of ["Automations 1", english, englishAction]) expect(visible(section("en"))).toContain(part);
    },
  );

  test("an automations read Core could not answer says so and offers to try again", () => {
    let retried = 0;
    const html = inLocale("de", () => createComponent(WaitingAutomations, { entries: null, onRetry: () => retried++ }));
    expect(visible(html)).toContain("Automationen, die dich brauchen, konnten nicht geladen werden.");
    expect(visible(html)).toContain("Erneut versuchen");
    expect(html).toContain('role="alert"');
    expect(retried).toBe(0);
  });

  test("empty, loading, error and long", () => {
    expect(visible(waiting("leer", "de"))).toContain("Nichts wartet auf dich.");
    expect(visible(waiting("leer", "de"))).toContain("Fragt Gustav etwas oder braucht eine Automation dich, steht es hier.");
    expect(visible(waiting("leer", "en"))).toContain("Nothing is waiting for you.");
    const loading = waiting("laedt", "de");
    expect(loading).toContain('aria-busy="true"');
    expect(count(loading, 'assistant-waiting-page__skeleton"')).toBe(2);
    const failed = visible(waiting("fehler", "de"));
    expect(failed).toContain("Die offenen Fragen konnten nicht geladen werden.");
    expect(failed).toContain("Offene Freigaben bleiben offen. Ohne deine Zustimmung führt Gustav sie nicht aus.");
    expect(failed).toContain("Erneut versuchen");
    expect(visible(waiting("fehler", "en"))).toContain("The open questions could not be loaded.");
    const long = waiting("lang", "de");
    expect(visible(long)).toContain("Freigaben 9");
    expect(count(long, 'class="cloud-approval"')).toBe(3);
  });
});

// 3d: a status is a result word with its sign; never "Passt", "OK", "Gut" or "Fertig". Nothing technical shows either.
test("no surface shows a forbidden status word or an identifier", () => {
  const forbidden = /\b(Passt|OK|Okay|Gut|Fertig)\b/;
  const technical = /\bc_[a-z0-9]{4,}\b|[0-9a-f]{8}-[0-9a-f]{4}-|\bcron\b|\*\/\d|code\.ts|entrypoint/;
  for (const locale of ["de", "en"] as const)
    for (const state of STATES) {
      for (const html of [
        apps(state, locale),
        waiting(state, locale),
        ...V5_APPS.map((v5) => apps(v5, locale)),
        waiting("automation", locale),
      ]) {
        const text = visible(html);
        expect(text).not.toMatch(forbidden);
        expect(text).not.toMatch(technical);
      }
    }
});
