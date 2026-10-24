/**
 * The sidebar's view of the note tree, as the server hands it to the browser:
 * only the levels a person opened, each as a window of rows. Shared by the
 * page loader, the API and the sidebar island.
 */

export type SidebarTreeSort = "title" | "updated" | "created";

/** One note row, without Markdown. IDs are public short IDs. */
export type SidebarNote = {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

/** A filtered list row also names the note's tags. */
export type SidebarListNote = SidebarNote & { tags: string[] };

/** Rows `offset` … `offset + items.length` of one level with `total` notes. `parentId` null is the top level. */
export type SidebarLevel = {
  parentId: string | null;
  total: number;
  offset: number;
  items: SidebarNote[];
};

export type SidebarTreeState = {
  /** Notes in the notebook. */
  total: number;
  levels: SidebarLevel[];
  /** Branches open on arrival: every branch of a small notebook, otherwise the way to the open note. */
  expandedIds: string[];
};

export type SidebarList = { total: number; offset: number; items: SidebarListNote[] };

/** Rows one level shows at once; "Show more" loads the next page. */
export const SIDEBAR_PAGE_SIZE = 100;
/** The most rows one level request returns. */
export const SIDEBAR_MAX_WINDOW = 1000;
/** The most levels one refresh asks for. */
export const SIDEBAR_MAX_LEVELS = 50;

/** The key of a level in maps: its parent's ID, or an empty string for the top level. */
export const levelKey = (parentId: string | null): string => parentId ?? "";

export const isSidebarTreeSort = (value: unknown): value is SidebarTreeSort =>
  value === "title" || value === "updated" || value === "created";
