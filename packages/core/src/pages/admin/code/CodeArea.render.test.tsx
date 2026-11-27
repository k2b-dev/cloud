import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText } from "../../../../../../scripts/fixtures/rendered-markup";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "core-code-area-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [
  { LocaleProvider },
  { default: CodeScreen },
  { approvalReason, ownerLabel },
  { codeAdminMessages },
  { parseCodeAreaQuery },
  data,
  { codeReviewMessages },
  { adminNavFixture },
  { codePageReportMessages },
] = await Promise.all([
  import("@k2b/ui"),
  import("./screen"),
  import("./data"),
  import("./messages"),
  import("./area"),
  import("./CodeArea.fixture-data"),
  import("./review-messages"),
  import("../admin-v2.fixture"),
  import("./report-messages"),
]);

beforeAll(() => setSystemTime(new Date("2026-11-01T12:10:00.000Z")));
afterAll(() => setSystemTime());

type State = Parameters<typeof data.codeFixtureData>[0];
type AreaData = ReturnType<typeof data.codeFixtureData>;
const render = (
  query: Record<string, string>,
  state: State = "normal",
  locale = "de",
  edit: (area: AreaData) => AreaData = (area) => area,
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeScreen, {
          nav: adminNavFixture("/admin/code"),
          query: parseCodeAreaQuery(query),
          locale,
          dateConfig: { locale: locale === "de" ? "de-DE" : "en-GB", timeZone: "Europe/Berlin" },
          viewerId: data.FIXTURE_PEOPLE.jana,
          apps: { mail: { name: "Mail", color: "#2563eb" }, spaces: { name: "Spaces" }, werkstatt: { name: "Werkstattbuch" } },
          data: state === "noperm" ? null : edit(data.codeFixtureData(state, query, locale)),
          noPermission: state === "noperm",
        });
      },
    }),
  );
const text = (html: string) =>
  renderedText(html.replace(/data-props="[^"]*"/g, ""), " ")
    .replaceAll(/\s+/g, " ")
    .replaceAll(" .", ".");
const review = { sec: "approvals", id: data.FIXTURE_VERSIONS.rueckruf3 };

test("every section renders on v2: one workspace, no v1 frame, no loader in the first picture", () => {
  for (const sec of ["approvals", "code", "policy", "groups", "effective", "history", "cleanup", "databases", "limits", "runners"]) {
    const html = render({ sec });
    expect({ sec, workspaces: html.match(/data-k2-part="Workspace"/g)?.length }).toEqual({ sec, workspaces: 1 });
    expect(html).not.toContain("k2b-app-workspace");
    expect(html).not.toContain('data-k2-part="Loading"');
    expect(html).not.toContain('aria-busy="true"');
  }
  // Without a section the area opens on the approvals, the work that waits.
  expect(text(render({}))).toContain("4 Freigaben warten");
});

test("approvals lead with how many wait and list what, who, whose, what it asks for and since when", () => {
  const list = text(render({ sec: "approvals" }));
  expect(list).toContain("4 Freigaben warten");
  expect(list).toContain("1 offene Meldung");
  for (const value of [
    "Rückruf bestätigen",
    "Version 1 · erste",
    "Postfach info@moebel-beispiel.de",
    "Tom Beispiel, persönlich",
    "ein Ort in Spaces, den du nicht öffnen darfst",
    "Darf neu Aufgaben anlegen im Space Logistik",
    "Für andere sichtbar",
    "Ins Internet",
  ])
    expect(list).toContain(value);
  expect(list).not.toContain("k7qm2x9a");
  const decided = text(render({ sec: "approvals", tab: "decided" }));
  expect(decided).toContain("Freigegeben von Ben Schulz");
  expect(decided).toContain("Änderungen angefordert von dir");
  const empty = text(render({ sec: "approvals" }, "empty"));
  expect(empty).toContain("Keine Freigabe wartet");
  expect(empty).toContain("Keine Version wartet auf dich.");
  expect(empty).toContain("Richtlinie ansehen");
  expect(text(render({ sec: "approvals" }, "fail"))).toContain("Erneut versuchen");
  expect(text(render(review, "missing"))).toContain("Diese Anfrage ist geschlossen.");
});

test("a review stands beside its list with its views, its question, the reason and both decisions", () => {
  const html = render(review);
  const page = text(html);
  expect(html.match(/data-k2-part="Pane"[^>]*data-detail/g)?.length ?? html.match(/data-detail/g)?.length).toBeGreaterThan(0);
  expect(page).toContain("Rückruf bestätigen");
  expect(page).toContain("Version 3 von Rückruf bestätigen freigeben?");
  expect(page).toContain("Sie darf etwas tun, das andere sehen. Das gibt laut Richtlinie Standard ein Admin frei.");
  expect(page).toContain("mit Gustav eingereicht · gehört zu: info@moebel-beispiel.de");
  for (const tab of ["Übersicht", "Code", "Änderungen"]) expect(html).toContain(tab);
  for (const value of [
    "Darf neu Aufgaben anlegen im Space Logistik",
    "3 weitere bleiben gleich.",
    "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.",
    "3 von 3 Beispielen erfolgreich",
    "Ablehnen / ändern",
    "Version 3 freigeben",
    "Was sie damit tut",
    "KI-Erklärung, nicht von Cloud geprüft",
    "Kommentare am Code",
    "Hier bekommt jede ungelesene Mail eine Aufgabe",
    "Mit deiner Entscheidung sieht Lea Muster die Kommentare als Text.",
    "Alles, was Version 3 darf",
    "Internet: api.buchhaltung-beispiel.de, ohne Secret",
    "Mo–Fr um 08:00",
  ])
    expect(page).toContain(value);
  expect(page).not.toMatch(/[0-9a-f]{4}…[0-9a-f]{2}|sp_2lg8/);
  expect(text(render(review, "cli"))).toContain("über die Kommandozeile eingereicht");
});

test("the first version has no changes view, and a decided version says what happened and freezes its comments", () => {
  const first = render({ sec: "approvals", id: data.FIXTURE_VERSIONS.lieferzeit1 });
  expect(first).not.toContain(">Änderungen<");
  expect(text(first)).toContain("Ablehnen / ändern");
  const changes = text(render(review, "changes"));
  expect(changes).toContain("Du hast Änderungen an Version 3 angefordert.");
  expect(changes).not.toContain("Ablehnen / ändern");
  expect(changes).not.toContain("Version 3 freigeben");
  expect(changes).toContain("Bitte nur für Mails mit einem Rückrufwunsch eine Aufgabe anlegen");
  expect(text(render(review, "rejected"))).toContain("Version 3 lässt sich nicht mehr einschalten.");
  expect(text(render({ ...review, tab: "code" }, "changes"))).toContain("Der entschiedene Stand.");
  expect(text(render(review, "followup"))).toContain("Du hattest bei Version 2 Änderungen angefordert");
  expect(render(review, "newer")).toContain("Lea Muster hat Version 4 eingereicht.");
  expect(render(review, "own")).toContain("Du hast diese Version geschrieben.");
  expect(render(review, "sole")).toContain("Du bist der einzige Admin und gibst deine eigene Version frei.");
});

for (const locale of ["de", "en"]) {
  test(`author review uses server eligibility for the approve button (${locale})`, () => {
    const t = codeAdminMessages.resolve([locale]).t;
    const own = render(review, "own", locale);
    const sole = render(review, "sole", locale);
    expect(own).toContain(t.ownSub);
    expect(sole).toContain(t.soleTitle);
    expect(sole).not.toContain(t.ownTitle);
    const label = locale === "de" ? "Version 3 freigeben" : "Approve version 3";
    const button = (html: string) =>
      html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "s"))?.[0] ?? "";
    expect(button(own)).toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(button(sole)).not.toBe("");
    expect(button(sole)).not.toMatch(/\sdisabled(?:=""|\s|>)/);
  });

  test(`after deciding their own version the author is addressed directly (${locale})`, () => {
    const r = codeReviewMessages.resolve([locale]).t;
    const self = text(render(review, "soleApproved", locale));
    expect(self).toContain(r.afterApprovedSelf);
    const other = text(render(review, "approved", locale));
    expect(other).toContain(r.afterApproved({ who: "Lea Muster" }));
    expect(other).not.toContain(r.afterApprovedSelf);
  });
}

test("a decided version keeps its stored description, or says there is none beside the way to one", () => {
  expect(text(render(review, "approved"))).toContain("Legt werktags um 8 Uhr");
  const withoutText = (area: AreaData): AreaData => {
    const approval = area.approval;
    if (!approval || approval === "failed" || approval === "missing" || !approval.readModel) return area;
    return {
      ...area,
      approval: {
        ...approval,
        explanation: null,
        readModel: { ...approval.readModel, description: { ...approval.readModel.description, state: "missing", text: null } },
      },
    };
  };
  const empty = text(render(review, "approved", "de", withoutText));
  expect(empty).toContain("Noch keine Beschreibung.");
  expect(empty).toContain("Diese Version erklären lassen");
});

test("the reason names the policy that asks: the default or the groups", () => {
  const r = codeReviewMessages.resolve(["de"]).t;
  const detail = data.fixtureApprovalDetail();
  expect(approvalReason(r, detail)).toBe("Sie darf etwas tun, das andere sehen. Das gibt laut Richtlinie Standard ein Admin frei.");
  expect(approvalReason(r, { ...detail, why: [{ row: "internet", source: "group", groups: ["Praktikum"] }] })).toBe(
    "Sie ruft Adressen im Internet auf. Das gibt laut Regel der Gruppe Praktikum ein Admin frei.",
  );
});

test("all automations: filters in the address, owner, state and last run per row, and the open one with its facts", () => {
  const list = render({ sec: "code" });
  const words = text(list);
  expect(words).toContain("14 Automationen von 7 Besitzern");
  expect(list).toContain('data-k2-part="FilterBar"');
  for (const value of ["Pausiert: Richtlinie", "info@moebel-beispiel.de", "App Werkstattbuch", "Entwurf", "noch kein Lauf"])
    expect(words).toContain(value);
  expect(words).not.toContain("m_rechn");
  expect(
    ownerLabel(codeAdminMessages.resolve(["de"]).t, { kind: "resource", ref: { type: "mail.mailbox", id: "m_x" } }, null, {
      mail: { name: "Mail" },
    }),
  ).toBe("ein Ort in Mail, den du nicht öffnen darfst");
  const detail = text(render({ sec: "code", id: "c_rechn" }));
  for (const value of ["In „Freigaben“ öffnen", "selbst freigegeben (einziger Admin)", "Letzte Läufe", "Pausieren", "Fehlgeschlagen"])
    expect(detail).toContain(value);
  expect(text(render({ sec: "code", id: "c_woche" }))).toContain("Fortsetzen");
  expect(text(render({ sec: "code" }, "empty"))).toContain("Sobald jemand eine Automation einreicht");
  const none = (area: AreaData): AreaData => ({ ...area, codes: { items: [], total: 0, owners: 0, nextCursor: null } });
  expect(text(render({ sec: "code", status: "deleting" }, "normal", "de", none))).toContain("Kein Code passt zu diesen Filtern");
  expect(text(render({ sec: "code" }, "fail"))).toContain("Erneut versuchen");
  expect(text(render({ sec: "code", id: "c_rechn" }, "missing"))).toContain("Diesen Code gibt es nicht mehr.");
  const moved = render({ sec: "code", id: "c_rechn", version: data.FIXTURE_VERSIONS.rechnungen2 });
  expect(moved).toContain("Den Code einer Version zeigt jetzt ihre Freigabe-Prüfung.");
  expect(moved).toContain(`sec=approvals&amp;id=${data.FIXTURE_VERSIONS.rechnungen2}&amp;tab=code`);
});

test("Code of an app shows its service account, its handle to copy and the refused call like any Code page", () => {
  const html = render({ sec: "code", id: "c_portal" });
  const detail = text(html);
  expect(detail).toContain("Kundenportal-Eingang");
  expect(detail).toContain("Läuft als");
  expect(detail).toContain("Code von Werkstattbuch");
  expect(detail).toContain("code-7k2q9m4xwt");
  expect(detail).toContain("Letzter Lauf");
  expect(detail).toContain("Aufgabe fällig · Space k7qm2x9a");
  expect(detail).not.toContain("event:spaces.item.due");
  expect(detail).toContain("Kein Zugriff auf Space k7qm2x9a.");
  expect(html).toContain('href="/app/spaces/k7qm2x9a"');
  expect(detail).not.toContain("Zielrechte");
  expect(text(render({ sec: "code", id: "c_rechn" }))).not.toContain("Läuft als");
});

test("the open automation shows its database against its limit with export, and its open page reports", () => {
  const html = render({ sec: "code", id: "c_rechn" }, "normal", "en");
  expect(text(html)).toContain("1 of 100 MB");
  expect(text(html)).toContain("Owner's capacity");
  expect(html).toContain("/api/code/authoring/database/c_rechn/export");
  const reports = codePageReportMessages.resolve(["de"]).t;
  const withReports = (area: AreaData): AreaData => ({
    ...area,
    reports: {
      items: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          reporter: { id: data.FIXTURE_PEOPLE.jana, name: "Jana Probe" },
          path: "/woche",
          reason: "security",
          text: "Die Seite fragt nach meinem Passwort.",
          createdAt: "2026-11-12T09:30:00.000Z",
          state: "open",
          resolvedAt: null,
        },
      ],
      nextCursor: null,
    },
  });
  const reported = render({ sec: "code", id: "c_rechn" }, "normal", "de", withReports);
  expect(text(reported)).toContain(reports.title);
  expect(text(reported)).toContain("Sicherheitsproblem");
  expect(text(reported)).toContain("Die Seite fragt nach meinem Passwort.");
  expect(text(reported)).toContain(reports.resolve);
  expect(reported).toContain('href="/code/c_rechn/woche"');
  expect(text(render({ sec: "code", id: "c_rechn" }, "normal", "de", (area) => ({ ...area, reports: "failed" })))).toContain(
    reports.failed,
  );
});

test("policy, groups and effective rights render their rows with values and sources", () => {
  const policy = render({ sec: "policy" });
  const words = text(policy);
  expect(words).toContain("Voreinstellung „Eigene“ gilt");
  expect(words).toContain("Jana Probe");
  expect(words).toContain("Was Automationen ohne Menschen tun dürfen.");
  expect(words).toContain("Für andere sichtbar");
  expect(words).not.toContain("silent: shared");
  expect(words).toContain("Braucht immer einen Menschen");
  expect(policy).toContain('data-k2-part="Field"');
  expect(policy).toContain('href="/admin/code?sec=history"');
  const groups = text(render({ sec: "groups", id: data.FIXTURE_GROUPS.buchhaltung }));
  expect(groups).toContain("Buchhaltung");
  expect(groups).toContain("Verwaltung");
  expect(groups).toContain("Wie Standard");
  expect(text(render({ sec: "groups" }, "empty"))).toContain("Füge eine Gruppe hinzu");
  const effective = text(render({ sec: "effective", id: data.FIXTURE_PEOPLE.tom }));
  expect(effective).toContain("Tom Beispiel");
  expect(effective).toContain("„Nie“ aus Gruppe Praktikum gilt immer");
  expect(effective).toContain("aus Gruppe Buchhaltung");
  expect(text(render({ sec: "effective" }))).toContain("Suche eine Person");
  expect(text(render({ sec: "policy" }, "fail"))).toContain("Erneut versuchen");
});

test("the history says who changed which row from what to what, with older pages by address", () => {
  const history = text(render({ sec: "history" }));
  expect(history).toContain("Jana Probe");
  expect(history).toContain("Sendet (Praktikum)");
  expect(history).toContain("wie Standard");
  for (const label of ["Löscht", "Nicht rückgängig", "Bezieht Personen ein", "Ändert Zugriff", "Läuft weiter", "Sensibel"])
    expect(history).toContain(label);
  expect(text(render({ sec: "history" }, "empty"))).toContain("Es gilt die Voreinstellung");
  const older = render({ sec: "history" }, "long");
  expect(text(older)).toContain("Ältere Änderungen laden");
  expect(older).toContain('href="/admin/code?sec=history&amp;after=2"');
  expect(text(render({ sec: "history" }))).not.toContain("Ältere Änderungen laden");
  expect(text(render({ sec: "history" }, "fail"))).toContain("Erneut versuchen");
});

test("cleanup shows deletion jobs and retries, while access stays in the target's share dialog", () => {
  const cleanup = text(render({ sec: "cleanup" }));
  for (const value of [
    "2 Aufträge warten",
    "Code löschen",
    "Code von alt@",
    "Wird der Besitzer eines Codes gelöscht, stoppt Cloud den Code und plant seine Löschung.",
    "Den Zugriff eines Dienstkontos änderst du im normalen Teilen-Dialog des Ziels, wenn du das Ziel verwaltest.",
    "Wartet auf Wiederholung",
    "3 Versuche",
    "Der letzte Versuch ist fehlgeschlagen.",
  ])
    expect(cleanup).toContain(value);
  expect(cleanup).not.toContain("code_activation_draining");
  expect(text(render({ sec: "cleanup" }, "empty"))).toContain("Es warten keine Löschaufträge für Code.");
  expect(text(render({ sec: "cleanup" }, "normal", "en"))).toContain(
    "When a Code owner is deleted, Cloud stops the Code and schedules its deletion.",
  );
  expect(text(render({ sec: "cleanup" }, "fail"))).toContain("Erneut versuchen");
});

test("limits are settings with their value beside them, grouped; runners show places, queue and waiting time", () => {
  const limits = render({ sec: "limits" });
  expect(limits).toContain('data-k2-part="Field"');
  for (const label of [
    "Wanduhr je Lauf (ms)",
    "Brückenaufrufe je Lauf",
    "Datenbank je Code (Bytes)",
    "KI-Referenzbudget je Versuch (USD)",
    "Gleichzeitige Läufe je Code",
    "Gleichzeitige Läufe je Besitzer",
    "Ein Lauf",
    "KI-Budget",
  ])
    expect(limits).toContain(label);
  expect(render({ sec: "limits" }, "normal", "en")).toContain("AI reference budget per attempt (USD)");
  const runners = text(render({ sec: "runners" }));
  for (const label of ["Runner 1", "8a3c", "5 von 12", "Verbunden", "4 s"]) expect(runners).toContain(label);
  const none = text(render({ sec: "runners" }, "empty"));
  expect(none).toContain("Kein Runner ist verbunden. Keine Automation läuft.");
  expect(none).toContain("2 Min.");
  expect(text(render({ sec: "runners" }, "fail"))).toContain("Erneut versuchen");
});

test("unused databases are a table with size, deadline and access, export and incarnation-bound deletion", () => {
  const html = render({ sec: "databases" });
  const words = text(html);
  for (const label of ["Datenbanken", "4 ungenutzte Datenbanken", "Löschdatum", "Letzter Zugriff", "Größe", "Lea Muster", "4 MB"])
    expect(words).toContain(label);
  expect(html).toContain("/api/code/authoring/database/c_rueck/export");
  expect(html).toContain("Jetzt löschen");
  expect(text(render({ sec: "databases" }, "empty"))).toContain("Keine ungenutzten Datenbanken");
  expect(text(render({ sec: "databases" }, "fail"))).toContain("Erneut versuchen");
});

test("people without the Code admin right see only that Cloud admins manage Code", () => {
  const html = text(render({ sec: "approvals" }, "noperm"));
  expect(html).toContain("Nur Cloud-Admins verwalten Code");
  expect(html).not.toContain("Rückruf bestätigen");
});

test("break-ui: the worst case renders every section with its long, short, foreign and huge values", () => {
  for (const sec of ["approvals", "code", "groups", "history", "cleanup", "databases", "runners"]) {
    const words = text(render({ sec }, "worst"));
    expect({ sec, ok: words.length > 0 }).toEqual({ sec, ok: true });
  }
  expect(text(render({ sec: "approvals" }, "worst"))).toContain("12.345 Freigaben warten");
  expect(text(render({ sec: "code" }, "worst"))).toContain("1.234.567");
  expect(text(render({ sec: "approvals", id: data.FIXTURE_VERSIONS.rueckruf3 }, "worst"))).toContain("Niederlassung Nord-Ost");
});

test("every text of the area exists in every language", () => {
  expect(codeAdminMessages.check()).toEqual([]);
  expect(codeReviewMessages.check()).toEqual([]);
  expect(codePageReportMessages.check()).toEqual([]);
});
