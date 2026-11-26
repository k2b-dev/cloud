import type { ActivityItem, ActivityPage, OverviewNotebook, RecentNote } from "./NotebooksHome";

/** The test's frozen time; every date of the fixture lies before it. */
export const HOME_NOW = "2026-11-26T09:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(HOME_NOW) - minutes * 60_000).toISOString();

/** Invented notebooks of a warehouse team; `many` adds long names until there are 200. */
export const notebooks = (many: boolean): OverviewNotebook[] => {
  const base: [string, string | null, number][] = [
    ["Handbuch Lager", "ti ti-forklift", 24],
    ["Projekt Hallenumbau", "ti ti-building", 12],
    ["Einkauf 2027", "ti ti-shopping-cart", 8],
    ["Onboarding", "ti ti-school", 15],
    ["Qualitätssicherung", null, 31],
    ["Fuhrpark", "ti ti-truck", 6],
    ["Team Vertrieb", "ti ti-users", 19],
    ["Ideen", "ti ti-bulb", 0],
  ];
  const list = base.map(([name, icon, noteCount], index) => ({
    id: `book${String(index).padStart(2, "0")}`,
    name,
    description: null,
    icon,
    noteCount,
    lastEditedAt: minutesAgo(index * 90),
  }));
  if (!many) return list;
  for (let index = list.length; index < 200; index++)
    list.push({
      id: `book${String(index).padStart(3, "0")}`,
      name: index % 7 === 0 ? `Protokolle der Abteilungsleitungsrunde für Lager, Versand und Kundendienst ${index}` : `Notizbuch ${index}`,
      description: null,
      icon: null,
      noteCount: index * 3,
      lastEditedAt: minutesAgo(index * 60),
    });
  return list;
};

export const recentNotes: RecentNote[] = [
  ["Wochenplan KW 48", "book00", "Handbuch Lager", "ti ti-forklift"],
  ["Rampe 2: Ablauf beim Wareneingang", "book00", "Handbuch Lager", "ti ti-forklift"],
  ["Kosten Bauabschnitt 2", "book01", "Projekt Hallenumbau", "ti ti-building"],
  ["Rahmenvertrag Verpackung", "book02", "Einkauf 2027", "ti ti-shopping-cart"],
  ["Erste Woche", "book03", "Onboarding", "ti ti-school"],
  ["Reklamation Kunde Lindqvist", "book04", "Qualitätssicherung", null],
  ["Wartung Stapler 3", "book05", "Fuhrpark", "ti ti-truck"],
].map(([title, notebookId, notebookName, notebookIcon], index) => ({
  id: `note${index}`,
  notebookId: notebookId as string,
  notebookName: notebookName as string,
  notebookIcon: notebookIcon as string | null,
  title: title as string,
  updatedAt: minutesAgo(index * 37 + 4),
}));

const actors = [
  { kind: "user" as const, id: "u1", displayName: "Lena Hartwig", avatarHash: null },
  { kind: "user" as const, id: "u2", displayName: "Felix Thal", avatarHash: null },
  { kind: "service_account" as const, id: "s1", displayName: "Inventur-Agent", avatarHash: null },
  { kind: "system" as const, id: null, displayName: "System", avatarHash: null },
];
const actions = ["note.updated", "note.created", "note.renamed", "note.moved", "notebook.updated"];
/** The activity across every notebook, newest first; the server serves it in pages. */
export const activity = (count: number): ActivityItem[] =>
  Array.from({ length: count }, (_, index) => {
    const note = recentNotes[index % recentNotes.length]!;
    return {
      id: `activity${index}`,
      notebook: { id: note.notebookId, name: note.notebookName, icon: note.notebookIcon },
      note: actions[index % actions.length] === "notebook.updated" ? null : { id: note.id, title: note.title },
      noteVersionId: null,
      actor: actors[index % actors.length]!,
      action: actions[index % actions.length]!,
      metadata: {},
      occurrenceCount: 1,
      createdAt: minutesAgo(index * 11 + 2),
      lastOccurredAt: minutesAgo(index * 11 + 2),
    };
  });
/** A page of the activity, as the API serves it: `cursor` is the index of its first entry. */
export const activityPage = (all: readonly ActivityItem[], cursor: number, size = 30): ActivityPage => ({
  items: all.slice(cursor, cursor + size),
  nextCursor: cursor + size < all.length ? String(cursor + size) : null,
});
