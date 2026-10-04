import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { ConversationView, FolderDisplay } from "../contracts";
import { buildMailFolderTree, type MailFolderTreeEntry, type MailFolderTreeNode } from "../folder-tree";

type SqlFragment = Bun.SQL.Query<unknown>;

const STRICTNESS: Record<FolderDisplay, number> = { everywhere: 0, folder_only: 1, hidden: 2 };

/**
 * Folders that hold copies of mail filed elsewhere, or mail on its way in or out: Sent, Drafts, Trash,
 * Junk and the provider's All Mail. Like the provider's other collections (Important, Starred), they
 * neither keep a conversation in the views that mix folders nor take it out of them. Otherwise Gmail's
 * All Mail would keep every conversation everywhere, and one's own reply in Sent would bring a
 * conversation of a "folder only" folder back.
 */
const NEUTRAL_ROLES: ReadonlySet<string> = new Set(["sent", "drafts", "trash", "junk", "all"]);

/**
 * The views that mix folders. A conversation leaves them, and their counts, when its mail lies only in
 * "folder only" or hidden folders. "Assigned to me" keeps it, because an assignment addresses one person;
 * "Send problems" keeps it, because a failed send must not disappear.
 */
const AGGREGATED_VIEWS: readonly ConversationView[] = ["needs_action", "unassigned", "waiting", "done", "snoozed", "recently_active"];

export type FolderDisplayEntry = MailFolderTreeEntry & {
  display: FolderDisplay;
  role: string;
  providerRole: string;
  providerCollection: boolean;
};

export type FolderDisplayState = {
  /** The stricter of the folder's own display and the one it inherits from its parents. */
  effectiveDisplay: FolderDisplay;
  /** The parent whose stricter display applies to this folder, or null when its own display applies. */
  displayInheritedFromFolderId: string | null;
  /** Whether the folder neither keeps nor removes conversations in the views that mix folders. */
  displayNeutral: boolean;
};

/** The folder ID lists that decide which conversations the views that mix folders leave out. */
export type AggregatedViewScope = {
  isolatedFolderIds: readonly string[];
  countingFolderIds: readonly string[];
};

const EMPTY_SCOPE: AggregatedViewScope = { isolatedFolderIds: [], countingFolderIds: [] };

const isDisplayNeutral = (folder: Pick<FolderDisplayEntry, "role" | "providerRole" | "providerCollection">): boolean =>
  folder.providerCollection || NEUTRAL_ROLES.has(folder.role) || NEUTRAL_ROLES.has(folder.providerRole);

/** Each folder's effective display: a subfolder can be stricter than its parent, never looser. */
export const folderDisplayStates = (folders: readonly FolderDisplayEntry[]): Map<string, FolderDisplayState> => {
  const states = new Map<string, FolderDisplayState>();
  const visit = (
    nodes: readonly MailFolderTreeNode<FolderDisplayEntry>[],
    inherited: { display: FolderDisplay; folderId: string } | null,
  ) => {
    for (const { folder, children } of nodes) {
      const inherits = inherited !== null && STRICTNESS[inherited.display] > STRICTNESS[folder.display];
      const applied = inherits ? inherited : { display: folder.display, folderId: folder.id };
      states.set(folder.id, {
        effectiveDisplay: applied.display,
        displayInheritedFromFolderId: inherits ? applied.folderId : null,
        displayNeutral: isDisplayNeutral(folder),
      });
      visit(children, applied);
    }
  };
  visit(buildMailFolderTree(folders), null);
  return states;
};

/** Splits the folders that are not neutral into those that keep their mail inside and those that count everywhere. */
export const aggregatedViewScope = (folders: readonly FolderDisplayEntry[]): AggregatedViewScope => {
  const states = folderDisplayStates(folders);
  const isolatedFolderIds: string[] = [];
  const countingFolderIds: string[] = [];
  for (const folder of folders) {
    const state = states.get(folder.id);
    if (!state || state.displayNeutral) continue;
    (state.effectiveDisplay === "everywhere" ? countingFolderIds : isolatedFolderIds).push(folder.id);
  }
  return isolatedFolderIds.length === 0 ? EMPTY_SCOPE : { isolatedFolderIds, countingFolderIds };
};

/** The folders of the mailboxes that `mailboxIds` selects, with what their display depends on. */
const loadFolderDisplayEntries = async (db: typeof sql, mailboxIds: SqlFragment): Promise<FolderDisplayEntry[]> => {
  const rows = await db<
    {
      id: string;
      parent_id: string | null;
      name: string;
      display: FolderDisplay;
      role: string;
      provider_role: string;
      provider_collection: boolean;
    }[]
  >`
    SELECT
      folder.id,
      folder.parent_id,
      folder.name,
      folder.display,
      COALESCE(role_override.role, folder.role) AS role,
      folder.role AS provider_role,
      folder.provider_collection
    FROM mail.folders folder
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    LEFT JOIN mail.folder_role_overrides role_override
      ON role_override.mailbox_id = resource.mailbox_id
     AND role_override.folder_id = folder.id
    WHERE resource.mailbox_id IN (${mailboxIds})
  `;
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    display: row.display,
    role: row.role,
    providerRole: row.provider_role,
    providerCollection: row.provider_collection,
  }));
};

/** One folder's display state, read inside the transaction that changed it. */
export const loadFolderDisplayState = async (mailboxId: string, folderId: string, db: typeof sql): Promise<FolderDisplayState> => {
  const state = folderDisplayStates(await loadFolderDisplayEntries(db, sql`${mailboxId}::uuid`)).get(folderId);
  if (!state) throw new Error("Mail folder is missing from its mailbox's folder tree");
  return state;
};

/**
 * The scope of these mailboxes, read from their folder trees. Only mailboxes with a folder that is not
 * shown everywhere load their folders, so the lists stay as short as those trees.
 */
export const loadAggregatedViewScope = async (mailboxIds: readonly string[]): Promise<AggregatedViewScope> => {
  if (mailboxIds.length === 0) return EMPTY_SCOPE;
  return aggregatedViewScope(
    await loadFolderDisplayEntries(
      sql,
      sql`
        SELECT scoped_resource.mailbox_id
        FROM mail.folders scoped_folder
        JOIN mail.remote_resources scoped_resource ON scoped_resource.id = scoped_folder.remote_resource_id
        WHERE scoped_resource.mailbox_id = ANY(${toPgUuidArray([...mailboxIds])}::uuid[])
          AND scoped_folder.display <> 'everywhere'
      `,
    ),
  );
};

/** Whether a listing mixes folders: no folder is open and the view is All mail or one of the work views above. */
export const isAggregatedListing = (folderId: string | null, view: ConversationView | null): boolean =>
  folderId === null && (view === null || AGGREGATED_VIEWS.includes(view));

/**
 * Whether a conversation belongs in the views that mix folders: it leaves them only when one of its
 * messages lies in a "folder only" or hidden folder and none lies in a folder shown everywhere.
 */
export const staysInAggregatedViews = (conversationId: SqlFragment, scope: AggregatedViewScope): SqlFragment => {
  if (scope.isolatedFolderIds.length === 0) return sql`true`;
  return sql`NOT (
    EXISTS (
      SELECT 1
      FROM mail.conversation_messages isolated_link
      JOIN mail.message_placements isolated_placement ON isolated_placement.message_id = isolated_link.message_id
      WHERE isolated_link.conversation_id = ${conversationId}
        AND isolated_placement.deleted_at IS NULL
        AND isolated_placement.folder_id = ANY(${toPgUuidArray([...scope.isolatedFolderIds])}::uuid[])
    )
    AND NOT EXISTS (
      SELECT 1
      FROM mail.conversation_messages counting_link
      JOIN mail.message_placements counting_placement ON counting_placement.message_id = counting_link.message_id
      WHERE counting_link.conversation_id = ${conversationId}
        AND counting_placement.deleted_at IS NULL
        AND counting_placement.folder_id = ANY(${toPgUuidArray([...scope.countingFolderIds])}::uuid[])
    )
  )`;
};

/** The same decision as an aggregate over the live placements of one conversation's messages, for a grouped pass. */
export const staysInAggregatedViewsAggregate = (placementFolderId: SqlFragment, scope: AggregatedViewScope): SqlFragment => {
  if (scope.isolatedFolderIds.length === 0) return sql`true`;
  return sql`NOT (
    COALESCE(bool_or(${placementFolderId} = ANY(${toPgUuidArray([...scope.isolatedFolderIds])}::uuid[])), false)
    AND NOT COALESCE(bool_or(${placementFolderId} = ANY(${toPgUuidArray([...scope.countingFolderIds])}::uuid[])), false)
  )`;
};
