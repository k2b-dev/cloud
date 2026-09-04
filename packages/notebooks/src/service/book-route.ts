import { Placeholder } from "@k2b/ui";
import { renderToString } from "solid-js/web";
import BookTagContent from "../frontend/[id]/_components/book/BookTagContent";
import { type BookSnapshot, bookNavigationTarget } from "../frontend/[id]/_components/book/book-state";
import { bookMessages } from "../frontend/[id]/_components/book/messages";
import { loadBookNote } from "./book";
import * as notebooks from "./notebooks";
import * as notes from "./notes";
import * as tags from "./tags";
import * as workspaceEvents from "./workspace-events";

/** A Book refresh uses the same authorization and renderer as the direct page. */
export const loadBookRoute = async (params: {
  notebookId: string;
  notebookShortId: string;
  userId: string;
  locale: string;
  origin: string;
  href: string;
  bypassAccess?: boolean;
}) => {
  const permission = params.bypassAccess
    ? "admin"
    : await notebooks.getPermission({ notebookId: params.notebookId, userId: params.userId });
  if (permission === "none") return { kind: "denied" as const };
  const target = bookNavigationTarget(params.href, params.origin, params.notebookShortId);
  if (!target) return { kind: "invalid" as const };
  const route = target.pathname.slice(`/app/notebooks/${params.notebookShortId}/`.length);
  const [kind, rawId] = route.split("/");
  let resource: string;
  try {
    resource = decodeURIComponent(rawId ?? "");
  } catch {
    return { kind: "invalid" as const };
  }
  const requestedPage = Number.parseInt(target.searchParams.get("page") ?? "1", 10);
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0 && Number.isSafeInteger((requestedPage - 1) * 50) ? requestedPage : 1;
  const offset = (page - 1) * 50;
  // Cursor before data: updates during the snapshot are replayed, never lost.
  const cursor = await workspaceEvents.latestCursor({ notebookId: params.notebookId });
  const notebook = await notebooks.get({ id: params.notebookId });
  if (!notebook) return { kind: "not_found" as const };
  const [tree, tagList] = await Promise.all([
    notes.getTree({ notebookId: params.notebookId }),
    tags.listForNotebook({ notebookId: params.notebookId }),
  ]);
  const projectTree = (nodes: typeof tree): BookSnapshot["tree"] =>
    nodes.map((node) => ({ id: node.shortId, title: node.title, children: projectTree(node.children) }));
  const common = {
    href: `${target.pathname}${target.search}${target.hash}`,
    notebookName: notebook.name,
    tree: projectTree(tree),
    tags: tagList,
    canWrite: permission === "write" || permission === "admin",
    cursor,
  };
  if (!kind) {
    const t = bookMessages.resolve([params.locale]).t;
    const snapshot: BookSnapshot = {
      ...common,
      title: null,
      selectedNoteId: null,
      locked: false,
      html: renderToString(() => Placeholder({ icon: "ti ti-book", description: tree.length ? t.selectNote : t.empty })),
    };
    return { kind: "ok" as const, snapshot };
  }
  if (kind === "notes") {
    const loaded = await loadBookNote({ ...params, noteShortId: resource });
    if (!loaded) return { kind: "not_found" as const };
    const snapshot: BookSnapshot = {
      ...common,
      html: loaded.document.html,
      title: loaded.note.title,
      selectedNoteId: loaded.note.shortId,
      locked: !!loaded.note.lockedAt,
    };
    return { kind: "ok" as const, snapshot };
  }
  const tag = resource.toLowerCase();
  const search = (target.searchParams.get("search") ?? "").trim();
  const [results, totalNotesForTag] = await Promise.all([
    tags.listNotesForTag({ notebookId: params.notebookId, tag, search: search || undefined, pagination: { limit: 50, offset } }),
    tags.countNotesForTag({ notebookId: params.notebookId, tag }),
  ]);
  const html = renderToString(() =>
    BookTagContent({
      notebookId: params.notebookShortId,
      tag,
      search,
      page,
      items: results.items,
      total: results.total,
      totalNotesForTag,
      locale: params.locale,
    }),
  );
  const snapshot: BookSnapshot = { ...common, html, title: `#${tag}`, selectedNoteId: null, activeTag: tag, locked: false };
  return { kind: "ok" as const, snapshot };
};
