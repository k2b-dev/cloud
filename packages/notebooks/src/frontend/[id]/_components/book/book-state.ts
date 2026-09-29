import type { BookTreeNode } from "./BookNavigator.island";

export type BookSnapshot = {
  href: string;
  html: string | null;
  title: string | null;
  notebookName: string;
  selectedNoteId: string | null;
  tree: BookTreeNode[];
  tags: Array<{ tag: string; count: number }>;
  activeTag?: string;
  canWrite: boolean;
  locked: boolean;
  historyIncomplete: boolean;
  cursor: string | null;
};

export type BookMetadata = Omit<BookSnapshot, "html">;
export const BOOK_SNAPSHOT_EVENT = "notebooks:book-snapshot";
export const BOOK_CONTENT_EVENT = "notebooks:book-content";
const BOOK_NAVIGATION_REQUEST_EVENT = "notebooks:book-navigation-request";

type BookNavigationRequest = { href: string; handled: boolean };

declare global {
  interface WindowEventMap {
    "notebooks:book-navigation-request": CustomEvent<BookNavigationRequest>;
  }
}

/** Asks the reading shell to open a reading route in place; `false` when no shell took it. A shell that takes it owns the load and its failures. */
export const requestBookNavigation = (href: string): boolean => {
  const detail: BookNavigationRequest = { href, handled: false };
  window.dispatchEvent(new CustomEvent(BOOK_NAVIGATION_REQUEST_EVENT, { detail }));
  return detail.handled;
};

export const handleBookNavigationRequests = (open: (href: string) => boolean): (() => void) => {
  const listener = (event: CustomEvent<BookNavigationRequest>) => {
    if (!event.detail.handled) event.detail.handled = open(event.detail.href);
  };
  window.addEventListener(BOOK_NAVIGATION_REQUEST_EVENT, listener);
  return () => window.removeEventListener(BOOK_NAVIGATION_REQUEST_EVENT, listener);
};

/** Only the reading routes inside the current notebook can reuse this shell. */
export const bookNavigationTarget = (href: string, currentHref: string, notebookId: string): URL | null => {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentHref);
    target = new URL(href, current);
  } catch {
    return null;
  }
  if (target.origin !== current.origin || target.username || target.password) return null;
  const prefix = `/app/notebooks/${notebookId}`;
  const suffix = target.pathname.slice(prefix.length);
  if (!target.pathname.startsWith(prefix) || (suffix !== "" && suffix !== "/" && !/^\/(?:notes\/[A-Za-z0-9]{6}|tags\/[^/]+)$/.test(suffix)))
    return null;
  if (target.searchParams.has("mode") && target.searchParams.get("mode") !== "book") return null;
  target.searchParams.set("mode", "book");
  return target;
};
