/**
 * Shared window event names for the detail-panel ↔ editor bridge.
 *
 * Kept in a plain `.ts` module so every consumer (server components, islands,
 * editor logic) can import constants without crossing island boundaries via
 * JSX.
 */
export const DETAIL_PANEL_TOGGLE_EVENT = "notebooks.detail-panel.toggle";
/** Panel → toolbar: current open/closed state after every flip (and on mount). */
export const DETAIL_PANEL_STATE_EVENT = "notebooks.detail-panel.stateChanged";
export const TOGGLE_RICH_MODE_EVENT = "notebooks.editor.toggleRich";
/** Settings → editor: the personal Tab key preference changed; the editor rereads it. */
export const TAB_KEY_PREFERENCE_EVENT = "notebooks.editor.tabKeyPreference";
/** Panel, settings or command → reading surfaces, panel and command: the personal full-width preference changed; listeners reread it. */
export const FULL_WIDTH_PREFERENCE_EVENT = "notebooks.view.fullWidthPreference";
/** Editor → panel: current rich/raw mode after every flip (and on mount). */
export const RICH_MODE_CHANGED_EVENT = "notebooks.editor.richModeChanged";
export const TOC_UPDATE_EVENT = "notebooks.toc.updated";
export const TOC_SCROLL_EVENT = "notebooks.editor.scrollToHeading";
/** Editor → panel: GFM task-list progress after every doc change. */
export const TASKS_UPDATE_EVENT = "notebooks.tasks.updated";
export const PRESENCE_EVENT = "notebooks.presence.changed";

/**
 * Dispatched by the panel's "Copy content" / "Download as .md" actions when
 * the editor is mounted (edit mode) so the action operates on the editor's
 * current `ytext` rather than the SSR-time `contentMd` snapshot.
 */
export const EDITOR_COPY_EVENT = "notebooks.editor.copy";
export const EDITOR_DOWNLOAD_EVENT = "notebooks.editor.download";
export const EDITOR_PDF_EVENT = "notebooks.editor.pdf";

export type EditorPdfEventDetail = {
  open: (markdown: string) => void;
};

/**
 * Picker-modal → editor: insert an attachment reference at the cursor.
 * Detail = `AttachmentRef` ({id, kind, filename}). Decouples the modal
 * (which has no editor-view ref) from the insertion site.
 */
export const EDITOR_INSERT_ATTACHMENT_EVENT = "notebooks.editor.insertAttachment";

/** Editor → panel: list of `attach://<shortId>` ids referenced in current
 *  doc, debounced like TOC/Tasks. Detail = `string[]`. */
export const ATTACHMENTS_UPDATE_EVENT = "notebooks.attachments.updated";
/** Editor → panel: current `@name` block handles in the note. */
export const NAMED_BLOCKS_UPDATE_EVENT = "notebooks.namedBlocks.updated";
/** Panel → editor/readonly view: scroll to a named `@ref` block handle. */
export const NAMED_BLOCK_SCROLL_EVENT = "notebooks.namedBlocks.scrollTo";

/**
 * Editor-side progressive enhancement: same-notebook note navigation updated
 * the URL + current note without a full SSR roundtrip. Detail = the new note
 * metadata plus SSR-equivalent sidebar/detail data, and `href`, the path and
 * query the note opens at. The event comes before the browser history shows
 * that address, so read the address from `href`, not from `window.location`.
 */
export const NOTE_SOFT_NAVIGATED_EVENT = "notebooks.note.softNavigated";
/** Sidebar → editor: the filter replaced the shown note's address in place, so a cancelled Back restores this one. */
export const SIDEBAR_FILTER_CHANGED_EVENT = "notebooks.sidebar.filterChanged";
/** Editor → local workspace surfaces while the persisted projection catches up. */
export const NOTE_TITLE_CHANGED_EVENT = "notebooks.note.titleChanged";

/** Editor → panel: connection (after a 1 s offline grace) and latest confirmed save. */
export const SYNC_STATE_EVENT = "notebooks.editor.syncState";
export type SyncStateEventDetail = { connected: boolean; lastSavedAt: string | null };
/** Panel → editor: request current sync, active heading and presence locations on mount. */
export const SYNC_STATE_REQUEST_EVENT = "notebooks.editor.syncStateRequest";
export type SyncStateRequestEventDetail = undefined;
/** Panel → editor: retry a dropped connection; terminal sync-ended states stay stopped. */
export const RECONNECT_EVENT = "notebooks.editor.reconnect";
export type ReconnectEventDetail = undefined;
/** Editor or reading view → panel: section containing the top of the reading area. */
export const ACTIVE_HEADING_EVENT = "notebooks.toc.activeHeading";
export type ActiveHeadingEventDetail = { id: string | null };
/** Editor → panel: remote users' cursor locations, keyed by user id. */
export const PRESENCE_LOCATIONS_EVENT = "notebooks.presence.locations";
export type PresenceLocationsEventDetail = Record<string, { writing: boolean; headingId: string | null; headingText: string | null }>;
/** Panel → editor: center a remote cursor without moving the local selection. */
export const JUMP_TO_PARTICIPANT_EVENT = "notebooks.editor.jumpToParticipant";
export type JumpToParticipantEventDetail = { userId: string };
/** Panel activity → comments: unfold the list if needed and bring this comment into view. */
export const REVEAL_COMMENT_EVENT = "notebooks.comments.reveal";
export type RevealCommentEventDetail = { commentId: string | null };
/** Panel → note tree: duplicate this note with the same dialog as the tree's menu. */
export const DUPLICATE_NOTE_EVENT = "notebooks.note.duplicate";
export type DuplicateNoteEventDetail = { noteId: string };
