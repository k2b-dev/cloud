import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-code-area-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { CodeAreaView }, { codeAdminMessages }, { parseCodeAreaQuery }, { codeFixtureData }, data] = await Promise.all([
  import("@k2b/ui"),
  import("./view"),
  import("./messages"),
  import("./area"),
  import("./CodeArea.fixture-data"),
  import("./CodeArea.fixture-data"),
]);

type State = Parameters<typeof codeFixtureData>[0];
const render = (query: Record<string, string>, state: State = "normal", locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeAreaView, {
          t: codeAdminMessages.resolve([locale]).t,
          locale,
          dateConfig: { locale: locale === "de" ? "de-DE" : "en-GB", timeZone: "Europe/Berlin" },
          query: parseCodeAreaQuery(query),
          data: state === "noperm" ? null : codeFixtureData(state, query, locale),
          noPermission: state === "noperm",
          retryHref: "/admin/code",
          appNames: { mail: "Mail", spaces: "Spaces", werkstatt: "Werkstattbuch" },
        });
      },
    }),
  );
test("approval lists every declared origin, including requests without secrets", () => {
  const html = render({ sec: "approvals", id: data.FIXTURE_VERSIONS.rueckruf3 });
  expect(html).toContain("Ursprünge im Internet");
  expect(html).toContain("https://bank.example");
  expect(html).toContain("https://status.example:8443");
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

test("approvals render list, review, decided, empty, error and missing states", () => {
  const list = render({ sec: "approvals" });
  expect(list).toContain("4 Versionen warten");
  expect(list).toContain("+3 −1 Zeilen");
  expect(list).toContain("neu · 20 Zeilen");
  expect(list).toContain("2 Dateien geändert");
  expect(list).toContain("Wähle eine Version.");

  const detail = render(review);
  expect(detail).toContain("Rückruf bestätigen · Version 3");
  expect(detail).toContain("1 von 4");
  expect(detail).toContain("Warum du freigibst");
  expect(detail).toContain("„Bezieht Personen ein“ steht für Lea Muster auf Admin gibt frei, aus dem Standard.");
  expect(detail).toContain("Aufgabe anlegen");
  expect(detail).toContain("spaces.task.create · an Space sp_2lg8");
  expect(detail).toContain("entfällt");
  expect(detail).toContain("Version 2 (freigegeben");
  expect(detail).toContain("Gilt genau für Version 3");
  expect(detail).toContain("https://api.buchhaltung-beispiel.de");
  expect(detail).toContain("von dieser Version deklariert");
  expect(detail).not.toContain("dürfen jede öffentliche HTTPS-Adresse");
  expect(detail).not.toContain("am Tag");
  expect(detail).toContain("Version 3 freigeben");
  expect(detail).toContain("Ablehnen …");

  const first = render({ sec: "approvals", id: data.FIXTURE_VERSIONS.lieferzeit1 });
  expect(first).toContain("Erste Freigabe");
  expect(first).toContain("Kein Vorgänger: der ganze Code von Version 1");
  expect(first).toContain("Diese Version ruft keine Adresse außerhalb von Cloud auf.");

  expect(render(review, "newer")).toContain("Version 3 ist überholt");
  expect(render(review, "own")).toContain("Du hast diese Version geschrieben.");
  expect(render(review, "sole")).toContain("Du gibst deinen eigenen Code frei");
  expect(render(review, "difffail")).toContain("Code nicht geladen");
  const approved = render(review, "approved");
  expect(approved).toContain("Version 3 ist freigegeben.");
  expect(approved).not.toContain("Ablehnen …");
  expect(approved).toContain("Zurücknehmen geht über „Pausieren“ am Code.");
  expect(approved).toContain("Code öffnen");
  expect(approved).not.toContain("zurückziehen");

  const decided = render({ sec: "approvals", tab: "decided" });
  expect(decided).toContain("Termin-Antworten");
  expect(decided).toContain("selbst freigegeben (einziger Admin)");
  expect(decided).toContain("Abgelehnt");

  const empty = render({ sec: "approvals" }, "empty");
  expect(empty).toContain("Nichts freizugeben");
  expect(empty).toContain("Richtlinie ansehen");
  const failed = render({ sec: "approvals" }, "fail");
  expect(failed).toContain("Konnte nicht geladen werden");
  expect(failed).toContain("Erneut versuchen");
  expect(render(review, "missing")).toContain("Diese Anfrage ist geschlossen.");
});

test("all Code renders owners, status and last run, with empty, filtered and error states", () => {
  const list = render({ sec: "code" });
  expect(list).toContain("8 Code von 5 Besitzern");
  expect(list).toContain("Lea Muster · Pausiert: Richtlinie");
  expect(list).toContain("Mail · m_info · Aktiv");
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
  expect(policy).toContain("Was Code ohne Menschen tun darf.");
  expect(policy).toContain("Admin gibt frei");
  expect(policy).toContain("Für andere sichtbar");
  expect(policy).toContain("silent: shared");
  expect(policy).toContain("4 Code");
  expect(policy).toContain("nicht genutzt");
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
  expect(history).toContain("Voreinstellung Admin gibt frei → Eigene");
  // A preset change lists every changed row, also beyond six.
  for (const label of ["Löscht", "Nicht rückgängig", "Bezieht Personen ein", "Ändert Zugriff", "Läuft weiter", "Sensibel"])
    expect(history).toContain(label);
  expect(render({ sec: "history" }, "empty")).toContain("Noch keine Änderung aufgezeichnet");
  expect(render({ sec: "history" }, "fail")).toContain("Konnte nicht geladen werden");
});

test("cleanup, limits and runners render their data, empty and error states", () => {
  const cleanup = render({ sec: "cleanup" });
  expect(cleanup).toContain("Zugriff entfernen");
  expect(cleanup).toContain("Wartet auf Wiederholung");
  expect(cleanup).toContain("3 Versuche");
  expect(cleanup).toContain("letzter Fehler: target_unreachable");
  expect(render({ sec: "cleanup" }, "empty")).toContain("Nichts aufzuräumen");
  const limits = render({ sec: "limits" });
  for (const label of [
    "Wanduhr je Lauf (ms)",
    "Brückenaufrufe je Lauf",
    "Datenbank je Code (Bytes)",
    "KI-Referenzbudget je Lauf (USD)",
    "Gleichzeitige Läufe je Code",
    "Gleichzeitige Läufe je Besitzer",
  ])
    expect(limits).toContain(label);
  const runners = render({ sec: "runners" });
  expect(runners).toContain('data-section="code-runners"');
  for (const label of ["Instanzen", "Freie Plätze", "Warteschlange", "Längste Wartezeit", "4 s", "8a3c1e20-5d1b-4c2f-9a10-1b2c3d4e5f60"])
    expect(runners).toContain(label);
  const none = render({ sec: "runners" }, "empty");
  expect(none).toContain("Kein Runner meldet sich");
  expect(none).toContain("2 Min.");
  expect(render({ sec: "runners" }, "fail")).toContain("Konnte nicht geladen werden");
});

test("people without the Cloud-admin role see only the no-permission state", () => {
  const html = render({ sec: "approvals" }, "noperm");
  expect(html).toContain("Nur Cloud-Admins verwalten Code");
  expect(html).not.toContain("Freigaben");
});
