import type { ActivityChain, ActivityEntry, ActivityPage, ActivitySide } from "../src/activity-contracts";
import type { HistoryEnvironment } from "../src/frontend/history-actions";

/** Fictional people and places from the approved mockup; Tuesday 20.10.2026 in Berlin, frozen. */
export const env: HistoryEnvironment = {
  now: "2026-10-20T12:30:00.000Z",
  timeZone: "Europe/Berlin",
  describePlace: (place) => {
    // Sides carry root-relative paths below the base directory; a chain endpoint is already base-relative.
    const segments = place.kind === "side" ? place.side.path.split("/").slice(1) : place.endpoint.path.split("/");
    return ["Team Vertrieb", ...segments.filter(Boolean).slice(0, -1)];
  },
};

export const hidden: ActivitySide = { visibility: "hidden" };
export const current = (path: string, options: { directory?: boolean; itemId?: string } = {}): ActivitySide => ({
  visibility: "full",
  source: "current",
  name: path.split("/").at(-1)!,
  path,
  root: "groups",
  baseId: "binding-1",
  publicBaseId: "cloud:groups:vertrieb",
  itemId: options.itemId ?? null,
  directory: options.directory ?? true,
  size: null,
  revision: null,
});
export const snapshot = (path: string, options: { directory?: boolean; itemId?: string } = {}): ActivitySide => ({
  ...(current(path, options) as Extract<ActivitySide, { visibility: "full" }>),
  source: "snapshot",
  publicBaseId: null,
});
export const gone = (path: string, options: { directory?: boolean | null; publicBaseId?: string | null } = {}): ActivitySide => ({
  visibility: "disappearance",
  name: path.split("/").at(-1)!,
  path,
  directory: options.directory ?? null,
  publicBaseId: options.publicBaseId ?? null,
});

let counter = 0;
export function entry(patch: Partial<ActivityEntry> & Pick<ActivityEntry, "action">): ActivityEntry {
  counter += 1;
  const time = patch.time ?? "2026-10-20T12:12:00.000Z";
  return {
    id: `0000000${counter}`.slice(-8),
    state: "done",
    time,
    startedAt: time,
    finishedAt: time,
    actor: { kind: "user", userId: "lukas", name: "Lukas Pohl" },
    via: "web",
    before: hidden,
    after: hidden,
    batchId: null,
    ...patch,
  };
}
export const page = (items: ActivityEntry[], next: string | null = null): ActivityPage => ({
  items,
  next,
  visibleCount: items.length,
  batches: [],
  exhausted: next === null,
  scanLimitReached: false,
  searchLimitReached: false,
});
export const chain = (patch: Partial<ActivityChain>): ActivityChain => ({
  sourceId: "x",
  hops: [],
  endpoint: null,
  certainty: "unavailable",
  historyComplete: false,
  truncated: false,
  ...patch,
});
