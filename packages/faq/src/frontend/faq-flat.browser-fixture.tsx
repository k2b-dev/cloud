import { LocaleProvider } from "@k2b/ui";
import type { FaqEntry } from "../contracts";
import FaqAdmin from "./_components/FaqAdmin";
import FaqPage from "./_components/FaqPage";

// Invented questions only; the timestamps are fixed.
const AT = "2026-11-21T10:00:00.000Z";
const QUESTIONS = [
  [
    "Wie setze ich mein Passwort zurück?",
    "Öffne **Profil → Sicherheit** und wähle *Passwort ändern*. Ohne Zugang hilft die Anmeldeseite mit *Passwort vergessen*.",
  ],
  [
    "Wer sieht meine Dateien?",
    "Nur du und die Personen, mit denen du einen Ordner teilst. Freigaben stehen in der Detailspalte der Datei.",
  ],
  ["Wie groß darf ein Anhang in Mail sein?", "Bis 25 MB je Nachricht. Größere Dateien teilst du als Link aus Dateien."],
  [
    "Kann ich Cloud auf dem Telefon nutzen?",
    "Ja. Öffne die Adresse im Browser und wähle *Zum Startbildschirm*; Cloud startet dann wie eine App.",
  ],
  [
    "Wo finde ich gelöschte Kontakte?",
    "Gelöschte Kontakte bleiben 30 Tage im Papierkorb des Adressbuchs und lassen sich dort wiederherstellen.",
  ],
  ["Wie lange bleiben Entwürfe gespeichert?", "Bis du sie sendest oder löschst; sie werden beim Schreiben laufend gesichert."],
  ["Warum sehe ich ein Werkzeug nicht?", "Manche Werkzeuge schaltet die Verwaltung frei. Frag deine Verwaltung, wenn eines fehlt."],
  ["Wie melde ich einen Fehler?", "Über **Hilfe → Problem melden**. Ein Bildschirmfoto hilft uns, den Fehler schnell zu finden."],
  ["Wie ändere ich die Sprache der Oberfläche?", "In **Profil → Sprache und Region**. Die Änderung gilt sofort für alle Apps."],
  [
    "Was passiert mit meinen Daten, wenn ich gehe?",
    "Deine Verwaltung entscheidet, wann ein Zugang endet. Vorher kannst du deine Dateien und Kontakte exportieren.",
  ],
  ["Kann ich einen Termin mit Gästen teilen?", "Ja, mit einer Einladung per Mail. Gäste brauchen keinen eigenen Zugang."],
  [
    "Wie funktioniert die Suche über alle Apps?",
    "Drücke `Strg K` oder `⌘ K` und tippe los. Treffer aus allen Apps stehen nach App geordnet.",
  ],
] as const;

const entries = (count: number): FaqEntry[] =>
  QUESTIONS.slice(0, count).map(([question, answer], index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    translations: Object.fromEntries((index % 3 === 0 ? ["de", "en"] : ["de"]).map((language) => [language, { question, answer }])),
    audience: index % 2 ? (["user"] as const) : (["anonymous", "guest", "user"] as const),
    position: index,
    createdAt: AT,
  }));

export type FaqScenario = "few" | "many" | "empty";

/** The public page and the admin list, each with two, twelve, or no entries. */
export default function FaqFlatFixture(props: { scenario: FaqScenario; view: "public" | "admin" }) {
  const count = props.scenario === "few" ? 2 : props.scenario === "many" ? QUESTIONS.length : 0;
  return (
    <LocaleProvider locale="de">
      <div class="faq-fixture" style="flex:1;min-width:0;overflow:auto;scrollbar-gutter:stable;padding:16px">
        {props.view === "public" ? (
          <FaqPage entries={QUESTIONS.slice(0, count).map(([question, answer]) => ({ question, answer }))} />
        ) : (
          <FaqAdmin entries={entries(count)} />
        )}
      </div>
    </LocaleProvider>
  );
}
