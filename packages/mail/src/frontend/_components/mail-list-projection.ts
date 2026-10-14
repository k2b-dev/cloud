import type { ConversationView } from "../../contracts";
import { mailPlacementsBelongInListing, mailRowLeavesListing } from "../../folder-display-rules";
import type { ConversationViewCounts, MailFolderView } from "../../service/messages";
import type { MailListItem, MailListMode } from "../../service/workspace";
import { mailListMessagePendingKey } from "./mail-list-optimistic";

export const MAIL_ROW_LEAVE_MS = 160;

/** A conversation key, or a message key in a message list. */
export const mailListRowKey = (item: MailListItem): string =>
  item.selectionKind === "message" ? mailListMessagePendingKey(item.id) : (item.conversationId ?? item.id);

export type MailListRemoval = {
  rowKey: string;
  conversationId: string;
  scope: string;
  item: MailListItem;
  /** Keys before this row, nearest last, for restoration after a changed snapshot. */
  before: readonly string[];
  sourceFolderIds: readonly string[];
  destinationFolderId: string | null;
  phase: "leaving" | "hidden" | "held";
};

export const mailRemovalCoversRow = (removal: MailListRemoval, snapshotRow: MailListItem): boolean =>
  !(snapshotRow.selectionKind === "conversation" && Date.parse(snapshotRow.latestMessageAt) > Date.parse(removal.item.latestMessageAt));

export const projectMailList = (params: {
  items: readonly MailListItem[];
  removals: readonly MailListRemoval[];
  scope: string;
}): { items: MailListItem[]; leavingKeys: ReadonlySet<string> } => {
  const snapshot = new Map(params.items.map((item) => [mailListRowKey(item), item]));
  const removals = params.removals.filter((removal) => {
    const row = snapshot.get(removal.rowKey);
    return removal.scope === params.scope && (!row || mailRemovalCoversRow(removal, row));
  });
  const hidden = new Set(removals.filter((removal) => removal.phase === "hidden").map((removal) => removal.rowKey));
  const leavingKeys = new Set(removals.filter((removal) => removal.phase === "leaving").map((removal) => removal.rowKey));
  const items = params.items.filter((item) => !hidden.has(mailListRowKey(item)));
  for (const removal of removals) {
    if (removal.phase !== "held" || items.some((item) => mailListRowKey(item) === removal.rowKey)) continue;
    const anchor = [...removal.before].reverse().find((key) => items.some((item) => mailListRowKey(item) === key));
    const index = anchor === undefined ? -1 : items.findIndex((item) => mailListRowKey(item) === anchor);
    items.splice(index + 1, 0, removal.item);
  }
  return { items, leavingKeys };
};

export const projectMailCounts = (params: {
  folders: MailFolderView[];
  viewCounts: ConversationViewCounts;
  activeView: ConversationView | null;
  listMode: MailListMode;
  now: number;
  currentUserId: string | null;
  items: readonly MailListItem[];
  shown: readonly MailListItem[];
  removals: readonly MailListRemoval[];
  scope: string;
}): { folders: MailFolderView[]; viewCounts: ConversationViewCounts } => {
  const snapshot = new Map(params.items.map((item) => [mailListRowKey(item), item]));
  const shown = new Map(params.shown.map((item) => [mailListRowKey(item), item]));
  const deltas = new Map<string, number>();
  const change = (folderId: string, delta: number) => deltas.set(folderId, (deltas.get(folderId) ?? 0) + delta);
  const conversations = new Set<string>();
  const removedKeys = new Set<string>();
  const removedFolders = new Map<string, ReadonlySet<string>>();
  let viewDelta = 0;
  const viewDeltas = new Map<ConversationView, number>();
  for (const removal of params.removals) {
    if (removal.scope !== params.scope || removedKeys.has(removal.rowKey)) continue;
    const item = snapshot.get(removal.rowKey);
    if (item && !mailRemovalCoversRow(removal, item)) continue;
    removedKeys.add(removal.rowKey);
    if (removal.phase !== "held") removedFolders.set(removal.rowKey, new Set(removal.sourceFolderIds));
    const delta = removal.phase === "held" ? (item ? 0 : 1) : item ? -1 : 0;
    if (delta === 0) continue;
    if (!conversations.has(removal.conversationId)) {
      conversations.add(removal.conversationId);
      viewDelta += delta;
      if (params.listMode === "conversations") {
        const row = removal.item;
        const snoozed = row.snoozedUntil !== null && Date.parse(row.snoozedUntil) > params.now;
        const views = {
          needs_action: row.workStatus === "needs_action" && !snoozed,
          waiting: row.workStatus === "waiting" && !snoozed,
          mine:
            params.currentUserId !== null &&
            row.assigneeUserIds.includes(params.currentUserId) &&
            row.workStatus !== null &&
            row.workStatus !== "done" &&
            !snoozed,
          unassigned: row.assigneeUserIds.length === 0 && row.workStatus !== null && row.workStatus !== "done" && !snoozed,
          snoozed,
          done: row.workStatus === "done",
          recently_active: true,
        };
        for (const view of ["needs_action", "mine", "unassigned", "waiting", "done", "snoozed", "recently_active"] as const) {
          if (view === params.activeView || !views[view]) continue;
          const scope = { viewFolderId: null, activeView: view, hasSearch: false, hasSavedView: false, scheduledMode: false };
          if (mailPlacementsBelongInListing({ ...scope, activeFolderIds: row.activeFolderIds, folders: params.folders }) !== true) continue;
          if (
            !mailRowLeavesListing({
              ...scope,
              item: row,
              sourceFolderIds: removal.sourceFolderIds,
              destinationFolderId: removal.destinationFolderId,
              folders: params.folders,
            })
          )
            continue;
          viewDeltas.set(view, (viewDeltas.get(view) ?? 0) + delta);
        }
      }
    }
    const row = item ?? removal.item;
    for (const folderId of new Set(removal.sourceFolderIds)) {
      if (row.unreadFolderIds.includes(folderId)) change(folderId, delta);
    }
  }
  // One per row and folder: only the server knows the conversation's exact unread message count.
  // The next snapshot corrects these provisional badges rather than accumulating client deltas.
  for (const item of params.items) {
    const next = shown.get(mailListRowKey(item));
    if (!next || item.unread === next.unread) continue;
    // A read patch and a move can overlap; the moved-out placement is already absent from the badge.
    const removed = removedFolders.get(mailListRowKey(item));
    if (!next.unread)
      for (const id of new Set(item.unreadFolderIds)) {
        if (!removed?.has(id)) change(id, -1);
      }
    else for (const id of new Set(item.activeFolderIds)) if (!removed?.has(id) && !item.unreadFolderIds.includes(id)) change(id, 1);
  }
  const folders = [...deltas.values()].some((delta) => delta !== 0)
    ? params.folders.map((folder) => {
        const delta = deltas.get(folder.id) ?? 0;
        return delta === 0 ? folder : { ...folder, unread: Math.max(0, folder.unread + delta) };
      })
    : params.folders;
  if (params.activeView && params.listMode === "conversations" && viewDelta !== 0) viewDeltas.set(params.activeView, viewDelta);
  const viewCounts = [...viewDeltas.values()].some((delta) => delta !== 0) ? { ...params.viewCounts } : params.viewCounts;
  for (const [view, delta] of viewDeltas) if (delta !== 0) viewCounts[view] = Math.max(0, params.viewCounts[view] + delta);
  return { folders, viewCounts };
};
