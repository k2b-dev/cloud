import { anchorHash, parseNoteLink } from "../../../../lib/heading-anchors";
import { hasOnlyNavigatorQuery } from "../../../../lib/navigator-url";
import { inheritPresentationMode, requestedPresentationMode } from "../../../../lib/presentation-url";
import type { SoftNavigationResult } from "../../../lib/soft-navigation";

export type NoteNavigationTarget = {
  noteShortId: string;
  /** The note's address without a fragment: the route state source. */
  canonicalHref: string;
  /** `#heading-…` when the link opens a heading of the note, otherwise empty. */
  hash: string;
};

/** The Book heading id a URL fragment names, or null. */
export const headingFromHash = (hash: string): string | null => (/^#heading-[a-z0-9-]+$/.test(hash) ? hash.slice(1) : null);

export const resolveSameNotebookNoteTarget = (href: string, currentHref: string, notebookId: string): NoteNavigationTarget | null => {
  try {
    const note = parseNoteLink(href);
    const raw = note ? `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${note.noteId}${anchorHash(note.anchor)}` : href;
    const current = new URL(currentHref);
    const url = new URL(inheritPresentationMode(raw, currentHref), current);
    const params = new URLSearchParams(url.searchParams);
    if (requestedPresentationMode(params)) params.delete("mode");
    // The editor opens a heading of a note itself; any other fragment is left to the browser.
    if (url.origin !== current.origin || (url.hash && !headingFromHash(url.hash)) || !hasOnlyNavigatorQuery(params)) return null;
    const match = url.pathname.match(/^\/app\/notebooks\/([^/]+)\/notes\/([^/]+)$/);
    if (!match || decodeURIComponent(match[1]!) !== notebookId) return null;
    const noteShortId = decodeURIComponent(match[2]!);
    if (!/^[0-9A-Za-z]{6}$/.test(noteShortId)) return null;
    return { noteShortId, canonicalHref: `${url.pathname}${url.search}`, hash: url.hash };
  } catch {
    return null;
  }
};

type PendingNavigation = {
  source: string;
  hash: string;
  push: boolean;
  resolve: (result: SoftNavigationResult) => void;
};

type Options = {
  initialSource: string;
  currentNoteShortId: () => string;
  /** Path, query and fragment of the current address. */
  currentHref: () => string;
  setSource: (source: string) => void;
  pushHistory: (href: string) => void;
  /** After every applied navigation: the open note and the heading it opens at, or null for none. */
  showHeading: (noteShortId: string, heading: string | null) => void;
};

export const createNoteNavigationCoordinator = (options: Options) => {
  let committedSource = options.initialSource;
  let pending: PendingNavigation | undefined;

  const navigate = (target: NoteNavigationTarget, push: boolean): Promise<SoftNavigationResult> => {
    if (target.noteShortId === options.currentNoteShortId()) {
      if (pending) {
        pending.resolve({ kind: "superseded" });
        pending = undefined;
        options.setSource(committedSource);
      }
      const href = `${target.canonicalHref}${target.hash}`;
      if (push && options.currentHref() !== href) options.pushHistory(href);
      // Every link to a heading of the open note moves there, also when the address already names it.
      options.showHeading(target.noteShortId, headingFromHash(target.hash));
      return Promise.resolve({ kind: "applied", href });
    }

    pending?.resolve({ kind: "superseded" });
    return new Promise<SoftNavigationResult>((resolve) => {
      pending = { source: target.canonicalHref, hash: target.hash, push, resolve };
      options.setSource(target.canonicalHref);
    });
  };

  const apply = (source: string, href: string, applyState: () => void): boolean => {
    const request = pending;
    if (!request || request.source !== source) return false;
    pending = undefined;
    committedSource = href;
    applyState();
    if (request.push) options.pushHistory(`${href}${request.hash}`);
    options.showHeading(options.currentNoteShortId(), headingFromHash(request.hash));
    request.resolve({ kind: "applied", href: `${href}${request.hash}` });
    return true;
  };

  const fail = (source: string): boolean => {
    const request = pending;
    if (!request || request.source !== source) return false;
    pending = undefined;
    options.setSource(committedSource);
    request.resolve({ kind: "fallback" });
    return true;
  };

  const dispose = () => {
    pending?.resolve({ kind: "superseded" });
    pending = undefined;
  };

  return { navigate, apply, fail, dispose };
};
