import type { BaseSummary, FileEntry } from "../contracts";
import type { DirectoryView, WorkspaceSnapshot } from "./workspace-state";

// Invented folders for the v2 folder screen's browser test and design review: a fixed "now", no real people or files.

export const FIXTURE_NOW = "2026-11-25T12:00:00.000Z";
export const FIXTURE_TIME_ZONE = "Europe/Berlin";
/** The states a test can ask the harness for: the ordinary folder, the worst case, and a folder of 1,000 entries. */
export type FixtureCase = "plain" | "worst" | "huge";

export const fixtureBase: BaseSummary = {
  id: "demo",
  name: "Werkstatt",
  area: "cloud",
  kind: "groups",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: false,
};
const hoursAgo = (hours: number) => new Date(Date.parse(FIXTURE_NOW) - hours * 3_600_000).toISOString();
const entry = (path: string, directory: boolean, size: number, hours: number): FileEntry => ({
  name: path.split("/").at(-1)!,
  path,
  directory,
  size: directory ? 0 : size,
  modified: hoursAgo(hours),
  actions: { write: true, move: true, share: true },
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
  entry("Zuschnitt Küchenfront.dxf", false, 1_024_000, 300),
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
  return index < 40 ? entry(`Ordner ${number}`, true, 0, index) : entry(`Beleg ${number}.pdf`, false, 10_000 + index * 37, index);
});

const entries = (fixture: FixtureCase) => (fixture === "worst" ? worst : fixture === "huge" ? huge : plain);

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
  bases: { items: [fixtureBase], issues: [], editor: null },
  selectedId: fixtureBase.id,
  directory,
  errorCode: null,
  now: FIXTURE_NOW,
});
