import type { BaseSummary, DirectoryResult, FileEntry, OfficeEditorLaunch } from "../contracts";

// A fictional team storage with one long folder of office files, so its listing scrolls.
export const editorBase: BaseSummary = {
  id: "cloud:groups:nordlicht",
  locationKey: "nordlicht",
  area: "cloud",
  kind: "groups",
  name: "Team Nordlicht",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
export const editorBases = { items: [editorBase], issues: [], editor: { documentFormat: "odf" as const } };
export const editorFolder = "Einkauf";
const file = (name: string, index: number): FileEntry => ({
  name,
  path: `${editorFolder}/${name}`,
  directory: false,
  size: 4_096 + index * 512,
  modified: new Date(Date.UTC(2026, 9, 28, 9, 30) - index * 3_600_000).toISOString(),
  actions: { write: true, move: true, share: true },
});
export const editorEntries: FileEntry[] = Array.from({ length: 60 }, (_, index) =>
  file(`lieferant-${String(index + 1).padStart(2, "0")}.ods`, index),
);
export const editorDirectory = (): DirectoryResult => ({ base: editorBase, path: editorFolder, items: editorEntries, next: null });
/** Collabora is played by a page on another origin that loads at once and offers its own close. */
export const officeOrigin = "http://office.test";
export const editorLaunch = (path: string): OfficeEditorLaunch => ({
  base: editorBase,
  entry: editorEntries.find((entry) => entry.path === path) ?? file(path.split("/").at(-1)!, 0),
  action: `${officeOrigin}/browser/cool.html?WOPISrc=fictional`,
  token: "fictional.token",
  tokenTtl: 1_900_000_000_000,
  canWrite: true,
  managed: true,
});
