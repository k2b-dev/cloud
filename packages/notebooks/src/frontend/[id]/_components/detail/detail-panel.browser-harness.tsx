import type { NotebookPresenceParticipant } from "@k2b/cloud/contracts";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { PublicNoteComment } from "../../../../api/public-resources";
import type { NoteAuthors } from "../../../../lib/activity-actions";
import { ACTIVE_HEADING_EVENT, PRESENCE_EVENT, PRESENCE_LOCATIONS_EVENT, type PresenceLocationsEventDetail, SYNC_STATE_EVENT } from "./events";
import NotebookDetailPanel from "./NotebookDetailPanel.island";
import type { TocItem } from "./toc";

/**
 * The note side panel in the floating workspace detail, with synthetic data. The page's server answers the panel's
 * activity and avatar requests; `?state=` picks one of the states the panel has to cover.
 */
export type DetailPanelHarness = {
  presence: (count: number) => void;
  offline: (on: boolean) => void;
  heading: (id: string | null) => void;
};

declare global {
  interface Window {
    harness: DetailPanelHarness;
  }
}

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "standard";
const theme = params.get("theme") ?? "light";
document.body.dataset.theme = theme;
if (theme === "dark") document.body.classList.add("k2b-dark");

const minutesAgo = (minutes: number) => new Date(Date.parse("2026-10-16T19:30:00.000Z") - minutes * 60_000).toISOString();
const ME = "00000000-0000-4000-8000-000000000001";
const JANA = "00000000-0000-4000-8000-000000000002";
const PAUL = "00000000-0000-4000-8000-000000000003";
const MIRA = "00000000-0000-4000-8000-000000000004";
const TOM = "00000000-0000-4000-8000-000000000005";
const LENA = "00000000-0000-4000-8000-000000000006";
const CAN = "00000000-0000-4000-8000-000000000007";

const comment = (id: string, userId: string, name: string, avatar: boolean, minutes: number, content: string, edited = false): PublicNoteComment => ({
  id,
  notebookId: "book01",
  noteId: "note01",
  authorUserId: userId,
  authorDisplayName: name,
  authorAvatarHash: avatar ? "h1" : null,
  content,
  createdAt: minutesAgo(minutes),
  updatedAt: edited ? minutesAgo(minutes - 5) : minutesAgo(minutes),
  canEdit: userId === ME,
  canDelete: userId === ME,
});

const fewComments = [
  comment("c1", JANA, "Jana Berger", true, 26 * 60, "Ich habe den Abschnitt zur Kühlkette ergänzt. Bitte einmal gegenlesen."),
  comment("c2", PAUL, "Paul Wagner", false, 120, "Passt so. Die 7 °C würde ich fett setzen."),
  comment("c3", ME, "Anna Becker", true, 60, "Ist fett gesetzt.", true),
];
const manyComments = [
  ...[
    [JANA, "Jana Berger", true, "Ich habe den Abschnitt zur Kühlkette ergänzt. Bitte einmal gegenlesen."],
    [PAUL, "Paul Wagner", false, "Passt. Sollen wir die 7 °C als Grenzwert fett setzen?"],
    [JANA, "Jana Berger", true, "Ja, gute Idee."],
    [TOM, "Tom Krüger", false, "Rampe 4 ist ab November auch für Kühlware freigegeben."],
    [MIRA, "Mira Schulz", true, "Dann müssen wir die Tabelle der Rampen anpassen."],
    [TOM, "Tom Krüger", false, "Mache ich heute Nachmittag."],
    [LENA, "Lena Hoffmann", true, "Wer ist Ansprechpartner für Retouren?"],
    [JANA, "Jana Berger", true, "Can aus dem Versand. Ich trage ihn ein."],
    [CAN, "Can Yilmaz", false, "Danke! Durchwahl ist 214."],
    [PAUL, "Paul Wagner", false, "Die Zählung bei Abweichungen über 2 % machen wir jetzt zu zweit. Steht das schon drin?"],
    [MIRA, "Mira Schulz", true, "Ja, im Abschnitt Mengen erfassen, zweiter Absatz."],
    [JANA, "Jana Berger", true, "Ich habe noch ein Foto-Beispiel für Schäden angehängt."],
  ].map(([userId, name, avatar, content], index) =>
    comment(`m${index}`, userId as string, name as string, avatar as boolean, (12 - index) * 300, content as string),
  ),
];

const shortOutline: TocItem[] = [
  { id: "wareneingang", level: 1, text: "Wareneingang" },
  { id: "ueberblick", level: 2, text: "Überblick" },
  { id: "anlieferung", level: 2, text: "Anlieferung anmelden" },
  { id: "annahme", level: 2, text: "Annahme und Sichtprüfung" },
  { id: "mengen", level: 2, text: "Mengen erfassen" },
  { id: "lagerplaetze", level: 2, text: "Lagerplätze zuweisen" },
];
const longOutline: TocItem[] = [
  { id: "wareneingang", level: 1, text: "Wareneingang" },
  { id: "ueberblick", level: 2, text: "Überblick" },
  { id: "anlieferung", level: 2, text: "Anlieferung anmelden" },
  { id: "zeitfenster", level: 3, text: "Zeitfenster an der Rampe" },
  { id: "gefahrgut", level: 3, text: "Gefahrgut vorab melden" },
  { id: "annahme", level: 2, text: "Annahme und Sichtprüfung" },
  { id: "kuehlware", level: 3, text: "Kühlware" },
  { id: "trockenware", level: 3, text: "Trockenware" },
  { id: "mengen", level: 2, text: "Mengen erfassen" },
  { id: "abweichungen", level: 2, text: "Abweichungen melden" },
  { id: "fotos", level: 3, text: "Fotos und Lieferschein" },
  { id: "lagerplaetze", level: 2, text: "Lagerplätze zuweisen" },
  { id: "ansprechpartner", level: 2, text: "Ansprechpartner" },
];

const many = state === "many";
const empty = state === "empty";
const comments = empty ? [] : many ? manyComments : fewComments;
const jana = { kind: "user" as const, id: JANA, displayName: "Jana Berger", avatarHash: "h1" };
const authors: NoteAuthors = empty
  ? { createdBy: { kind: "user", id: ME, displayName: "Anna Becker", avatarHash: "h1" }, lastEditedBy: { kind: "user", id: ME, displayName: "Anna Becker", avatarHash: "h1" } }
  : { createdBy: jana, lastEditedBy: jana };

const participant = (userId: string, displayName: string, avatar: boolean, peerCount = 1): NotebookPresenceParticipant => ({
  userId,
  displayName,
  avatarHash: avatar ? "h1" : null,
  color: "#0284c7",
  peerCount,
  joinedAt: minutesAgo(5),
});
const everyone = [
  participant(JANA, "Jana Berger", true),
  participant(PAUL, "Paul Wagner", false, 2),
  participant(MIRA, "Mira Schulz", true),
  participant(TOM, "Tom Krüger", false),
  participant(LENA, "Lena Hoffmann", true, 3),
  participant(ME, "Anna Becker", true),
];
const locations: PresenceLocationsEventDetail = {
  [JANA]: { writing: true, headingId: "mengen", headingText: "Mengen erfassen" },
  [PAUL]: { writing: false, headingId: null, headingText: null },
  [MIRA]: { writing: false, headingId: null, headingText: null },
  [TOM]: { writing: true, headingId: "anlieferung", headingText: "Anlieferung anmelden" },
  [LENA]: { writing: false, headingId: null, headingText: null },
};

const presence = (count: number) => {
  const others = everyone.filter((person) => person.userId !== ME).slice(0, count);
  window.dispatchEvent(new CustomEvent(PRESENCE_EVENT, { detail: [...others, everyone.at(-1)!] }));
  window.dispatchEvent(new CustomEvent(PRESENCE_LOCATIONS_EVENT, { detail: locations }));
};
const offline = (on: boolean) =>
  window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail: { connected: !on, lastSavedAt: on ? minutesAgo(6) : null } }));
const heading = (id: string | null) => window.dispatchEvent(new CustomEvent(ACTIVE_HEADING_EVENT, { detail: { id } }));
window.harness = { presence, offline, heading };

const title =
  state === "longtitle"
    ? "Wareneingang, Annahme und Einlagerung von Kühlware, Trockenware und Gefahrgut an allen Rampen des Zentrallagers"
    : "Wareneingang";

render(
  () => (
    <LocaleProvider locale="de">
      <AppWorkspace mobileSurface="flush" class="h-full" resizable={false}>
        <AppWorkspace.Sidebar defaultSize={256} label="Handbuch Logistik">
          <div style="padding: 1rem; font-size: 0.8125rem">Handbuch Logistik</div>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <div style="padding: 2.5rem 3rem; font-size: 0.9375rem; line-height: 1.6">
              <h1 style="font-size: 1.75rem; font-weight: 700; margin: 0 0 1rem">Wareneingang</h1>
              <p>Der Wareneingang ist die erste Station im Lager. Hier prüfen wir jede Lieferung, bevor sie ins System gebucht wird.</p>
            </div>
          </AppWorkspace.Main>
          <NotebookDetailPanel
            mode={state === "readonly" ? "read" : "edit"}
            fullWidth={false}
            initiallyOpen
            tocItems={empty ? [{ id: "wareneingang", level: 1, text: "Wareneingang" }] : many ? longOutline : shortOutline}
            taskProgress={empty ? { done: 0, total: 0 } : many ? { done: 5, total: 9 } : { done: 2, total: 4 }}
            attachments={
              many
                ? [
                    { id: "a1", kind: "file", filename: "Rampenplan.pdf", notebookId: "book01", mimeType: "application/pdf", sizeBytes: 98_304, createdBy: JANA, createdAt: minutesAgo(400) },
                    { id: "a2", kind: "file", filename: "Lieferantenliste.xlsx", notebookId: "book01", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 18_432, createdBy: JANA, createdAt: minutesAgo(400) },
                  ]
                : []
            }
            backlinks={
              many
                ? [
                    { noteId: "n2", title: "Onboarding", notebookId: "book01", notebookName: "Handbuch Logistik", updatedAt: minutesAgo(30) },
                    { noteId: "n3", title: "Inventur 2026", notebookId: "book01", notebookName: "Handbuch Logistik", updatedAt: minutesAgo(30) },
                    { noteId: "n4", title: "Retouren", notebookId: "book02", notebookName: "Handbuch Versand", updatedAt: minutesAgo(30) },
                  ]
                : []
            }
            namedBlocks={
              many
                ? [
                    { name: "rampen", type: "table", line: 4 },
                    { name: "grenzwerte-kuehlware", type: "data", line: 20 },
                  ]
                : []
            }
            currentNotebookId="book01"
            notebookId="book01"
            noteId="note01"
            noteTitle={title}
            contentMd="# Wareneingang"
            createdAt={minutesAgo(empty ? 23 * 60 : 3 * 24 * 60)}
            updatedAt={minutesAgo(empty ? 23 * 60 : 12)}
            lockedAt={state === "locked" ? minutesAgo(90) : null}
            historyIncomplete={false}
            isLocked={state === "locked"}
            canWrite={state !== "readonly"}
            currentUserId={ME}
            noteAuthors={authors}
            initialCommentsPage={{ items: [...comments].reverse(), page: 1, perPage: 30, total: comments.length, hasNext: false }}
            dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
