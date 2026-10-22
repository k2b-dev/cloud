import type { ActivityChain, ActivityEntry, ActivityPage, ActivitySide } from "../activity-contracts";
import type { BaseSummary, DirectoryResult, FileEntry, FileVersion } from "../contracts";
import { filesUrl } from "./urls";
import type { WorkspaceSnapshot } from "./workspace-state";

// Fictional data only. The clock and identities are fixed for both browser engines.
export const historyNow = "2026-10-20T12:30:00.000Z";
export const historyBase: BaseSummary = {
  id: "cloud:groups:0b4c9a52-5f7e-4c47-9d2e-6c1f1f0a7b11",
  area: "cloud",
  kind: "groups",
  name: "Team Vertrieb",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
  stableIds: true,
};
export const historyFile: FileEntry = {
  name: "Notes.txt",
  path: "Notes.txt",
  directory: false,
  size: 24,
  modified: historyNow,
  revision: "notes-current",
};
export const historyVersions: FileVersion[] = [
  { id: "notes-original", created: "2026-10-19T09:00:00.000Z", size: 12, pinned: false, comment: "Initial draft", author: "Mia Weber" },
];
export const historyDirectory: DirectoryResult = { base: historyBase, path: "", items: [historyFile], next: null };
export const historyInspectorSource = filesUrl(historyBase.id, "", null, historyFile.path);
const side = (path: string): ActivitySide => ({
  visibility: "full",
  source: "current",
  name: path.split("/").at(-1)!,
  path,
  root: "cloud",
  baseId: "10000000-0000-4000-8000-000000000001",
  publicBaseId: historyBase.id,
  relativePath: path.slice("groups/vertrieb/".length),
  itemId: "10000000-0000-4000-8000-000000000002",
  directory: true,
  size: null,
  revision: null,
});
export const historyMove: ActivityEntry = {
  id: "10000000-0000-4000-8000-000000000003",
  action: "item.move",
  state: "done",
  time: "2026-10-14T08:41:00.000Z",
  startedAt: "2026-10-14T08:41:00.000Z",
  finishedAt: "2026-10-14T08:41:00.000Z",
  actor: { kind: "user", userId: "10000000-0000-4000-8000-000000000004", name: "Lukas Pohl" },
  via: "agent",
  batchId: null,
  before: {
    visibility: "disappearance",
    name: "Angebote 2025",
    path: "groups/vertrieb/Angebote 2025",
    directory: true,
    publicBaseId: historyBase.id,
    relativePath: "Angebote 2025",
  },
  after: side("groups/vertrieb/Archiv/2025/Angebote 2025"),
};
export const historyChain: ActivityChain = {
  sourceId: historyMove.id,
  hops: [
    {
      activityId: historyMove.id,
      time: historyMove.time,
      actor: historyMove.actor,
      via: historyMove.via,
      before: historyMove.before,
      after: historyMove.after,
    },
  ],
  endpoint: { baseId: historyBase.id, path: "Archiv/2025/Angebote 2025", itemId: "10000000-0000-4000-8000-000000000002" },
  certainty: "verified",
  historyComplete: false,
  truncated: false,
};
export const historyPage = (items: ActivityEntry[]): ActivityPage => ({
  items,
  next: null,
  visibleCount: items.length,
  batches: [],
  exhausted: true,
  scanLimitReached: false,
  searchLimitReached: false,
});
export const historyActivity = historyPage([
  {
    ...historyMove,
    id: "10000000-0000-4000-8000-000000000005",
    action: "file.edit",
    time: "2026-10-20T06:52:00.000Z",
    via: "office",
    actor: { kind: "user", userId: "10000000-0000-4000-8000-000000000006", name: "Mia Weber" },
    before: side("groups/vertrieb/Kalkulation.xlsx"),
    after: side("groups/vertrieb/Kalkulation.xlsx"),
  },
  {
    ...historyMove,
    id: "10000000-0000-4000-8000-000000000007",
    action: "file.upload",
    time: "2026-10-20T06:48:00.000Z",
    state: "pending",
    via: "web",
    before: { visibility: "hidden" },
    after: side("groups/vertrieb/Preisliste.pdf"),
  },
  {
    ...historyMove,
    id: "10000000-0000-4000-8000-000000000008",
    action: "item.copy",
    time: "2026-10-20T06:40:00.000Z",
    state: "unclear",
    via: "api",
    after: side("groups/vertrieb/Archiv/Angebot.pdf"),
  },
  historyMove,
]);
export function historySnapshot(source: string): WorkspaceSnapshot {
  const params = new URL(source, "https://files-history.test").searchParams;
  const query = params.get("q");
  if (params.get("file") === historyFile.path)
    return {
      source,
      bases: { items: [historyBase], issues: [], editor: null },
      selectedId: historyBase.id,
      directory: historyDirectory,
      detail: { base: historyBase, entry: historyFile },
      errorCode: null,
      now: historyNow,
    };
  return {
    source,
    bases: { items: [historyBase], issues: [], editor: null },
    selectedId: historyBase.id,
    directory: null,
    errorCode: null,
    now: historyNow,
    activity: { filters: query ? { q: query } : {}, page: query ? historyPage([historyMove]) : historyActivity },
  };
}
