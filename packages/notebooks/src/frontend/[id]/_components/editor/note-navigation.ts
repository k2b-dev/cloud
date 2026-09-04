import type { SoftNavigationResult } from "../../../lib/soft-navigation";
import { hasOnlyNavigatorQuery } from "../../../../lib/navigator-url";
import { inheritPresentationMode, requestedPresentationMode } from "../../../../lib/presentation-url";

export type NoteNavigationTarget = {
  noteShortId: string;
  canonicalHref: string;
};

export const resolveSameNotebookNoteTarget = (href: string, currentHref: string, notebookId: string): NoteNavigationTarget | null => {
  try {
    const noteId = href.match(/^note:\/\/([0-9a-zA-Z]{6})$/)?.[1];
    const raw = noteId ? `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${noteId}` : href;
    const current = new URL(currentHref);
    const url = new URL(inheritPresentationMode(raw, currentHref), current);
    const params = new URLSearchParams(url.searchParams);
    if (requestedPresentationMode(params)) params.delete("mode");
    if (url.origin !== current.origin || url.hash || !hasOnlyNavigatorQuery(params)) return null;
    const match = url.pathname.match(/^\/app\/notebooks\/([^/]+)\/notes\/([^/]+)$/);
    if (!match || decodeURIComponent(match[1]!) !== notebookId) return null;
    const noteShortId = decodeURIComponent(match[2]!);
    if (!/^[0-9A-Za-z]{6}$/.test(noteShortId)) return null;
    return { noteShortId, canonicalHref: `${url.pathname}${url.search}` };
  } catch {
    return null;
  }
};

type PendingNavigation = {
  source: string;
  push: boolean;
  resolve: (result: SoftNavigationResult) => void;
};

type Options = {
  initialSource: string;
  currentNoteShortId: () => string;
  currentHref: () => string;
  setSource: (source: string) => void;
  pushHistory: (href: string) => void;
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
      if (push && options.currentHref() !== target.canonicalHref) options.pushHistory(target.canonicalHref);
      return Promise.resolve({ kind: "applied", href: target.canonicalHref });
    }

    pending?.resolve({ kind: "superseded" });
    return new Promise<SoftNavigationResult>((resolve) => {
      pending = { source: target.canonicalHref, push, resolve };
      options.setSource(target.canonicalHref);
    });
  };

  const apply = (source: string, href: string, applyState: () => void): boolean => {
    const request = pending;
    if (!request || request.source !== source) return false;
    pending = undefined;
    committedSource = href;
    applyState();
    if (request.push) options.pushHistory(href);
    request.resolve({ kind: "applied", href });
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
