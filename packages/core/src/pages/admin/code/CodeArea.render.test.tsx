import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText } from "../../../../../../scripts/fixtures/rendered-markup";

const root = mkdtempSync(join(tmpdir(), "core-code-area-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [
  { LocaleProvider },
  { approvalReason, CodeAreaView, ownerLabel },
  { codeAdminMessages },
  { parseCodeAreaQuery },
  { codeFixtureData },
  data,
  { codeReviewMessages },
] = await Promise.all([
  import("@k2b/ui"),
  import("./view"),
  import("./messages"),
  import("./area"),
  import("./CodeArea.fixture-data"),
  import("./CodeArea.fixture-data"),
  import("./review-messages"),
]);

beforeAll(() => setSystemTime(new Date("2026-11-01T12:10:00.000Z")));
afterAll(() => setSystemTime());

type State = Parameters<typeof codeFixtureData>[0];
const render = (query: Record<string, string>, state: State = "normal", locale = "de", counts?: { approvals: number; reports: number }) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeAreaView, {
          t: codeAdminMessages.resolve([locale]).t,
          locale,
          dateConfig: { locale: locale === "de" ? "de-DE" : "en-GB", timeZone: "Europe/Berlin" },
          query: parseCodeAreaQuery(query),
          data:
            state === "noperm"
              ? null
              : { ...codeFixtureData(state, query, locale), ...(counts ? { summary: { ...data.fixtureSummary(), ...counts } } : {}) },
          noPermission: state === "noperm",
          retryHref: "/admin/code",
          viewerId: data.FIXTURE_PEOPLE.jana,
          appNames: { mail: "Mail", spaces: "Spaces", werkstatt: "Werkstattbuch" },
        });
      },
    }),
  );
test("approval says in words what the version may do, its internet addresses included", () => {
  const text = renderedText(render({ sec: "approvals", id: data.FIXTURE_VERSIONS.rueckruf3 }), " ");
  expect(text).toContain("Alles, was Version 3 darf");
  expect(text).toContain("Internet: api.buchhaltung-beispiel.de, ohne Secret");
  expect(text).toContain("Läuft");
  expect(text).toContain("Mo–Fr um 08:00");
});

const review = { sec: "approvals", id: data.FIXTURE_VERSIONS.rueckruf3 };

test("the area column names every section with waiting counts", () => {
  const html = render({});
  for (const label of [
    "Freigaben",
    "Code in dieser Cloud",
    "Richtlinien",
    "Standard",
    "Gruppen",
    "Wirksam für …",
    "Aufräumen",
    "Grenzen",
    "Runner",
  ])
    expect(html).toContain(label);
  expect(html).toContain("4 Versionen warten auf Freigabe");
  const english = render({}, "normal", "en");
  expect(english).toContain("Approvals");
  expect(english).toContain("Code in this Cloud");
});

test("the area without a section opens on the approvals instead of two empty columns", () => {
  const html = render({});
  const text = renderedText(html, " ");
  expect(text).toContain("4 Versionen warten auf eine Entscheidung.");
  expect(text).toContain("Rückruf bestätigen");
  // Only the area column and one page: no section or detail column that repeats the area's name over a hint.
  expect(html.match(/data-workspace-main-region="/g)?.length).toBe(2);
  // The open page and the chosen row agree.
  expect(html).toMatch(
    /<a[^>]*href="\/admin\/code\?sec=approvals"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/admin\/code\?sec=approvals"/,
  );
  expect(text).not.toMatch(/Code Alles, was als Code in Cloud läuft Code Alles, was als Code in Cloud läuft/);
  const english = renderedText(render({}, "normal", "en"), " ");
  expect(english).toContain("Approvals");
  // Nothing waits: the area opens on the approvals' empty state, not on an empty column.
  const empty = renderedText(render({}, "empty"), " ");
  expect(empty).toContain("Keine Version wartet auf dich.");
  expect(render({}, "empty").match(/data-workspace-main-region="/g)?.length).toBe(2);
});

test("approvals are a page: a list with who, owner, main change and reason, and states", () => {
  const list = renderedText(render({ sec: "approvals" }), " ");
  expect(list).toContain("4 Versionen warten auf eine Entscheidung.");
  expect(list).toContain("Rückruf bestätigen");
  expect(list).toContain("Version 1 · erste");
  expect(list).toContain("Postfach info@moebel-beispiel.de");
  expect(list).toContain("Tom Beispiel");
  expect(list).toContain("ein Ort in Spaces, den du nicht öffnen darfst");
  expect(list).toContain("Darf neu Aufgaben anlegen im Space Logistik");
  expect(list).toContain("Für andere sichtbar");
  expect(list).toContain("Ins Internet");
  expect(list).not.toContain("k7qm2x9a");

  const decided = renderedText(render({ sec: "approvals", tab: "decided" }), " ");
  expect(decided).toContain("Freigegeben von Ben Schulz");
  expect(decided).toContain("Änderungen angefordert von dir");
  expect(decided).toContain("Zuletzt entschieden.");

  const empty = renderedText(render({ sec: "approvals" }, "empty"), " ");
  expect(empty).toContain("Keine Version wartet auf dich.");
  expect(empty).toContain("Richtlinie ansehen");
  const failed = render({ sec: "approvals" }, "fail");
  expect(failed).toContain("Konnte nicht geladen werden");
  expect(failed).toContain("Erneut versuchen");
  expect(render(review, "missing")).toContain("Diese Anfrage ist geschlossen.");
});

test("a review has one row of tabs, a head with who, how and whose, and the approval with three decisions", () => {
  const html = render(review);
  const text = renderedText(html, " ");
  expect(text).toContain("Rückruf bestätigen · Version 3");
  expect(text).toContain("mit Gustav eingereicht · gehört zu: info@moebel-beispiel.de");
  expect(text).toContain("1 von 4");
  for (const tab of ["Übersicht", "Code", "Diff"]) expect(html).toContain(`>${tab}<`);
  expect(text).toContain("Sie darf etwas tun, das andere sehen. Das gibt laut Richtlinie Standard ein Admin frei.");
  expect(text).toContain("Details von Code · gegenüber Version 2");
  expect(text).toContain("Darf neu Aufgaben anlegen im Space Logistik");
  expect(text).toContain("3 weitere bleiben gleich.");
  expect(text).toContain("Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.");
  expect(text).toContain("3 von 3 Beispielen erfolgreich");
  expect(text).toContain("Gilt genau für Version 3");
  for (const answer of ["Ablehnen …", "Änderungen anfordern …", "Version 3 freigeben"]) expect(text).toContain(answer);
  expect(text).toContain("Was sie damit tut");
  expect(text).toContain("KI-Erklärung, nicht von Cloud geprüft");
  expect(text).toContain("Kommentare am Code");
  expect(text).toContain("Hier bekommt jede ungelesene Mail eine Aufgabe");
  expect(text).toContain("Mit deiner Entscheidung sieht Lea Muster die Kommentare als Text.");
  // No hashes, no line references, no technical identifiers outside the marked code field.
  expect(text).not.toMatch(/[0-9a-f]{4}…[0-9a-f]{2}|Z\. \d+|sp_2lg8/);
  expect(renderedText(render(review, "cli"), " ")).toContain("über die Kommandozeile eingereicht");
  expect(renderedText(render({ ...review, tab: "code" }), " ")).toContain("3 Kommentare gehen mit deiner Entscheidung mit");
});

test("the first version locks its Diff tab, and a decided version freezes its comments", () => {
  const first = render({ sec: "approvals", id: data.FIXTURE_VERSIONS.lieferzeit1 });
  expect(first).toMatch(/role="tab"[^>]*disabled[^>]*>(?:(?!<\/button>).)*Diff/s);
  expect(renderedText(first, " ")).toContain("Erste Version: Es gibt keinen Unterschied.");
  expect(renderedText(first, " ")).toContain("Details von Code · erste Version, alles ist neu");
  const changes = renderedText(render(review, "changes"), " ").replaceAll(/\s+/g, " ");
  expect(changes).toContain("Änderungen angefordert");
  expect(changes).toContain("Du hast Änderungen an Version 3 angefordert.");
  expect(changes).toContain("Deine Nachricht");
  expect(changes).toContain("Bitte nur für Mails mit einem Rückrufwunsch eine Aufgabe anlegen");
  expect(changes).not.toContain("Version 3 freigeben");
  expect(renderedText(render(review, "rejected"), " ")).toContain("Version 3 lässt sich nicht mehr einschalten.");
  const decidedCode = render({ ...review, tab: "code" }, "changes");
  expect(decidedCode).not.toContain("Antworten …");
  expect(decidedCode).toContain("Der entschiedene Stand.");
  expect(renderedText(render(review, "followup"), " ")).toContain("Du hattest bei Version 2 Änderungen angefordert");
  expect(render(review, "newer")).toContain("Lea Muster hat Version 4 eingereicht.");
  expect(render(review, "own")).toContain("Du hast diese Version geschrieben.");
  expect(render(review, "sole")).toContain("Du bist der einzige Admin und gibst deine eigene Version frei.");
});

test("the reason names the policy that asks: the default or the groups", () => {
  const r = codeReviewMessages.resolve(["de"]).t;
  const detail = data.fixtureApprovalDetail();
  expect(approvalReason(r, detail)).toBe("Sie darf etwas tun, das andere sehen. Das gibt laut Richtlinie Standard ein Admin frei.");
  expect(approvalReason(r, { ...detail, why: [{ row: "internet", source: "group", groups: ["Praktikum"] }] })).toBe(
    "Sie ruft Adressen im Internet auf. Das gibt laut Regel der Gruppe Praktikum ein Admin frei.",
  );
});

test("the former source view points to the version's review", () => {
  const html = render({ sec: "code", id: "c_rechn", version: data.FIXTURE_VERSIONS.rechnungen2 });
  expect(html).toContain("Den Code einer Version zeigt jetzt ihre Freigabe-Prüfung.");
  expect(html).toContain(`sec=approvals&amp;id=${data.FIXTURE_VERSIONS.rechnungen2}&amp;tab=code`);
  expect(render({ sec: "code", id: "c_rechn" })).not.toContain("Code ansehen");
});

test("all Code renders owners, status and last run, with empty, filtered and error states", () => {
  const list = render({ sec: "code" });
  expect(list).toContain("8 Code von 5 Besitzern");
  expect(list).toContain("Lea Muster · Pausiert: Richtlinie");
  // A place by the name its reader gave this admin; without one, by its ID.
  expect(list).toContain("info@moebel-beispiel.de · Aktiv");
  expect(list).not.toContain("m_rechn");
  expect(
    ownerLabel(codeAdminMessages.resolve(["de"]).t, { kind: "resource", ref: { type: "mail.mailbox", id: "m_x" } }, null, { mail: "Mail" }),
  ).toBe("ein Ort in Mail, den du nicht öffnen darfst");
  expect(list).toContain("App Werkstattbuch · Entwurf");
  expect(list).toContain("noch kein Lauf");
  const detail = render({ sec: "code", id: "c_rechn" });
  expect(detail).toContain("In „Freigaben“ öffnen");
  expect(detail).toContain("selbst freigegeben (einziger Admin)");
  expect(detail).toContain("Letzte Läufe");
  expect(detail).toContain("Pausieren");
  expect(render({ sec: "code", id: "c_woche" })).toContain("Fortsetzen");
  expect(detail).toContain("Fehlgeschlagen");
  expect(render({ sec: "code" }, "empty")).toContain("Noch kein Code");
  expect(render({ sec: "code", status: "deleting" })).toContain("Kein Code passt zu diesen Filtern");
  expect(render({ sec: "code" }, "fail")).toContain("Konnte nicht geladen werden");
  expect(render({ sec: "code", id: "c_rechn" }, "missing")).toContain("Diesen Code gibt es nicht mehr.");
});

test("policy, groups and effective rows render with their sources", () => {
  const policy = render({ sec: "policy" });
  expect(policy).toContain("Zuletzt geändert von Jana Probe");
  expect(policy).toContain("Was Automationen ohne Menschen tun dürfen.");
  expect(policy).toContain("Admin gibt frei");
  expect(policy).toContain("Für andere sichtbar");
  expect(policy).not.toContain("silent: shared");
  expect(policy).toContain("Braucht immer einen Menschen");
  expect(policy).toContain("Was die Automation tun darf");
  expect(policy).toContain('role="radio"');
  const groups = render({ sec: "groups", id: data.FIXTURE_GROUPS.buchhaltung });
  expect(groups).toContain("2 Regeln · 6 Personen · Untergruppe von Verwaltung");
  expect(groups).toContain("Wie Standard");
  expect(render({ sec: "groups" }, "empty")).toContain("Keine Gruppe hat eigene Regeln");
  const effective = render({ sec: "effective", id: data.FIXTURE_PEOPLE.tom });
  expect(effective).toContain("Tom Beispiel");
  expect(effective).toContain("„Nie“ aus Gruppe Praktikum gilt immer");
  expect(effective).toContain("aus Gruppe Buchhaltung");
  expect(render({ sec: "effective" })).toContain("Suche eine Person");
  expect(render({ sec: "policy" }, "fail")).toContain("Konnte nicht geladen werden");
  expect(policy).toContain('href="/admin/code?sec=history"');
  const history = render({ sec: "history" });
  expect(history).toContain("Jana Probe");
  expect(history).toContain("Sendet (Praktikum)");
  expect(history).toContain("wie Standard");
  expect(renderedText(history, " ").replaceAll(/\s+/g, " ")).toContain("Voreinstellung: Admin gibt frei Eigene");
  // A preset change lists every changed row, also beyond six.
  for (const label of ["Löscht", "Nicht rückgängig", "Bezieht Personen ein", "Ändert Zugriff", "Läuft weiter", "Sensibel"])
    expect(history).toContain(label);
  expect(render({ sec: "history" }, "empty")).toContain("Die Richtlinie wurde noch nie geändert.");
  const older = render({ sec: "history" }, "long");
  expect(older).toContain("Ältere Änderungen laden");
  expect(older).toContain('href="/admin/code?sec=history&amp;after=2"');
  expect(render({ sec: "history" })).not.toContain("Ältere Änderungen laden");
  expect(render({ sec: "history" }, "fail")).toContain("Der Verlauf konnte nicht geladen werden.");
});

test("cleanup shows orphaned Code deletion and retries, while access stays in the target's normal share dialog", () => {
  const cleanup = render({ sec: "cleanup" });
  expect(cleanup).toContain("Code löschen");
  expect(cleanup).toContain("Code von alt@");
  expect(cleanup).toContain("Wird der Besitzer eines Codes gelöscht, stoppt Cloud den Code und plant seine Löschung.");
  expect(cleanup).toContain("Den Zugriff eines Dienstkontos änderst du im normalen Teilen-Dialog des Ziels, wenn du das Ziel verwaltest.");
  expect(cleanup).toContain("Wartet auf Wiederholung");
  expect(cleanup).toContain("3 Versuche");
  expect(cleanup).toContain("Der letzte Versuch ist fehlgeschlagen.");
  expect(cleanup).not.toContain("code_activation_draining");
  expect(cleanup).not.toContain("c_altpost");
  const empty = render({ sec: "cleanup" }, "empty");
  expect(empty).toContain("Nichts aufzuräumen");
  expect(empty).toContain("Es warten keine Löschaufträge für Code.");
  expect(empty).toContain("im normalen Teilen-Dialog des Ziels");
  const english = render({ sec: "cleanup" }, "normal", "en");
  expect(english).toContain("Delete Code");
  expect(english).toContain("When a Code owner is deleted, Cloud stops the Code and schedules its deletion.");
  expect(english).toContain("use the target's normal share dialog. You must manage that target.");
  expect(render({ sec: "cleanup" }, "empty", "en")).toContain("No Code deletion jobs are pending.");
  for (const html of [cleanup, empty, english]) {
    expect(html).not.toMatch(/Zugriff entfernen|Remove access|target_unreachable/);
    expect(html).not.toMatch(/Ziel-App nicht erreichbar|target app is unreachable/);
  }
  const failed = render({ sec: "cleanup" }, "fail");
  expect(failed).toContain("Konnte nicht geladen werden");
  expect(failed).toContain("Erneut versuchen");
});

test("limits and runners render their data, empty and error states", () => {
  const limits = render({ sec: "limits" });
  for (const label of [
    "Wanduhr je Lauf (ms)",
    "Brückenaufrufe je Lauf",
    "Datenbank je Code (Bytes)",
    "KI-Referenzbudget je Versuch (USD)",
    "Gleichzeitige Läufe je Code",
    "Gleichzeitige Läufe je Besitzer",
  ])
    expect(limits).toContain(label);
  expect(render({ sec: "limits" }, "normal", "en")).toContain("AI reference budget per attempt (USD)");
  const runners = render({ sec: "runners" });
  expect(runners).toContain('data-section="code-runners"');
  const runnerText = renderedText(runners, " ").replaceAll(/\s+/g, " ");
  for (const label of [
    "3 Runner",
    "5 von 12 Plätzen frei",
    "5 Läufe warten",
    "4 s längste Wartezeit",
    "Runner 1 · 8a3c",
    "1 von 4 Plätzen frei",
    "Verbunden",
  ])
    expect(runnerText).toContain(label);
  expect(runners).not.toContain("8a3c1e20");
  const none = renderedText(render({ sec: "runners" }, "empty"), " ");
  expect(none).toContain("Kein Runner ist verbunden. Keine Automation läuft.");
  expect(none).toContain("2 Min.");
  expect(render({ sec: "runners" }, "fail")).toContain("Die Runner konnten nicht geladen werden.");
});

test("people without the Cloud-admin role see only the no-permission state", () => {
  const html = render({ sec: "approvals" }, "noperm");
  expect(html).toContain("Nur Cloud-Admins verwalten Code");
  expect(html).not.toContain("Freigaben");
});

test("Code of an app has its Code page here: its service account and a refused call like any Code page", () => {
  const detail = renderedText(render({ sec: "code", id: "c_portal" }), " ")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/ \./g, ".");
  // The head as on every Code page: title, service account, the word "Kennung", the handle and a short "Kopieren".
  expect(detail).toContain("Kundenportal-Eingang");
  expect(detail).toContain("Läuft als Dienstkonto „Code von Werkstattbuch“ · Kennung code-7k2q9m4xwt Kopieren");
  expect(render({ sec: "code", id: "c_portal" })).toMatch(
    /<button aria-label="Kennung kopieren"[^>]*>(?:(?!<\/button>).)*>Kopieren<\/span><\/button>/,
  );
  expect(detail).toContain("Letzter Lauf");
  // A run reads as its automation does on the Code page: the event by its title and place, never its stable key.
  expect(detail).toContain("Aufgabe fällig · Space k7qm2x9a");
  expect(detail).not.toContain("event:spaces.item.due");
  expect(detail).toContain(
    "Kein Zugriff auf Space k7qm2x9a. Der Code wollte dort „Aufgabe erstellen“. Entweder fehlt dem Dienstkonto „Code von Werkstattbuch“ das Recht dafür, oder das Ziel existiert nicht.",
  );
  expect(detail).toContain(
    "Wer das Ziel verwaltet, fügt das Dienstkonto im Rechte-Editor des Ziels mit der Kennung code-7k2q9m4xwt hinzu. Der nächste Lauf versucht es erneut.",
  );
  expect(render({ sec: "code", id: "c_portal" })).toContain('href="/app/spaces/k7qm2x9a"');
  // Administration manages policy, approvals and Code of apps, never target access.
  expect(detail).not.toContain("Zielrechte");
  // Code of a place or a person keeps its Code page at its owner.
  expect(render({ sec: "code", id: "c_rechn" })).not.toContain("Läuft als Dienstkonto");
});

test("administrator detail shows database size, owner capacity and the shared export link", () => {
  const html = render({ sec: "code", id: "c_rechn" }, "normal", "en");
  expect(renderedText(html, " ")).toContain("Database: 1.00 MB of 100.00 MB");
  expect(renderedText(html, " ")).toContain("Owner reserved capacity: 200.00 MB of 1,000.00 MB");
  expect(html).toContain("/api/code/authoring/database/c_rechn/export");
});

test("unused databases show a bounded page with deadline, access and incarnation-bound controls", () => {
  const html = render({ sec: "databases" });
  const text = renderedText(html);
  for (const label of ["Ungenutzte Datenbanken", "Ungenutzt seit", "Löschdatum", "Letzter Zugriff", "Größe", "Lea Muster", "4 MB"])
    expect(text).toContain(label);
  expect(html).toContain("CodeUnusedDatabases.island.tsx");
  expect(html).toContain("/api/code/authoring/database/c_rueck/export");
  expect(text).toContain("Jetzt löschen");
  expect(html).toContain("code_c_rueck_fixture");
  expect(renderedText(render({ sec: "databases" }, "empty"))).toContain("Keine ungenutzten Datenbanken");
  expect(renderedText(render({ sec: "databases" }, "fail"))).toContain("Erneut versuchen");
});

for (const locale of ["de", "en"]) {
  test(`author review uses server eligibility for hints and buttons (${locale})`, () => {
    const t = codeAdminMessages.resolve([locale]).t;
    const own = render(review, "own", locale);
    const sole = render(review, "sole", locale);
    expect(own).toContain(t.ownSub);
    expect(own).not.toContain(t.soleTitle);
    expect(sole).toContain(t.soleTitle);
    expect(sole).not.toContain(t.ownSub);
    expect(sole).not.toContain(t.ownTitle);
    const label = locale === "de" ? "Version 3 freigeben" : "Approve version 3";
    // The v12 review keeps the approve button in its place for the author: disabled, with the reason in the approval.
    const button = (html: string) =>
      html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "s"))?.[0] ?? "";
    expect(button(own)).toMatch(/\sdisabled(?:=""|\s|>)/);
    // The reason stands in the approval's own reason line, beside the disabled button.
    const reason = own.match(/k2b-chat-decision__reason(?:(?!<\/p>).)*<\/p>/s)?.[0] ?? "";
    expect(renderedText(reason, " ")).toContain(t.ownSub);
    expect(button(sole)).not.toBe("");
    expect(button(sole)).not.toMatch(/\sdisabled(?:=""|\s|>)/);
  });
}

for (const locale of ["de", "en"]) {
  test(`after deciding their own version the author is addressed directly, not told about a notice to themselves (${locale})`, () => {
    const t = codeReviewMessages.resolve([locale]).t;
    const self = renderedText(render(review, "soleApproved", locale), " ").replaceAll(/\s+/g, " ");
    expect(self).toContain(t.afterApprovedSelf);
    expect(self).not.toContain(t.afterApproved({ who: "Ben Schulz" }));
    const other = renderedText(render(review, "approved", locale), " ").replaceAll(/\s+/g, " ");
    expect(other).toContain(t.afterApproved({ who: "Lea Muster" }));
    expect(other).not.toContain(t.afterApprovedSelf);
  });
}

for (const locale of ["de", "en"]) {
  test(`sole author sees the approval/report breakdown in the initial HTML (${locale})`, () => {
    const t = codeAdminMessages.resolve([locale]).t;
    const html = render(review, "sole", locale, { approvals: 1, reports: 1 });
    const text = renderedText(html, " ").replaceAll(/\s+/g, " ");
    expect(text).toContain(`${t.approvals} 1`);
    expect(text).toContain(`${t.reports} 1`);
    expect(html).toContain(t.soleTitle);
    const empty = renderedText(render({}, "empty", locale), " ").replaceAll(/\s+/g, " ");
    expect(empty).toContain(`${t.reports} 0`);
  });
}
