import type { PageListEntry } from "../../../service/page-list";
import type { NotebookContext } from "../_components/sidebar/types";
import { NOTES_PER_PAGE, type NotesState } from "./query";

/** Invented sample data for the notes list: render and browser tests. Times relative to a fixed now. */
export const NOTES_NOW = "2026-11-20T12:00:00.000Z";
const at = (hoursAgo: number) => new Date(Date.parse(NOTES_NOW) - hoursAgo * 3_600_000).toISOString();

const titles = [
  ["Tourenplanung KW 48", "Montag Nord, Dienstag Süd. Zwei Fahrer im Urlaub, Ersatz klären.", ["logistik", "planung"]],
  ["Lieferant Holzwerk Brandt", "Lieferzeit 3 Wochen, Mindestmenge 40 Platten, Ansprechpartner Herr Brandt.", ["lieferanten"]],
  ["Onboarding Lager", "Erster Tag: Schlüssel, Sicherheitsunterweisung, Scanner einrichten.", ["team", "onboarding"]],
  ["Preisliste 2027", "Neue Preise ab Januar, Rabattstaffel für Händler angepasst.", ["vertrieb"]],
  ["Retouren Oktober", "17 Retouren, davon 9 Transportschäden. Verpackung prüfen.", ["logistik", "qualität"]],
  ["Messe Leipzig", "Stand 4B, Aufbau Mittwoch, Prospekte bis Freitag bestellen.", ["vertrieb", "planung"]],
  ["Inventur Checkliste", "Zählteams, Zählzettel, Sperrlager, Abgleich mit dem Bestand.", ["lager"]],
  ["Besprechung Montag", "Krankenstand, Urlaubsplanung Dezember, neue Hubwagen.", ["team"]],
  ["Gabelstapler Wartung", "TÜV fällig im März, Batterie tauschen.", ["lager", "wartung"]],
  ["Kundenanfrage Kraus", "Sonderanfertigung 2,40 m, Angebot bis Donnerstag.", ["vertrieb"]],
] as const;

/** Realistic notes: dense rows with previews and tags; `count` repeats them with numbered titles (the huge sample). */
export const sampleNotes = (count: number = titles.length): PageListEntry[] =>
  Array.from({ length: count }, (_, index) => {
    const [title, preview, tags] = titles[index % titles.length]!;
    const round = Math.floor(index / titles.length);
    return {
      shortId: `N${String(index).padStart(5, "0")}`,
      title: round === 0 ? title : `${title} (${round + 1})`,
      preview,
      tags: [...tags],
      createdAt: at(index * 7 + 30),
      updatedAt: at(index * 3 + 1),
      lockedAt: index === 3 ? at(100) : null,
    };
  });

/** The worst case: a title without breaks, a preview of one long word, many tags, no preview. */
export const worstNotes = (): PageListEntry[] => [
  {
    shortId: "W00001",
    title: "Statikberechnungsnachweisprüfungsergebnisprotokollzusammenfassung_final_v12_wirklich_final",
    preview: "Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenherstellungsbetriebsleitungsassistenz".repeat(2),
    tags: ["a", "sehr-langer-tag-name-ohne-ende", "研究", "🧪"],
    createdAt: at(2),
    updatedAt: at(1),
    lockedAt: null,
  },
  { shortId: "W00002", title: "A", preview: null, tags: [], createdAt: at(900), updatedAt: at(800), lockedAt: null },
  ...sampleNotes(),
];

/** Filters and orders like `notebooksService.pages.list`; favorites are the notes with an even number. */
export const filterNotes = (all: PageListEntry[], state: NotesState, page: number, favorites: readonly string[]) => {
  const search = state.search?.toLowerCase();
  const tag = state.filters.tag;
  const favorite = state.filters.favorite;
  const rows = all
    .filter((note) => (favorite === undefined ? true : favorites.includes(note.shortId) === favorite))
    .filter((note) => !tag || note.tags.includes(tag))
    .filter((note) => !search || note.title.toLowerCase().includes(search) || (note.preview ?? "").toLowerCase().includes(search))
    .sort((left, right) =>
      state.sort.field === "title"
        ? left.title.localeCompare(right.title, "de")
        : right[state.sort.field === "created" ? "createdAt" : "updatedAt"].localeCompare(
            left[state.sort.field === "created" ? "createdAt" : "updatedAt"],
          ),
    );
  return { total: rows.length, items: rows.slice((page - 1) * NOTES_PER_PAGE, page * NOTES_PER_PAGE) };
};

export const tagsOf = (all: PageListEntry[]) =>
  [...new Set(all.flatMap((note) => note.tags))]
    .sort()
    .map((tag) => ({ tag, count: all.filter((note) => note.tags.includes(tag)).length }));

/** A writer's context of the sample notebook "Lager & Logistik" with a small tree. */
export const notesContext = (all: PageListEntry[], permission: "read" | "write" = "write"): NotebookContext => {
  const tree = all.slice(0, 6).map((note, index) => ({
    id: note.shortId,
    parentId: null,
    title: note.title,
    position: index + 1,
    hasChildren: false,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    lockedAt: note.lockedAt,
  }));
  return {
    notebook: {
      id: "Lager1",
      name: "Lager & Logistik",
      description: null,
      icon: "ti ti-forklift",
      homepageNoteId: null,
      defaultPresentationMode: "write",
      defaultNoteTitleTemplate: "",
      noteDeletePermission: "write",
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    sidebarTree: { total: tree.length, levels: [{ parentId: null, total: tree.length, offset: 0, items: tree }], expandedIds: [] },
    sidebarList: null,
    selectedNoteId: null,
    userId: "user01",
    settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
    navigationHidden: false,
    fullWidth: false,
    permission,
    attachmentCount: 12,
    favoriteNoteIds: [],
    tags: tagsOf(all),
    pageTemplates: [],
    workspaceCursor: null,
    dateConfig: { locale: "de", timeZone: "Europe/Berlin" },
    sidebarFilter: {},
  };
};
