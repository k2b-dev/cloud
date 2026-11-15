import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-code-catchup-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const {
  default: MailCodeCatchUp,
  MailCodeBackfillLink,
  mailCodeCatchUpAvailable,
  readCatchUpAddress,
  mailCodeSelectionInput,
} = await import("./MailCodeTools");
const { MAIL_CODE_CATCH_UP_STATES, mailCodeCatchUpFixture } = await import("./MailCodeTools.fixture");
const { codePageFixture } = await import("@k2b/cloud/ssr/code-page/code-page.fixture");
const { LocaleProvider } = await import("@k2b/ui");

type State = (typeof MAIL_CODE_CATCH_UP_STATES)[number];
const render = (state: State, locale: "de" | "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailCodeCatchUp, { data: mailCodeCatchUpFixture(state, locale) });
      },
    }),
  );
/** Visible text only: attributes such as links may carry identifiers; the reader never sees them. */
const text = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** What every step must say, in the words of the approved mockup. */
const expected: Record<State, { de: string[]; en: string[] }> = {
  auswahl: {
    de: ["Vorhandene E-Mails nachholen", "Version 4 auf Mails an", "Welche Mails", "Vorschau laden", "Vor „Anwenden“ ändert sich nichts."],
    en: ["Process existing mail", "apply version 4 to mail", "Which mail", "Load preview", "Nothing changes before “Apply”."],
  },
  vorschau: {
    de: ["Vorschau", "mit Version 4", "12 Mails vom 01.11. bis 13.11. in allen Eingangsordnern", "Auf 12 Mails anwenden", "Andere Auswahl"],
    en: [
      "Preview",
      "with version 4",
      "12 messages from Nov 1 to Nov 13 in all incoming folders",
      "Apply to 12 messages",
      "Other selection",
    ],
  },
  "vorschau-mehr": {
    de: ["100 Mails vom 01.11. bis 13.11.", "Höchstens 100 gehen auf einmal", "Auf 100 Mails anwenden"],
    en: ["100 messages from Nov 1", "At most 100 go at once", "Apply to 100 messages"],
  },
  "vorschau-leer": {
    de: ["In dieser Auswahl liegen keine Mails", "Andere Auswahl"],
    en: ["No mail in this selection", "Other selection"],
  },
  laeuft: {
    de: [
      "Wird angewendet",
      "mit Version 4",
      "Läuft gerade",
      "58",
      "7 von 12 Mails übergeben. Du kannst die Seite verlassen, es läuft weiter.",
      "Anhalten",
    ],
    en: [
      "Applying",
      "with version 4",
      "Running",
      "58%",
      "7 of 12 messages handed over. You can leave this page; it keeps running.",
      "Stop",
    ],
  },
  angehalten: {
    de: ["Angehalten", "7 von 12 Mails sind übergeben und bleiben so. 5 warten.", "Fortsetzen", "Beenden"],
    en: ["Stopped", "7 of 12 messages are handed over and stay that way. 5 are waiting.", "Continue", "End"],
  },
  teilfehler: {
    de: [
      "Bei 2 von 12 Mails ist es fehlgeschlagen. Die Automation darf dieses Postfach gerade nicht lesen.",
      "10 Mails sind übergeben und bleiben so. Die 2 anderen sind unverändert.",
      "Zugriff prüfen",
      "Die 2 noch einmal versuchen",
      "Ergebnis",
      "10 Mails übergeben",
      "2 Mails nicht übergeben",
      "Läufe ansehen",
    ],
    en: [
      "For 2 of 12 messages it failed. The automation may not read this mailbox right now.",
      "Check access",
      "Try the 2 again",
      "Result",
      "View runs",
    ],
  },
  veraltet: {
    de: [
      "Die Vorschau gilt nicht mehr: Inzwischen ist Version 5 eingeschaltet.",
      "Es wurde nichts angewendet. Lade die Vorschau neu, dann siehst du, was Version 5 tun würde.",
      "Vorschau neu laden",
      "Welche Mails",
    ],
    en: ["The preview no longer applies: version 5 is switched on now.", "Reload preview", "Which mail"],
  },
  "veraltet-teilweise": {
    de: ["Inzwischen ist Version 5 eingeschaltet.", "7 Mails sind mit Version 4 übergeben und bleiben so."],
    en: ["version 5 is switched on now.", "7 messages are handed over with version 4 and stay that way."],
  },
  fertig: {
    de: ["Abgeschlossen: 12 Mails an die Automation übergeben.", "steht unter Läufe", "Läufe ansehen", "Welche Mails"],
    en: ["Completed: 12 messages handed over to the automation.", "View runs", "Which mail"],
  },
  "lese-fehler": {
    de: ["Den Stand konnte Cloud gerade nicht lesen.", "Das Nachholen läuft trotzdem weiter.", "Erneut versuchen"],
    en: ["Cloud could not read the status right now.", "Try again"],
  },
  "vorschau-fehler": {
    de: ["Die Vorschau konnte nicht laden.", "An der Automation ändert sich nichts.", "Erneut versuchen", "Welche Mails"],
    en: ["The preview could not load.", "Nothing changes on the automation.", "Try again"],
  },
  pausiert: {
    de: ["Die Automation ist pausiert.", "Zur Code-Seite"],
    en: ["The automation is paused.", "Go to Code"],
  },
  "nur-lesen": {
    de: ["nur, wer die Automation ändern darf"],
    en: ["Only people who may change the automation"],
  },
};
/** Steps that must not offer a given action. */
const absent: Partial<Record<State, { de: string[]; en: string[] }>> = {
  auswahl: { de: ["Vorschau ·", "Anwenden auf"], en: ["Apply to"] },
  "vorschau-leer": { de: ["anwenden"], en: ["Apply to"] },
  laeuft: { de: ["Fortsetzen"], en: ["Continue"] },
  teilfehler: { de: ["Erneut versuchen"], en: ["Try again"] },
  veraltet: { de: ["Auf 12 Mails anwenden"], en: ["Apply to"] },
  pausiert: { de: ["Welche Mails", "Vorschau laden"], en: ["Which mail"] },
};

describe("Process existing mail renders every step", () => {
  for (const state of MAIL_CODE_CATCH_UP_STATES)
    for (const locale of ["de", "en"] as const)
      test(`${state} (${locale})`, () => {
        const visible = text(render(state, locale));
        for (const phrase of expected[state][locale]) expect(visible).toContain(phrase);
        for (const phrase of absent[state]?.[locale] ?? []) expect(visible).not.toContain(phrase);
        // 3d: no vague status words; v12: no identifiers, technical names, or raw server messages on screen.
        expect(visible).not.toMatch(/\b(Passt|OK|Gut|Fertig)\b/);
        expect(visible).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|c_mail|Msg0|code\.event|catchup|operation|handler|JSON|UTC/i);
      });
});

test("the head names the switched-on version and leads back to the Code page", () => {
  const html = render("laeuft", "de");
  expect(html).toContain('href="/app/mail/Mb4kd2/code"');
  expect(render("teilfehler", "de")).toContain('href="/app/mail/Mb4kd2/code?tab=runs"');
  expect(render("fertig", "de")).toContain('href="/app/mail/Mb4kd2/code?tab=runs"');
  expect(html).not.toContain("<hr");
  expect(html).not.toContain("<details");
  expect(html).toContain('data-frame="line"');
  // Running shows the share handed over as a number and a bar, never the internal operation.
  expect(html).toMatch(/role="progressbar"/);
});

test("the overview line leads to the flow in both languages", () => {
  for (const [locale, lead, link] of [
    ["de", "Die Automation bearbeitet nur neue Mails.", "Vorhandene E-Mails nachholen"],
    ["en", "The automation only handles new mail.", "Process existing mail"],
  ] as const) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(MailCodeBackfillLink, { href: "/app/mail/Mb4kd2/code/catch-up" });
        },
      }),
    );
    expect(text(html)).toBe(`${lead} ${link}`);
    expect(html).toContain('href="/app/mail/Mb4kd2/code/catch-up"');
  }
});

test("only an editor of a switched-on Code with the whole mailbox gets the line", () => {
  const whole = { access: { scope: "mailbox" as const, permission: "admin" as const } };
  const assigned = { access: { scope: "assigned" as const, permission: "write" as const } };
  expect(mailCodeCatchUpAvailable(codePageFixture("overview", "de"), whole)).toBe(true);
  expect(mailCodeCatchUpAvailable(codePageFixture("paused", "de"), whole)).toBe(false);
  expect(mailCodeCatchUpAvailable(codePageFixture("reader", "de"), whole)).toBe(false);
  expect(mailCodeCatchUpAvailable(codePageFixture("overview", "de"), assigned)).toBe(false);
});

test("the address keeps selection, preview, and operation, and ignores what it does not know", () => {
  const read = readCatchUpAddress(
    new URL(
      "http://cloud.test/app/mail/Mb4kd2/code/catch-up?folder=Fold01&from=2026-11-01&to=2026-11-13&preview=00000000-0000-4000-8000-000000000004&page=2026-11-14T09:00:00.000Z_2026-11-12T08:00:00.000Z_00000000-0000-4000-8000-000000000111",
    ),
  );
  expect(read.pick).toEqual({ folder: "Fold01", from: "2026-11-01", to: "2026-11-13" });
  expect(read.previewVersionId).toBe("00000000-0000-4000-8000-000000000004");
  expect(read.page?.cursor.id).toBe("00000000-0000-4000-8000-000000000111");
  const junk = readCatchUpAddress(new URL("http://cloud.test/x?folder=../x&from=13.11.2026&operation=nope&page=bad"));
  expect(junk).toEqual({ pick: { folder: null, from: null, to: null }, page: null, previewVersionId: null, operationId: null, next: null });
  // "To" includes its day: the query ends before the next day.
  expect(mailCodeSelectionInput({ folder: null, from: "2026-11-01", to: "2026-11-13" }, null)).toEqual({
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-14T00:00:00.000Z",
  });
});
