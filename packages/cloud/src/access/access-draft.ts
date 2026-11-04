import type { AccessEntry, PermissionLevel, Principal, ServiceAccountKind } from "../contracts/shared";
import { isManagerEntry } from "./managers";
import { principalKey } from "./principal-key";

/**
 * A level as the dialog offers it: the permission and, for a grant on part of the resource, its scope. A stored
 * denial keeps `none`, so the rules that let a denial shadow other rows see it; the dialog never offers it.
 */
export type DraftLevel = { permission: PermissionLevel; scope?: string };

/** Display facts the server returns with an entry, kept for a principal that is only in the draft. */
export type DraftDisplay = { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind };

/** A row the dialog shows: a stored entry with its pending change, or a principal only the draft adds. */
export type DraftRow = {
  /**
   * One per row: a stored row by its entry, so a principal with both a grant and a denial keeps two rows; an added row
   * by its principal, which the draft adds once.
   */
  key: string;
  /** The stored entry; absent for a principal the draft adds. */
  entry?: AccessEntry;
  principal: Principal;
  display: DraftDisplay;
  /** What the row will have after saving; `null` when the draft removes it. */
  next: DraftLevel | null;
  /** What the row has now; `null` for an added row. */
  previous: DraftLevel | null;
};

export type DraftChange =
  | { kind: "add"; row: DraftRow; level: DraftLevel }
  | { kind: "change"; row: DraftRow; from: DraftLevel; to: DraftLevel }
  | { kind: "remove"; row: DraftRow; from: DraftLevel };

/**
 * What the dialog has decided but not saved. Nothing applies before saving: the stored entries stay the base, and
 * each row records only how it differs. Saving moves applied changes into the base one by one, so a failure keeps
 * exactly the changes that are still open.
 */
export type AccessDraft = {
  base: readonly AccessEntry[];
  levels: ReadonlyMap<string, DraftLevel>;
  removed: ReadonlySet<string>;
  added: readonly { principal: Principal; display: DraftDisplay; level: DraftLevel }[];
};

const sameLevel = (a: DraftLevel | null, b: DraftLevel | null) => a?.permission === b?.permission && a?.scope === b?.scope;
const levelOf = (entry: AccessEntry): DraftLevel => ({ permission: entry.permission, ...(entry.scope ? { scope: entry.scope } : {}) });
const storedKey = (entry: AccessEntry) => `e:${entry.id}`;
const addedKey = (principal: Principal) => `n:${principalKey(principal)}`;

export const emptyDraft = (base: readonly AccessEntry[]): AccessDraft => ({ base, levels: new Map(), removed: new Set(), added: [] });

/** Every row in the order the person sees it: stored entries first, then the ones the draft adds. */
export const draftRows = (draft: AccessDraft): DraftRow[] => [
  ...draft.base.map((entry) => {
    const previous = levelOf(entry);
    return {
      key: storedKey(entry),
      entry,
      principal: entry.principal,
      display: { displayName: entry.displayName ?? "", avatarHash: entry.avatarHash, serviceAccountKind: entry.serviceAccountKind },
      previous,
      next: draft.removed.has(entry.id) ? null : (draft.levels.get(entry.id) ?? previous),
    };
  }),
  ...draft.added.map((added) => ({
    key: addedKey(added.principal),
    principal: added.principal,
    display: added.display,
    previous: null,
    next: added.level,
  })),
];

export const draftChanges = (draft: AccessDraft): DraftChange[] =>
  draftRows(draft).flatMap((row): DraftChange[] => {
    if (!row.previous) return row.next ? [{ kind: "add", row, level: row.next }] : [];
    if (!row.next) return [{ kind: "remove", row, from: row.previous }];
    return sameLevel(row.previous, row.next) ? [] : [{ kind: "change", row, from: row.previous, to: row.next }];
  });

/** The entries as they would be after saving, for the rule that one entry must keep managing the resource. */
const resultEntries = (draft: AccessDraft): AccessEntry[] =>
  draftRows(draft).flatMap((row) =>
    row.next
      ? [
          {
            id: row.key,
            principal: row.principal,
            permission: row.next.permission,
            ...(row.next.scope ? { scope: row.next.scope } : {}),
            createdAt: row.entry?.createdAt ?? "",
            serviceAccountKind: row.display.serviceAccountKind,
          },
        ]
      : [],
  );

/** Keys of rows that are the only manager after saving: they cannot lose Manage or be removed. */
export const lastManagerKeys = (
  draft: AccessDraft,
  effective: (entries: readonly AccessEntry[]) => readonly AccessEntry[] = (entries) => entries,
): Set<string> => {
  const managers = effective(resultEntries(draft)).filter((entry) => !entry.scope && isManagerEntry(entry));
  return new Set(managers.length === 1 ? [managers[0]!.id] : []);
};

export const setLevel = (draft: AccessDraft, row: DraftRow, level: DraftLevel): AccessDraft => {
  if (!row.entry)
    return { ...draft, added: draft.added.map((added) => (addedKey(added.principal) === row.key ? { ...added, level } : added)) };
  const levels = new Map(draft.levels);
  if (sameLevel(levelOf(row.entry), level)) levels.delete(row.entry.id);
  else levels.set(row.entry.id, level);
  const removed = new Set(draft.removed);
  removed.delete(row.entry.id);
  return { ...draft, levels, removed };
};

export const addPrincipal = (draft: AccessDraft, principal: Principal, display: DraftDisplay, level: DraftLevel): AccessDraft => {
  const key = principalKey(principal);
  const stored = draft.base.find((entry) => principalKey(entry.principal) === key);
  // Adding a principal the draft removes brings its stored row back with the chosen level.
  if (stored) return setLevel(draft, draftRows(draft).find((row) => row.entry?.id === stored.id)!, level);
  if (draft.added.some((added) => principalKey(added.principal) === key)) return draft;
  return { ...draft, added: [...draft.added, { principal, display, level }] };
};

export const removeRow = (draft: AccessDraft, row: DraftRow): AccessDraft => {
  if (!row.entry) return { ...draft, added: draft.added.filter((added) => addedKey(added.principal) !== row.key) };
  const removed = new Set(draft.removed);
  removed.add(row.entry.id);
  const levels = new Map(draft.levels);
  levels.delete(row.entry.id);
  return { ...draft, removed, levels };
};

/** Undo the pending change of one row. */
export const restoreRow = (draft: AccessDraft, row: DraftRow): AccessDraft => {
  if (!row.entry) return removeRow(draft, row);
  const removed = new Set(draft.removed);
  removed.delete(row.entry.id);
  const levels = new Map(draft.levels);
  levels.delete(row.entry.id);
  return { ...draft, removed, levels };
};

/** The draft after one change was saved: the change moves into the base and leaves the open changes. */
export const applied = (draft: AccessDraft, change: DraftChange, saved?: AccessEntry): AccessDraft => {
  if (change.kind === "add") {
    if (!saved) return draft;
    return {
      ...draft,
      base: [...draft.base, saved],
      added: draft.added.filter((added) => addedKey(added.principal) !== change.row.key),
    };
  }
  const id = change.row.entry!.id;
  const levels = new Map(draft.levels);
  levels.delete(id);
  const removed = new Set(draft.removed);
  removed.delete(id);
  const base =
    change.kind === "remove"
      ? draft.base.filter((entry) => entry.id !== id)
      : draft.base.map((entry) => {
          if (entry.id !== id) return entry;
          const { scope: _previous, ...rest } = entry;
          return { ...rest, permission: change.to.permission, ...(change.to.scope ? { scope: change.to.scope } : {}) };
        });
  return { base, levels, removed, added: draft.added };
};

const strength: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

/**
 * Saving order: new grants first, then whatever widens access (raised levels and removed denials), then lowered
 * levels, removals last, so a handover of Manage gives the new manager Manage before the old one steps down and the
 * resource never passes through no manager.
 */
export const saveOrder = (changes: readonly DraftChange[]): DraftChange[] => {
  const rank = (change: DraftChange) =>
    change.kind === "add"
      ? 0
      : change.kind === "remove"
        ? change.from.permission === "none"
          ? 1
          : 3
        : strength[change.to.permission] > strength[change.from.permission]
          ? 1
          : 2;
  return [...changes].sort((a, b) => rank(a) - rank(b));
};
