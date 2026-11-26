import type { ActivityEntry, ActivityPage, ActivitySide, ShareAccessCounts } from "../activity-contracts";
import type { BaseSummary, FileEntry, FileVersion, MarkdownLaunch, MarkedEntry, SharePage, ShareView, StorageFacts } from "../contracts";
import type { DirectoryView, WorkspaceSnapshot } from "./workspace-state";

// Invented folders for the v2 folder screen's browser test and design review: a fixed "now", no real people or files.

export const FIXTURE_NOW = "2026-11-25T12:00:00.000Z";
export const FIXTURE_TIME_ZONE = "Europe/Berlin";
/** The states a test can ask the harness for: the ordinary folder, the worst case, and a folder of 1,000 entries. */
export type FixtureCase = "plain" | "worst" | "huge" | "empty";

export const fixtureBase: BaseSummary = {
  id: "demo",
  name: "Werkstatt",
  area: "cloud",
  kind: "groups",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
};
const hoursAgo = (hours: number) => new Date(Date.parse(FIXTURE_NOW) - hours * 3_600_000).toISOString();
/** Who changed an entry last and how many links lead to it, as the listing reads them; steady per path. */
const AUTHORS = ["Felix Thal", "Mira Sommer", "Jana Krüger", "Sven Yilmaz"];
const factsOf = (path: string) => {
  const seed = [...path].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const name = AUTHORS[seed % AUTHORS.length]!;
  return {
    author: { userId: `user-${seed % AUTHORS.length}`, name },
    links: seed % 5 === 0 ? 1 : seed % 11 === 0 ? 3 : 0,
  };
};
const entry = (path: string, directory: boolean, size: number, hours: number): FileEntry => ({
  name: path.split("/").at(-1)!,
  path,
  directory,
  size: directory ? 0 : size,
  modified: hoursAgo(hours),
  actions: { write: true, move: true, share: true },
  facts: factsOf(path),
});

const plain: FileEntry[] = [
  entry("Angebote", true, 0, 30),
  entry("Angebote/Angebot Familie Oswald.pdf", false, 182_400, 30),
  entry("Angebote/Angebot Stadtwerke.pdf", false, 96_120, 54),
  entry("Fotos", true, 0, 2),
  entry("Fotos/Regal Eiche.jpg", false, 2_480_000, 2),
  entry("Budget 2027.xlsx", false, 48_213, 5),
  entry("Lieferplan.pdf", false, 312_000, 80),
  entry("Notizen.md", false, 912, 1),
  entry("Zuschnitt Küchenfront.dxf", false, 1_820_000, 300),
  // the workshop's day, as the approved mockup shows it: photos, a plan, a sheet, a video
  entry("Aufmaß", true, 0, 4),
  entry("Aufmaß/Skizze Wand Nord.png", false, 640_000, 4),
  entry("Ansicht Front Eiche.jpg", false, 4_400_000, 2),
  entry("Bestand Küche vorher.jpg", false, 5_870_000, 20),
  entry("Materialliste.xlsx", false, 49_152, 24),
  entry("Muster Arbeitsplatte Granit.jpg", false, 3_250_000, 72),
  entry("Skizze Hochschrank.png", false, 655_360, 74),
  entry("Rundgang Aufmaß.mp4", false, 171_966_464, 120),
  // what the moved folder holds at its new place (an old address shows it under its card)
  entry("Archiv/2025/Alte Angebote/Kalkulation Bad Weber.xlsx", false, 61_440, 400),
  entry("Archiv/2025/Alte Angebote/Preisliste 2025.pdf", false, 318_000, 420),
  entry("Archiv/2025/Alte Angebote/Rückruf Frau Okafor.md", false, 1_200, 430),
];

/** What break-ui feeds a file list: very long names without breaks, one letter, emoji, other scripts, huge and empty files. */
const worst: FileEntry[] = [
  entry(`${"Sehr-langer-Ordnername-ohne-Leerzeichen-".repeat(4)}Ende`, true, 0, 4),
  entry("A", true, 0, 9000),
  entry("📁 Ablage 🗂️", true, 0, 12),
  entry(`${"Ein sehr langer Dateiname mit vielen Wörtern, der nie aufhört und weiter geht ".repeat(3)}.pdf`, false, 12, 1),
  entry(`${"x".repeat(180)}.txt`, false, 0, 2),
  entry("文件夹里的长文件名示例文档最终版本.docx", false, 7_340_032, 70),
  entry("مستند طويل جدا للاختبار.pdf", false, 1, 3),
  entry("Archiv.tar.gz", false, 98_765_432_109, 40),
  entry("b", false, 1_048_576, 0),
];

const huge: FileEntry[] = Array.from({ length: 1000 }, (_, index) => {
  const number = String(index + 1).padStart(4, "0");
  if (index < 8) return entry(`Ordner ${number}`, true, 0, index);
  // every other file a photo, all through the folder: the grid asks only for the previews of those in view
  return index % 2 === 0
    ? entry(`Beleg ${number}.jpg`, false, 2_400_000 + index, index)
    : entry(`Beleg ${number}.pdf`, false, 10_000 + index * 37, index);
});

const entries = (fixture: FixtureCase) => (fixture === "worst" ? worst : fixture === "huge" ? huge : fixture === "empty" ? [] : plain);

/** The direct children of a folder, ordered as the server orders them: folders first when grouped, then by the sort. */
export function fixtureListing(
  fixture: FixtureCase,
  path: string,
  browse: { sort: string; order: string; type: string; groupFolders: boolean },
): FileEntry[] {
  const children = entries(fixture).filter((item) => item.path.split("/").slice(0, -1).join("/") === path);
  const kept = children.filter((item) =>
    browse.type === "files" ? !item.directory : browse.type === "directories" ? item.directory : true,
  );
  const sign = browse.order === "desc" ? -1 : 1;
  const by = (a: FileEntry, b: FileEntry) =>
    browse.sort === "size"
      ? sign * (a.size - b.size)
      : browse.sort === "modified"
        ? sign * a.modified.localeCompare(b.modified)
        : sign * a.name.localeCompare(b.name, "de");
  return kept.sort((a, b) => (browse.groupFolders && a.directory !== b.directory ? (a.directory ? -1 : 1) : by(a, b)));
}

/** Every entry below a folder whose name holds the words, as a search finds them. */
export function fixtureSearch(fixture: FixtureCase, path: string, words: string): FileEntry[] {
  const lower = words.toLowerCase();
  return entries(fixture).filter((item) => (!path || item.path.startsWith(`${path}/`)) && item.name.toLowerCase().includes(lower));
}

/** One page of a listing as the API pages it: 50 entries, the next page named by its offset. */
export function fixturePage(items: FileEntry[], after: string | null, pages = 1) {
  const start = Number(after ?? 0);
  const end = start + 50 * pages;
  return { items: items.slice(start, end), next: end < items.length ? String(end) : null };
}

export const fixtureDirectory = (path: string, items: FileEntry[], search?: string, next: string | null = null): DirectoryView => ({
  base: fixtureBase,
  path,
  items,
  next,
  actions: { create: true },
  ...(search !== undefined ? { query: search, scope: "tree" as const, total: items.length } : {}),
});

export const fixtureSnapshot = (source: string, directory: DirectoryView): WorkspaceSnapshot => ({
  source,
  bases: { items: fixtureBases, issues: [], editor: null },
  selectedId: fixtureBase.id,
  directory,
  errorCode: null,
  now: FIXTURE_NOW,
});

/** The trash of the sample storage: one entry from a known place, one whose place and time Filegate lost. */
export const fixtureTrash = {
  entries: [
    {
      id: "t-1",
      name: "Alter Entwurf.pdf",
      original: "Angebote/Alter Entwurf.pdf",
      directory: false,
      deletedAt: hoursAgo(3),
      state: "trashed" as const,
    },
    { id: "t-2", name: "Fotos 2025", original: null, directory: true, deletedAt: null, state: "trashed" as const },
  ],
  next: null,
};

/** Favorites across the sample storage, as the API answers them. */
export const fixtureFavorites: MarkedEntry[] = [
  {
    base: { id: fixtureBase.id, name: fixtureBase.name, kind: fixtureBase.kind, area: fixtureBase.area },
    entry: plain[5]!,
    markedAt: hoursAgo(2),
  },
  {
    base: { id: fixtureBase.id, name: fixtureBase.name, kind: fixtureBase.kind, area: fixtureBase.area },
    entry: plain[0]!,
    markedAt: hoursAgo(9),
  },
];

/** The own home beside the workshop, so all storage has two places to show. */
export const fixtureHome: BaseSummary = { ...fixtureBase, id: "home", name: "mira", kind: "users" };
export const fixtureBases = [fixtureHome, fixtureBase];

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────────────────────
const PEOPLE = [
  { userId: "10000000-0000-4000-8000-000000000001", name: "Mira Sommer" },
  { userId: "10000000-0000-4000-8000-000000000002", name: "Felix Thal" },
  { userId: "10000000-0000-4000-8000-000000000003", name: "Jana Krüger" },
  { userId: "10000000-0000-4000-8000-000000000004", name: "Sven Yilmaz" },
];
const side = (path: string, directory = false): ActivitySide => ({
  visibility: "full",
  source: "current",
  name: path.split("/").at(-1)!,
  // sides carry root-relative paths: the storage directory, then its folders
  path: `werkstatt/${path}`,
  root: "groups",
  baseId: "20000000-0000-4000-8000-000000000001",
  publicBaseId: fixtureBase.id,
  relativePath: path,
  itemId: null,
  directory,
  size: null,
  revision: null,
});
const gone = (path: string, directory = false): ActivitySide => ({
  visibility: "disappearance",
  name: path.split("/").at(-1)!,
  // sides carry root-relative paths: the storage directory, then its folders
  path: `werkstatt/${path}`,
  directory,
  publicBaseId: fixtureBase.id,
  relativePath: path,
});
let serial = 0;
const change = (
  action: ActivityEntry["action"],
  minutes: number,
  person: number,
  sides: { before?: ActivitySide; after?: ActivitySide },
  patch: Partial<ActivityEntry> = {},
): ActivityEntry => {
  serial += 1;
  const time = new Date(Date.parse(FIXTURE_NOW) - minutes * 60_000).toISOString();
  return {
    id: `30000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    action,
    state: "done",
    time,
    startedAt: time,
    finishedAt: time,
    actor: { kind: "user", ...PEOPLE[person % PEOPLE.length]! },
    via: "web",
    before: sides.before ?? { visibility: "hidden" },
    after: sides.after ?? { visibility: "hidden" },
    batchId: null,
    ...patch,
  };
};

/** A working day in the workshop: uploads, edits, a move, a rename, a link, the trash, and a run of photos. */
const plainActivity = (): ActivityEntry[] => [
  change("file.upload", 18, 1, { after: side("Projekte/Küche Lindqvist/Ansicht Front Eiche.jpg") }),
  change("file.edit", 51, 0, { after: side("Projekte/Küche Lindqvist/Notizen Kundentermin.md") }),
  change("share.create", 89, 0, { after: side("Angebote/Angebot 2026-118.pdf") }),
  change("item.move", 140, 2, {
    before: side("Eingang/Aufmaß Küche Lindqvist.dxf"),
    after: side("Projekte/Küche Lindqvist/Aufmaß Küche Lindqvist.dxf"),
  }),
  change("item.rename", 190, 3, { before: side("Materialliste alt.xlsx"), after: side("Materialliste.xlsx") }),
  change("item.trash", 260, 1, { before: gone("Angebote/Alter Entwurf.pdf") }),
  ...Array.from({ length: 6 }, (_, index) =>
    change("file.upload", 1_500 + index * 0.2, 2, { after: side(`Fotos/Baustelle/IMG_${4021 + index}.jpg`) }),
  ),
  change("file.overwrite", 1_620, 3, { after: side("Budget 2027.xlsx") }),
  change("folder.create", 2_900, 0, { after: side("Projekte/Treppe Winter", true) }),
  change("item.copy", 4_400, 1, { after: side("Vorlagen/Angebot Vorlage.docx") }),
];

/**
 * What Activity's search finds beyond the day: the vanished draft's earlier steps on other days, by other people, and a
 * second draft that went to the trash before it. Only the search answers with them, so Activity's day stays as it is.
 */
export const fixtureSearchHistory = (): ActivityEntry[] => [
  // Jana uploaded the draft and edited it again: the one person the summary has something to say about
  change("file.edit", 1_450, 2, { after: gone("Angebote/Alter Entwurf.pdf") }),
  change("item.trash", 2_950, 0, { before: gone("Projekte/Treppe Winter/Entwurf Treppe.pdf") }),
  change("file.upload", 4_300, 2, { after: gone("Angebote/Alter Entwurf.pdf") }),
];

/** People break-ui feeds a list of changes: long and compound names, one letter, RTL, emoji, CJK. */
const WORST_PEOPLE = [
  "Aleksandra Wiśniewska-Kowalczyk",
  "J",
  "نور الهدى عبد الرحمن",
  "👩🏽‍💻 Priya",
  "王秀英",
  "Christopher Alexander Montgomery III",
];
const worstPerson = (index: number) => ({ kind: "user" as const, userId: `w-${index}`, name: WORST_PEOPLE[index % WORST_PEOPLE.length]! });

/** What break-ui feeds a history: endless names, one-letter ones, other scripts, emoji, unknown accounts and states. */
const worstActivity = (): ActivityEntry[] => [
  ...WORST_PEOPLE.map((_, index) =>
    change(
      "file.upload",
      2 + index,
      index,
      { after: side(`Eingang/Q3 Board Deck — FINAL (revised) v12 [approved by legal] ${index}.pdf`) },
      { actor: worstPerson(index) },
    ),
  ),
  // markup, an entity and Markdown in a name must read as they are written; no slash, which a path would split
  change("file.upload", 3, 0, { after: side("<img src=x onerror=alert(1)> & &amp; **bold**.md") }),
  change("file.upload", 5, 0, { after: side(`${"Sehr-langer-Ordnername-ohne-Leerzeichen-".repeat(3)}/${"x".repeat(160)}.pdf`) }),
  change("file.edit", 9, 1, { after: side("b") }, { actor: { kind: "user", userId: null, name: null } }),
  change("item.move", 20, 2, { before: side("文件夹/长文件名示例文档.docx"), after: side("مستند/مستند طويل جدا للاختبار.pdf") }),
  change("item.rename", 31, 3, { before: side("📁 Ablage 🗂️/Alt.md"), after: side("📁 Ablage 🗂️/Neu 🎉.md") }),
  change("file.upload", 45, 0, { after: side("Eingang/Scan.pdf") }, { state: "unclear" }),
  change("file.upload", 46, 1, { after: side("Eingang/Scan 2.pdf") }, { state: "failed" }),
  change("item.missing", 80, 0, { before: gone("Archiv/Verschwunden.zip") }, { actor: { kind: "observed", userId: null, name: null } }),
  change("file.upload", 99, 2, { after: side("Eingang/Rechnung.pdf") }, { actor: { kind: "visitor", userId: null, name: null } }),
];

/** A long history: 1,000 changes of four people over several weeks. */
const hugeActivity = (): ActivityEntry[] =>
  Array.from({ length: 1000 }, (_, index) =>
    change(index % 3 === 0 ? "file.edit" : "file.upload", 37 + index * 41, index, {
      after: side(`Belege/${2026 - Math.floor(index / 400)}/Beleg ${String(index + 1).padStart(4, "0")}.pdf`),
    }),
  );

export function fixtureActivity(fixture: FixtureCase): ActivityPage {
  const items = fixture === "worst" ? worstActivity() : fixture === "huge" ? hugeActivity() : fixture === "empty" ? [] : plainActivity();
  return {
    items,
    next: null,
    visibleCount: items.length,
    batches: [],
    exhausted: true,
    scanLimitReached: false,
    searchLimitReached: false,
  };
}

// ── Shares ───────────────────────────────────────────────────────────────────────────────────────────────────────
const link = (index: number, patch: Partial<ShareView> = {}): ShareView => ({
  passwordProtected: index % 3 === 0,
  id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  kind: index % 4 === 3 ? "inbox" : "download",
  url: null,
  title: [
    "Unterlagen Lindqvist",
    "Fotos Baustelle",
    "Angebot Stadtwerke",
    "Belege Steuerbüro",
    "Aufmaß Oswald",
    "Pläne Treppe Winter",
    "Muster Arbeitsplatten",
    "Rechnungen Oktober",
  ][index % 8]!,
  note: null,
  publicNote: null,
  base: { id: fixtureBase.id, name: fixtureBase.name, kind: fixtureBase.kind },
  scope: ["Projekte/Küche Lindqvist", "Fotos", "Angebote", "Eingang", "Projekte/Bad Oswald"][index % 5]!,
  items: index % 4 === 3 ? [] : Array.from({ length: (index % 5) + 1 }, (_, item) => `Angebote/Datei ${item + 1}.pdf`),
  createdBy: PEOPLE[index % PEOPLE.length]!.name,
  createdAt: new Date(Date.parse(FIXTURE_NOW) - index * 86_400_000).toISOString(),
  expiresAt: index % 2 ? new Date(Date.parse(FIXTURE_NOW) + (20 - index) * 86_400_000).toISOString() : null,
  state: index % 7 === 5 ? "revoked" : index % 6 === 4 ? "expired" : "active",
  accessCount: (index * 7) % 23,
  lastAccessedAt: null,
  maxFileSize: 0,
  maxTotalSize: 0,
  showUploadNames: false,
  ...patch,
});

export function fixtureShares(fixture: FixtureCase): SharePage {
  if (fixture === "empty") return { items: [], next: null };
  if (fixture === "huge") return { items: Array.from({ length: 1000 }, (_, index) => link(index)), next: null };
  if (fixture === "worst")
    return {
      items: [
        link(0, { title: `${"Ein sehr langer Linkname ohne Ende ".repeat(4)}`, scope: `${"Unterordner/".repeat(12)}Ziel` }),
        link(1, { title: "x", createdBy: `${"Sehr-langer-Name-".repeat(5)}`, accessCount: 98_765_432 }),
        link(2, { title: "共享链接的长名称示例", createdByKind: "agent" }),
        link(3, { title: "رابط مشاركة طويل جدا", state: "expired" }),
        link(4, { title: "🎉 Fotos 📸", state: "revoked" }),
      ],
      next: null,
    };
  return { items: Array.from({ length: 8 }, (_, index) => link(index)), next: null };
}

/** The one link of an open file, as its detail lists it: active, made by Mira, opened a few times. */
export const fixtureItemShares = (path: string): SharePage => ({
  items: [
    link(0, { title: path.split("/").at(-1) ?? path, scope: path.split("/").slice(0, -1).join("/"), items: [path], state: "active" }),
  ],
  next: null,
});

/** How often the link of an open file was used: three page views and two downloads this week, from one network. */
export const fixtureShareAccess = (from: string, to: string): ShareAccessCounts => ({
  from,
  to,
  timeline: { items: [], next: null },
  pageNetworks: 1,
  pages: 3,
  downloads: 2,
  passwordFailed: 0,
  networks: { known: 1, incomplete: false, overflow: false, items: [], next: null, rolledUp: false },
});

/** Two earlier states of an open file, by two people of the workshop. */
export const fixtureVersions = (): FileVersion[] => [
  {
    id: "v-2",
    created: new Date(Date.parse(FIXTURE_NOW) - 3 * 3_600_000).toISOString(),
    size: 3_900,
    pinned: false,
    comment: null,
    author: "Mira Sommer",
  },
  {
    id: "v-1",
    created: new Date(Date.parse(FIXTURE_NOW) - 26 * 3_600_000).toISOString(),
    size: 3_100,
    pinned: true,
    comment: "Stand Aufmaß",
    author: "Felix Thal",
  },
];

/** A Markdown file in its editor; the test answers its content from `/content`. The worst case is read only, deep and long. */
export const fixtureMarkdown = (origin: string, fixture: FixtureCase = "plain"): MarkdownLaunch => ({
  kind: "markdown",
  managed: false,
  canWrite: fixture !== "worst",
  url: `${origin}/content`,
  base: fixtureBase,
  entry:
    fixture === "worst"
      ? {
          ...plain[7]!,
          name: `${"Benachrichtigungseinstellungen-".repeat(4)}Protokoll.md`,
          path: `${"Sehr-langer-Ordnername-ohne-Leerzeichen/".repeat(3)}${"Benachrichtigungseinstellungen-".repeat(4)}Protokoll.md`,
        }
      : plain[7]!,
});

/** The storages all storage shows: the two of the workshop, every break-ui name, a missing one, or 200 groups. */
export function fixtureStorages(fixture: FixtureCase): BaseSummary[] {
  if (fixture === "huge")
    return [fixtureHome, ...Array.from({ length: 200 }, (_, index) => ({ ...fixtureBase, id: `g-${index}`, name: `Gruppe ${index + 1}` }))];
  if (fixture !== "worst") return fixtureBases;
  return [
    fixtureHome,
    ...[...WORST_PEOPLE, "Benachrichtigungseinstellungen-Benachrichtigungseinstellungen", "A", "🎉 Fest 2026 📸"].map((name, index) => ({
      ...fixtureBase,
      id: `w-${index}`,
      name,
    })),
    { ...fixtureBase, id: "gone", name: "Archiv 2019", status: "missing" as const, reason: "missing" },
  ];
}

/**
 * The storage table's facts for these storages: who changed each last (hours apart), what it holds, how many belong to
 * a group. The worst case leaves facts out ("—"), counts one storage only in part ("≥") and names nobody for one change.
 */
export function fixtureStorageFacts(fixture: FixtureCase, storages: readonly BaseSummary[]): StorageFacts {
  const shown = storages.filter((base) => base.status === "existing");
  const hours = (index: number) => new Date(Date.parse(FIXTURE_NOW) - (index * 7 + 1) * 3_600_000).toISOString();
  return {
    changes: shown.flatMap((base, index) =>
      fixture === "worst" && index % 4 === 3
        ? []
        : [
            {
              baseId: base.id,
              time: hours(index),
              actor:
                fixture === "worst" && index === 1
                  ? { kind: "user" as const, userId: null, name: null }
                  : { kind: "user" as const, ...PEOPLE[index % PEOPLE.length]! },
              via: "web",
            },
          ],
    ),
    usage: shown.flatMap((base, index) =>
      fixture === "worst" && index % 3 === 2
        ? []
        : [{ baseId: base.id, bytes: 1_250_000 * (index + 1) ** 3, complete: !(fixture === "worst" && index === 1) }],
    ),
    usagePending: false,
    members: shown.filter((base) => base.kind === "groups").map((base, index) => ({ baseId: base.id, members: ((index * 5) % 23) + 2 })),
  };
}

/** All storage: the favorites, and what this person did last. */
/** This person's own changes (Mira's), as the reader answers "me"; `limit` as the overview asks for five. */
export const fixtureMine = (limit?: number): ActivityPage => {
  const items = fixtureActivity("plain").items.map((item) => ({ ...item, actor: { kind: "user" as const, ...PEOPLE[0]! } }));
  const shown = limit ? items.slice(0, limit) : items;
  return { ...fixtureActivity("plain"), items: shown, visibleCount: shown.length };
};
/** "Recently by you" on all storage: the first five of this person's own changes. */
/** The files Mira opened in the last days, newest first, as the overview shows them beside her favorites. */
export const fixtureOpened = (): MarkedEntry[] =>
  ["Ansicht Front Eiche.jpg", "Materialliste.xlsx", "Lieferplan.pdf", "Notizen.md"].map((name, index) => ({
    base: { id: fixtureBase.id, name: fixtureBase.name, kind: fixtureBase.kind, area: fixtureBase.area },
    entry: plain.find((item) => item.path === name)!,
    markedAt: hoursAgo(3 + index * 7),
  }));
export const fixtureRecent = () => ({ page: fixtureMine(5), opened: fixtureOpened() });
