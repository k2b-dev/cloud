import type { MailboxListView, MailboxPageData } from "../../service/workspace";
import { emptyMailSelection } from "./mail-selection-detail";

/** The part of a workspace snapshot that belongs to the mailbox: it depends on neither the list nor the selection. */
export type MailWorkspaceFrame = Pick<
  MailboxPageData,
  | "receivingAddress"
  | "mailbox"
  | "permission"
  | "access"
  | "initialLiveCursor"
  | "folders"
  | "identities"
  | "scheduledCount"
  | "savedViews"
  | "viewCounts"
  | "localTags"
>;

/** Typed field by field, so the frame cannot take a list or selection field the snapshot gains. */
export const pickMailWorkspaceFrame = (data: MailboxPageData): MailWorkspaceFrame => ({
  receivingAddress: data.receivingAddress,
  mailbox: data.mailbox,
  permission: data.permission,
  access: data.access,
  initialLiveCursor: data.initialLiveCursor,
  folders: data.folders,
  identities: data.identities,
  scheduledCount: data.scheduledCount,
  savedViews: data.savedViews,
  viewCounts: data.viewCounts,
  localTags: data.localTags,
});

/**
 * The snapshot `loadMailboxPageData` builds for a list without a selection, from a kept frame and that list's view.
 * Scheduled brings its own total, exactly like the snapshot.
 */
export const composeMailListSnapshot = (frame: MailWorkspaceFrame, list: MailboxListView): MailboxPageData => ({
  ...frame,
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
