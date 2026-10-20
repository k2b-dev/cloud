import type { MailboxListView, MailboxPageData } from "../../service/workspace";
import { emptyMailSelection } from "./mail-selection-detail";

/**
 * The part of a workspace snapshot that a list switch keeps: it depends on neither the list nor the selection, and live
 * updates refresh it. The list view brings the mailbox, the reader's access and the saved views itself, because their
 * writers include ones outside Mail's live updates (sync health, platform group membership).
 */
export type MailWorkspaceFrame = Pick<
  MailboxPageData,
  "receivingAddress" | "initialLiveCursor" | "folders" | "identities" | "scheduledCount" | "viewCounts" | "localTags"
>;

/** Typed field by field, so the frame cannot take a list or selection field the snapshot gains. */
export const pickMailWorkspaceFrame = (data: MailboxPageData): MailWorkspaceFrame => ({
  receivingAddress: data.receivingAddress,
  initialLiveCursor: data.initialLiveCursor,
  folders: data.folders,
  identities: data.identities,
  scheduledCount: data.scheduledCount,
  viewCounts: data.viewCounts,
  localTags: data.localTags,
});

/**
 * The snapshot `loadMailboxPageData` builds for a list without a selection, from a kept frame and that list's view.
 * Scheduled brings its own total, exactly like the snapshot.
 */
export const composeMailListSnapshot = (frame: MailWorkspaceFrame, list: MailboxListView): MailboxPageData => ({
  ...frame,
  mailbox: list.mailbox,
  permission: list.permission,
  access: list.access,
  savedViews: list.savedViews,
  scheduledMode: list.scheduledMode,
  scheduledPage: list.scheduledPage,
  scheduledError: list.scheduledError,
  draftsMode: list.draftsMode,
  draftsPage: list.draftsPage,
  draftsError: list.draftsError,
  activeView: list.activeView,
  savedViewId: list.savedViewId,
  listMode: list.listMode,
  folderId: list.folderId,
  query: list.query,
  search: list.search,
  listItems: list.listItems,
  listCursor: list.listCursor,
  nextListCursor: list.nextListCursor,
  listError: list.listError,
  listTitle: list.listTitle,
  scheduledCount: list.scheduledPage ? list.scheduledPage.total : frame.scheduledCount,
  ...emptyMailSelection(),
});
