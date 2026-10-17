/**
 * URL builders for the Notebooks app.
 *
 * Path shape: `/app/notebooks/{notebookShortId}/notes/{noteShortId}` —
 * all user-visible IDs are 6-character readable IDs (see
 * `lib/short-id.ts`). Page handlers resolve these public IDs to internal
 * UUIDs; UUIDs are not accepted in user-visible routes.
 *
 * Mode toggles (`mode=versions`, `mode=graph`) stay as
 * query params: they're modes on the same
 * resource, not different resources, and forcing them into the path
 * would multiply the route registrations without UX gain.
 */

import type { PresentationMode } from "../lib/presentation-mode";
import { withPresentationMode } from "../lib/presentation-url";

// ============ Query Parameter Names ============

export const QueryParams = {
  MODE: "mode",
} as const;

// ============ URL Builders ============

/** Build URL for a note in edit mode. */
export const buildNoteUrl = (notebookShortId: string, noteShortId: string, mode?: PresentationMode): string => {
  const href = `/app/notebooks/${notebookShortId}/notes/${noteShortId}`;
  return mode ? withPresentationMode(href, mode) : href;
};

/** Build URL for version history. */
export const buildVersionsUrl = (notebookShortId: string, noteShortId: string): string =>
  `/app/notebooks/${notebookShortId}/notes/${noteShortId}?${QueryParams.MODE}=versions`;

/**
 * Build URL for the link graph. `note` is the note it starts from; `from: "book"` keeps the Book
 * presentation, so the graph opens in the Book shell and its links lead back into Book.
 */
export const buildGraphUrl = (notebookShortId: string, noteShortId: string | null, from?: "book"): string => {
  const query = new URLSearchParams({ [QueryParams.MODE]: "graph" });
  if (noteShortId) query.set("note", noteShortId);
  if (from) query.set("from", from);
  return `/app/notebooks/${notebookShortId}?${query}`;
};

/** Build URL for the attachments overview (path-based, NOT a query mode). */
export const buildAttachmentsUrl = (notebookShortId: string, mode?: PresentationMode): string => {
  const href = `/app/notebooks/${notebookShortId}/attachments`;
  return mode ? withPresentationMode(href, mode) : href;
};

/** Build URL for an individual tag's notes page. The tag list itself
 *  lives in a modal opened from the sidebar — there's no /tags overview
 *  page anymore. */
export const buildTagPageUrl = (notebookShortId: string, tag: string, mode?: PresentationMode): string => {
  const href = `/app/notebooks/${notebookShortId}/tags/${encodeURIComponent(tag)}`;
  return mode ? withPresentationMode(href, mode) : href;
};
