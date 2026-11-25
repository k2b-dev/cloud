import { LocaleProvider } from "@k2b/ui";
import NotebooksOverview, { type NotebooksOverviewProps } from "./NotebooksOverview";

/** Invented sample data for the overview: render tests, the browser test and `v2-preview.ts`. */
export const OVERVIEW_NOW = "2026-11-20T12:00:00.000Z";

const at = (hoursAgo: number) => new Date(Date.parse(OVERVIEW_NOW) - hoursAgo * 3_600_000).toISOString();

const notebooks: NotebooksOverviewProps["notebooks"] = [
  { id: "Prod01", name: "Produkt", description: "Wissen zum Produkt", icon: "ti ti-bulb", noteCount: 42, lastEditedAt: at(2) },
  { id: "Team01", name: "Team Logistik", description: null, icon: null, noteCount: 7, lastEditedAt: at(30) },
  { id: "Rezep1", name: "Rezepte", description: "Was wir kochen", icon: "ti ti-chef-hat", noteCount: 0, lastEditedAt: null },
];

/** The worst case: long names without breaks, huge counts, non-Latin text, emoji. */
const worstNotebooks: NotebooksOverviewProps["notebooks"] = [
  ...notebooks,
  {
    id: "Long01",
    name: "Bauantragsunterlagenvervollständigungsübersicht für das Erweiterungsgebäude Nord",
    description: null,
    icon: "ti ti-building",
    noteCount: 123_456,
    lastEditedAt: at(400),
  },
  { id: "Kanji1", name: "研究ノート 🧪 第二版", description: null, icon: null, noteCount: 3, lastEditedAt: at(1) },
];

const recentNotes: NotebooksOverviewProps["recentNotes"] = [
  { id: "Note01", notebookId: "Prod01", notebookName: "Produkt", notebookIcon: "ti ti-bulb", title: "Startplan Herbst", updatedAt: at(2) },
  { id: "Note02", notebookId: "Team01", notebookName: "Team Logistik", notebookIcon: null, title: "Tourenplanung KW 48", updatedAt: at(5) },
  { id: "Note03", notebookId: "Prod01", notebookName: "Produkt", notebookIcon: "ti ti-bulb", title: "Preisliste 2027", updatedAt: at(50) },
];

const worstNotes: NotebooksOverviewProps["recentNotes"] = [
  {
    id: "Note09",
    notebookId: "Long01",
    notebookName: "Bauantragsunterlagenvervollständigungsübersicht für das Erweiterungsgebäude Nord",
    notebookIcon: "ti ti-building",
    title: "Statikberechnungsnachweisprüfungsergebnisprotokollzusammenfassung_final_v12_wirklich_final.md",
    updatedAt: at(1),
  },
  { id: "Note10", notebookId: "Kanji1", notebookName: "研究ノート 🧪 第二版", notebookIcon: null, title: "实验记录 🧫", updatedAt: at(3) },
  { id: "Note11", notebookId: "Team01", notebookName: "Team Logistik", notebookIcon: null, title: "A", updatedAt: at(900) },
  ...recentNotes,
];

const person = (id: string, displayName: string) => ({ kind: "user" as const, id, displayName, avatarHash: null });

const activity: NotebooksOverviewProps["initialActivity"]["items"] = [
  {
    id: "a1",
    notebook: { id: "Prod01", name: "Produkt", icon: "ti ti-bulb" },
    note: { id: "Note01", title: "Startplan Herbst" },
    noteVersionId: null,
    actor: person("00000000-0000-4000-8000-000000000001", "Sofie Brandt"),
    action: "note.edited",
    metadata: {},
    occurrenceCount: 3,
    createdAt: at(3),
    lastOccurredAt: at(2),
  },
  {
    id: "a2",
    notebook: { id: "Team01", name: "Team Logistik", icon: null },
    note: { id: "Note02", title: "Tourenplanung KW 48" },
    noteVersionId: null,
    actor: person("00000000-0000-4000-8000-000000000002", "Jonas Kraus"),
    action: "comment.created",
    metadata: {},
    occurrenceCount: 1,
    createdAt: at(5),
    lastOccurredAt: at(5),
  },
  {
    id: "a3",
    notebook: { id: "Rezep1", name: "Rezepte", icon: "ti ti-chef-hat" },
    note: null,
    noteVersionId: null,
    actor: { kind: "system", id: null, displayName: "System", avatarHash: null },
    action: "notebook.created",
    metadata: {},
    occurrenceCount: 1,
    createdAt: at(80),
    lastOccurredAt: at(80),
  },
];

export const overviewFixture = (
  options: { worst?: boolean; empty?: boolean; activityError?: string | null; more?: boolean } = {},
): NotebooksOverviewProps => ({
  notebooks: options.empty ? [] : options.worst ? worstNotebooks : notebooks,
  templates: [
    { id: "daily", name: "Tagebuch", description: "Eine Notiz pro Tag mit Rückblick.", icon: "ti ti-calendar" },
    { id: "recipe", name: "Rezepte", description: "Zutaten, Schritte und Bilder.", icon: "ti ti-chef-hat" },
  ],
  recentNotes: options.empty ? [] : options.worst ? worstNotes : recentNotes,
  initialActivity: { items: options.empty ? [] : activity, nextCursor: options.more ? "cursor-2" : null },
  initialActivityError: options.activityError ?? null,
  initialPinnedNotebookIds: options.empty ? [] : ["Team01"],
  dateConfig: { locale: "de", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
  now: OVERVIEW_NOW,
});

/** The overview with the worst-case sample, for `bun packages/ui/scripts/v2-preview.ts`. */
export default function OverviewPreview() {
  return (
    <LocaleProvider locale="de">
      <NotebooksOverview {...overviewFixture({ worst: true, more: true })} />
    </LocaleProvider>
  );
}
