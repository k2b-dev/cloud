import type { ActivityChain, ActivityEntry, ActivityPage, ActivitySide } from "../activity-contracts";
import type { BaseSummary, DirectoryResult, FileEntry, FileVersion } from "../contracts";
import { filesUrl, parseActivityFilters } from "./urls";
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
/** A second hit of the same search: a file in the trash, restorable from its row. */
export const historyTrash: ActivityEntry = {
  ...historyMove,
  id: "10000000-0000-4000-8000-000000000009",
  action: "item.trash",
  time: "2026-10-14T08:42:00.000Z",
  before: {
    visibility: "full",
    source: "snapshot",
    name: "Angebote_2025_Übersicht.xlsx",
    path: "groups/vertrieb/Kunden/Angebote_2025_Übersicht.xlsx",
    root: "cloud",
    baseId: "10000000-0000-4000-8000-000000000001",
    publicBaseId: historyBase.id,
    relativePath: "Kunden/Angebote_2025_Übersicht.xlsx",
    itemId: "10000000-0000-4000-8000-000000000010",
    directory: false,
    size: 38_000,
    revision: null,
  },
  after: { visibility: "hidden" },
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
export const historySearch = historyPage([historyMove, historyTrash]);
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
/** A file side; a snapshot is how the reader returns an item it no longer finds there. */
const fileSide = (path: string, source: "current" | "snapshot", id: number): ActivitySide => ({
  visibility: "full",
  source,
  name: path.split("/").at(-1)!,
  path,
  root: "cloud",
  baseId: "10000000-0000-4000-8000-000000000001",
  publicBaseId: historyBase.id,
  relativePath: path.slice("groups/vertrieb/".length),
  itemId: `10000000-0000-4000-8000-${String(100 + id).padStart(12, "0")}`,
  directory: false,
  size: null,
  revision: null,
});
const bulkActor = { kind: "user" as const, userId: "10000000-0000-4000-8000-000000000009", name: "Jonas Berger" };
/** An API bulk job: twelve scans renamed in Eingang and moved to Buchhaltung › Belege › 2026, newest first. */
export const historyBulk = historyPage([
  {
    ...historyMove,
    id: "10000000-0000-4000-8000-000000000020",
    action: "file.overwrite",
    time: "2026-10-20T10:02:00.000Z",
    via: "web",
    actor: { kind: "user", userId: "10000000-0000-4000-8000-000000000006", name: "Mia Weber" },
    before: { visibility: "hidden" },
    after: fileSide("groups/vertrieb/Preisliste.pdf", "current", 99),
  },
  ...Array.from({ length: 12 }, (_, index): ActivityEntry[] => {
    const name = `Beleg-${String(index + 1).padStart(2, "0")}.pdf`;
    const seconds = String(50 - index * 2).padStart(2, "0");
    const at = (offset: number) => `2026-10-20T09:54:${String(Number(seconds) - offset).padStart(2, "0")}.000Z`;
    const base = { ...historyMove, actor: bulkActor, via: "api", state: "done" as const };
    return [
      {
        ...base,
        id: `10000000-0000-4000-8000-${String(200 + index * 2).padStart(12, "0")}`,
        action: "item.move",
        time: at(0),
        startedAt: at(0),
        finishedAt: at(0),
        before: fileSide(`groups/vertrieb/Eingang/${name}`, "snapshot", index),
        after: fileSide(`groups/vertrieb/Buchhaltung/Belege/2026/${name}`, index === 1 ? "snapshot" : "current", index),
      },
      {
        ...base,
        id: `10000000-0000-4000-8000-${String(201 + index * 2).padStart(12, "0")}`,
        action: "item.rename",
        time: at(1),
        startedAt: at(1),
        finishedAt: at(1),
        before: fileSide(`groups/vertrieb/Eingang/scan_${4810 + index}.pdf`, "snapshot", index),
        after: fileSide(`groups/vertrieb/Eingang/${name}`, "snapshot", index),
      },
    ];
  }).flat(),
  {
    ...historyMove,
    id: "10000000-0000-4000-8000-000000000021",
    action: "file.upload",
    time: "2026-10-20T08:15:00.000Z",
    via: "web",
    actor: { kind: "user", userId: "10000000-0000-4000-8000-000000000006", name: "Mia Weber" },
    before: { visibility: "hidden" },
    after: {
      visibility: "disappearance",
      name: "Angebot-alt.pdf",
      path: "groups/vertrieb/Angebot-alt.pdf",
      directory: false,
      publicBaseId: historyBase.id,
      relativePath: "Angebot-alt.pdf",
    },
  },
]);

export function historySnapshot(source: string): WorkspaceSnapshot {
  const params = new URL(source, "https://files-history.test").searchParams;
  const query = params.get("q");
  const bases = params.has("mixed")
    ? [historyBase, { ...historyBase, id: historyBase.id.replace("cloud:", "freeipa:"), area: "freeipa" as const, name: "POSIX" }]
    : [historyBase];
  if (params.get("file") === historyFile.path)
    return {
      source,
      bases: { items: bases, issues: [], editor: null },
      selectedId: historyBase.id,
      directory: historyDirectory,
      detail: { base: historyBase, entry: historyFile },
      errorCode: null,
      now: historyNow,
    };
  return {
    source,
    bases: { items: bases, issues: [], editor: null },
    selectedId: historyBase.id,
    directory: null,
    errorCode: null,
    now: historyNow,
    activity: {
      filters: parseActivityFilters(params) ?? {},
      page: query ? historySearch : params.has("bulk") ? historyBulk : historyActivity,
    },
  };
}
