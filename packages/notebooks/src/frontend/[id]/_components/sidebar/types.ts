import type { DateContext } from "@k2b/stdlib";
import type { NoteDeletePermission } from "../../../../lib/note-delete-permission";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { SidebarFilter } from "../../../../lib/sidebar-filter";
import type { SidebarList, SidebarTreeState } from "../../../../lib/sidebar-tree";
import type { NotebookSettings } from "../settings/NotebookSettingsStore";

/** Notebook metadata (matches backend NotebookSchema) */
export type Notebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  defaultPresentationMode: PresentationMode;
  defaultNoteTitleTemplate: string;
  noteDeletePermission: NoteDeletePermission;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TagSummary = {
  tag: string;
  count: number;
};

/** Shared context for notebook components */
export type NotebookContext = {
  notebook: Notebook;
  /** The levels of the note tree the sidebar shows on arrival. */
  sidebarTree: SidebarTreeState;
  /** The first page of the sidebar filter in the address, if any. */
  sidebarList: SidebarList | null;
  selectedNoteId: string | null;
  userId: string;
  settings: NotebookSettings;
  /** Global preference: the desktop navigation is hidden completely. */
  navigationHidden: boolean;
  /** Personal reading-column preference shared by Write, Read-only and Book. */
  fullWidth: boolean;
  permission: string;
  /** Number of attachments in the notebook — gates the sidebar link. */
  attachmentCount: number;
  /** Current user's favorite public note IDs for this notebook. */
  favoriteNoteIds: string[];
  /** Tag summaries for the sidebar's tag filter. */
  tags: TagSummary[];
  /** Workspace event cursor captured before the SSR snapshot was loaded. */
  workspaceCursor: string | null;
  dateConfig: DateContext;
  /** The sidebar's list filter from the address; empty shows the note tree. */
  sidebarFilter: SidebarFilter;
  /** Explicit URL choice, preserved across workspace note navigation. */
  presentationMode?: PresentationMode;
};
