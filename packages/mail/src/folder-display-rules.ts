import type { ConversationView, FolderDisplay, MailSearchExpression } from "./contracts";
import { buildMailFolderTree, type MailFolderTreeEntry, type MailFolderTreeNode } from "./folder-tree";
import { guaranteedMailSearchFolderIds } from "./search-folder-scope";

/**
 * The folder display rules that the server's queries and the browser's folder views share. Each display hides
 * more than the one before it.
 */
const STRICTNESS: Record<FolderDisplay, number> = { everywhere: 0, folder_only: 1, hidden: 2 };

export const isStricterDisplay = (display: FolderDisplay, than: FolderDisplay): boolean => STRICTNESS[display] > STRICTNESS[than];

export type InheritedFolderDisplay = {
  /** The stricter of the folder's own display and the one it inherits from its parents. */
  effectiveDisplay: FolderDisplay;
  /** The parent whose stricter display applies to this folder, or null when its own display applies. */
  displayInheritedFromFolderId: string | null;
};

/** Each folder's effective display: a subfolder can be stricter than its parent, never looser. */
export const inheritFolderDisplays = <T extends MailFolderTreeEntry & { display: FolderDisplay }>(
  folders: readonly T[],
): Map<string, InheritedFolderDisplay> => {
  const states = new Map<string, InheritedFolderDisplay>();
  const visit = (nodes: readonly MailFolderTreeNode<T>[], inherited: { display: FolderDisplay; folderId: string } | null) => {
    for (const { folder, children } of nodes) {
      const inherits = inherited !== null && isStricterDisplay(inherited.display, folder.display);
      const applied = inherits ? inherited : { display: folder.display, folderId: folder.id };
      states.set(folder.id, { effectiveDisplay: applied.display, displayInheritedFromFolderId: inherits ? applied.folderId : null });
      visit(children, applied);
    }
  };
  visit(buildMailFolderTree(folders), null);
  return states;
};

/**
 * The views that mix folders. A conversation leaves them, and their counts, when its mail lies only in
 * "folder only" or hidden folders. "Assigned to me" keeps it, because an assignment addresses one person;
 * "Send problems" keeps it, because a failed send must not disappear.
 */
const AGGREGATED_VIEWS: readonly ConversationView[] = ["needs_action", "unassigned", "waiting", "done", "snoozed", "recently_active"];

/** Whether a listing mixes folders: no folder is open and the view is All mail or one of the work views above. */
export const isAggregatedListing = (folderId: string | null, view: ConversationView | null): boolean =>
  folderId === null && (view === null || AGGREGATED_VIEWS.includes(view));

/** Open or postponed work leaves out conversations filed only in Trash or Junk. */
export const FOLLOW_UP_VIEWS: readonly ConversationView[] = ["needs_action", "mine", "unassigned", "waiting", "snoozed"];

export type MailListingScope = {
  viewFolderId: string | null;
  activeView: ConversationView | null;
  hasSearch: boolean;
  hasSavedView: boolean;
  scheduledMode: boolean;
};

/** The same Trash/Junk exclusion for the workspace query and its optimistic projection. */
export const mailListingExcludesTrashAndJunk = (scope: MailListingScope): boolean =>
  (!scope.scheduledMode && !scope.hasSearch && !scope.viewFolderId && !scope.activeView && !scope.hasSavedView) ||
  (!scope.hasSearch && scope.activeView !== null && FOLLOW_UP_VIEWS.includes(scope.activeView));

/** Whether known placements belong in a listing; missing folders or placements leave membership unknown. */
export const mailPlacementsBelongInListing = (
  params: MailListingScope & {
    activeFolderIds: readonly string[];
    folders: readonly { id: string; role: string; effectiveDisplay: FolderDisplay; displayNeutral: boolean }[];
  },
): boolean | null => {
  const byId = new Map(params.folders.map((folder) => [folder.id, folder]));
  const folders = [...new Set(params.activeFolderIds)].map((id) => byId.get(id));
  if (folders.length === 0 || folders.some((folder) => !folder)) return null;
  if (params.viewFolderId) return params.activeFolderIds.includes(params.viewFolderId);
  const visible = folders.filter(
    (folder) => folder !== undefined && !(mailListingExcludesTrashAndJunk(params) && (folder.role === "trash" || folder.role === "junk")),
  );
  if (visible.length === 0) return false;
  if (params.hasSearch || params.hasSavedView || params.scheduledMode || !isAggregatedListing(null, params.activeView)) return true;
  // Sent and provider collections neither isolate mail nor bring isolated mail into an aggregated view.
  const deciding = visible.flatMap((folder) => (folder && !folder.displayNeutral ? [folder] : []));
  return !(
    deciding.some((folder) => folder.effectiveDisplay !== "everywhere") &&
    deciding.every((folder) => folder.effectiveDisplay !== "everywhere")
  );
};

/** Whether the known placements after a move still belong in this listing. Unknown folders keep the row. */
export const mailRowLeavesListing = (
  params: MailListingScope & {
    item: { activeFolderIds: readonly string[] };
    sourceFolderIds: readonly string[];
    destinationFolderId: string | null;
    folders: readonly { id: string; role: string; effectiveDisplay: FolderDisplay; displayNeutral: boolean }[];
  },
): boolean => {
  if (params.viewFolderId) return params.sourceFolderIds.includes(params.viewFolderId);
  if (!params.destinationFolderId) return false;
  const sources = new Set(params.sourceFolderIds);
  return (
    mailPlacementsBelongInListing({
      ...params,
      activeFolderIds: [...params.item.activeFolderIds.filter((id) => !sources.has(id)), params.destinationFolderId],
    }) === false
  );
};

/** Folders that file mail away. Their lists keep done and snoozed conversations, so filed mail stays findable. */
export const FILING_FOLDER_ROLES: readonly string[] = ["archive", "sent", "trash", "junk", "all"];

/**
 * What a search expression asks for, as far as the open-work rule cares: a status or snoozed condition, a text
 * condition, and the folders every match lies in (`guaranteedMailSearchFolderIds`). Excluding a folder does not limit
 * the list to it.
 */
export const mailSearchOpenWorkTerms = (expression: MailSearchExpression): { status: boolean; text: boolean; folderIds: string[] } => {
  const has = (node: MailSearchExpression, match: (term: MailSearchExpression) => boolean): boolean =>
    node.type === "and" || node.type === "or"
      ? node.expressions.some((child) => has(child, match))
      : node.type === "not"
        ? has(node.expression, match)
        : match(node);
  return {
    status: has(expression, (term) => term.type === "work_status" || term.type === "snoozed"),
    text: has(expression, (term) => term.type === "text"),
    folderIds: guaranteedMailSearchFolderIds(expression) ?? [],
  };
};

/**
 * Whether a work list shows open conversations only, leaving out done and snoozed ones like the Focus view "All active".
 * It applies to All mail, folders, tags, filters and saved views. Work views keep their own rule, an explicit status
 * condition wins, a text search finds everything, and filing folders (Archive, Sent, Trash, Junk, All Mail) show
 * everything.
 */
export const mailListingOpenOnly = (scope: {
  activeView: ConversationView | null;
  /** A status parameter or a work-status or snoozed condition. */
  explicitStatus: boolean;
  textSearch: boolean;
  /** The roles of the folders the listing is limited to: the open folder and the search's folder conditions. */
  folderRoles: readonly string[];
}): boolean =>
  scope.activeView === null &&
  !scope.explicitStatus &&
  !scope.textSearch &&
  !scope.folderRoles.some((role) => FILING_FOLDER_ROLES.includes(role));

/** The open-work rule (`isOpenConversation`) as a search condition, for listings that run through search. */
const OPEN_WORK_EXPRESSION_TERMS: MailSearchExpression[] = [
  { type: "not", expression: { type: "work_status", value: "done" } },
  { type: "snoozed", value: false },
];
export const OPEN_WORK_EXPRESSION: MailSearchExpression = { type: "and", expressions: OPEN_WORK_EXPRESSION_TERMS };

/** A search expression limited to open work. A top-level conjunction takes the conditions in, so the depth stays. */
export const withOpenWork = (expression: MailSearchExpression): MailSearchExpression => ({
  type: "and",
  expressions: [...(expression.type === "and" ? expression.expressions : [expression]), ...OPEN_WORK_EXPRESSION_TERMS],
});
