import type { DateContext } from "@k2b/stdlib";
import type { NavigatorQuery } from "../../../../lib/navigator-url";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { NotebookSettings } from "../settings/NotebookSettingsStore";

/** Notebook metadata (matches backend NotebookSchema) */
export type Notebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  /** Per-notebook opt-in for `\`\`\`script` block execution. */
  scriptsEnabled: boolean;
  defaultPresentationMode: PresentationMode;
  defaultNoteTitleTemplate: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Note tree node (matches backend NoteTreeNodeSchema) */
export type NoteTreeNode = {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  yjsSnapshotAt: string | null;
  contentMd: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  children: NoteTreeNode[];
};

export type TagSummary = {
  tag: string;
  count: number;
};

/** Shared context for notebook components */
export type NotebookContext = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  selectedNoteId: string | null;
  userId: string;
  settings: NotebookSettings;
  permission: string;
  /** Number of attachments in the notebook — gates the sidebar link. */
  attachmentCount: number;
  /** Current user's favorite public note IDs for this notebook. */
  favoriteNoteIds: string[];
  /** Tag summaries for the navigator sidebar. */
  tags: TagSummary[];
  /** Workspace event cursor captured before the SSR snapshot was loaded. */
  workspaceCursor: string | null;
  dateConfig: DateContext;
  navigatorQuery: NavigatorQuery;
};
