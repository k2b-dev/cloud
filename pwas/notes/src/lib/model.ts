/**
 * Shared shapes of the notes SPA. A note is one Yjs document whose Markdown lives in `Y.Text("text")`;
 * everything else here is derived from that text or kept beside it in the browser's own store.
 */

/** The name of the one text type in every note document; the server accepts nothing else. */
export const NOTE_TEXT = "text";

/** Editor limit today (UTF-16 code units), see bauplan F4. */
export const MAX_NOTE_LENGTH = 2_097_152;
/** Largest file a note accepts, after client-side image resizing. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Longest image side after resizing in the browser. */
export const IMAGE_MAX_SIDE = 1600;
/** Files per note (server checks too). */
export const MAX_FILES_PER_NOTE = 20;
/** Import limits from bauplan §3 Browser. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 1000;

export type ChartPreview = { kind: "line" | "bar"; values: number[] };

export type TaskPreview = { done: boolean; text: string };

/** Everything the overview, search and export need without opening the Yjs document. */
export type NoteMeta = {
  title: string;
  tags: string[];
  headings: string[];
  /** First prose lines, without Markdown markers, at most ~240 characters. */
  excerpt: string;
  /** First open tasks, at most 3, for the "Weiterschreiben" card. */
  tasks: TaskPreview[];
  chart: ChartPreview | null;
  /** Key of the first local image file, if the note shows one. */
  image: string | null;
  length: number;
};

/**
 * How a note relates to the server.
 * - `own`: this browser shared it and holds both links.
 * - `foreign`: opened from someone else's link; `role` is what that link allows.
 */
export type NoteShare =
  | { kind: "own"; readId: string; editId: string; sharedAt: number }
  | { kind: "foreign"; role: "read" | "edit"; linkId: string; readId: string; addedAt: number };

export type NoteRecord = {
  id: string;
  meta: NoteMeta;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  share: NoteShare | null;
  /** Deleting a shared note waits for the server; offline it stays visible as pending. */
  pendingDelete: boolean;
};

export type StoreErrorCode = "quota" | "unavailable";

export type StoreUsage = { notes: number; files: number; bytes: number; quota: number | null; persisted: boolean };
