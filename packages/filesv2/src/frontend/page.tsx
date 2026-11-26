import { type AuthContext, getLocale, getTimeZone, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { hintOpen, Layout, markHintSeen } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import type { Context } from "hono";
import { filegateErrorCode } from "../api/filegate-error";
import { ssr } from "../config";
import { type BaseSummary, BrowseQuerySchema, EntryQuerySchema, type SearchQuery, SearchQuerySchema } from "../contracts";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import { readConfiguration } from "../service/configuration";
import { SEARCH_REQUEST_SECONDS } from "../service/search";
import { browserMessages } from "./browser-messages";
import { parsePreferences, viewFor } from "./browser-preferences";
import { directoryPageCount, directoryPages } from "./directory-pages";
import FilesScreen from "./FilesScreen.island";
import { browseOf, folderQueries, legacyFolderHref, readFolderAddress, searchOf } from "./folder-query";
import { RECENT_MOVED_HINT, SELECTION_PILL_HINT } from "./hints";
import { activityRequest, itemHistoryRequest, itemHistorySource, movedEntry } from "./history-requests";
import { filesMessages } from "./messages";
import { FAVORITES_PREVIEW, RECENT_LINES } from "./OverviewPane";
import { filesPageScope } from "./page-scope";
import { searchRequest } from "./search-state";
import { snapshotTitle } from "./trail";
import { activityUrl, filesUrl, parseActivityFilters, showsOverview } from "./urls";
import type { DirectoryView, WorkspaceSnapshot } from "./workspace-state";

/**
 * The first search page. A failed search keeps the search view with its error code, so the field and filters
 * stay usable to narrow it; a stale cursor still restarts the page.
 */
async function searchPage(c: Context, call: ReturnType<typeof requestCall>, base: BaseSummary, query: SearchQuery): Promise<DirectoryView> {
  setRequestTimeout(c, SEARCH_REQUEST_SECONDS);
  try {
    return await filesService.search(call, { baseId: base.id, ...query, signal: c.req.raw.signal });
  } catch (error) {
    if (!(error instanceof FilesError || error instanceof FilegateError) || error.code === "cursor_invalid") throw error;
    const code = error instanceof FilesError ? error.code : filegateErrorCode(error);
    return { base, path: query.path, items: [], next: null, query: query.q, scope: query.scope, total: null, failure: code };
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
}

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const url = new URL(c.req.url);
  const view = c.req.query("view");
  // A folder or a search is the v2 screen; its address is the list query's. Addresses from before keep working.
  const folderView = !view;
  const legacy = folderView ? legacyFolderHref(url.searchParams) : null;
  if (legacy) return c.redirect(legacy);
  const preferences = parsePreferences(c.req.header("cookie"));
  const queries = folderQueries(browserMessages.resolve([getLocale(c)]).t);
  const addressFor = (baseId: string) => readFolderAddress(queries, url.searchParams, viewFor(preferences, baseId));
  const requestedBase = c.req.query("base");
  // Only a folder searches; the other views read their own parameters.
  const search = folderView ? searchOf(addressFor(requestedBase ?? ""), url.searchParams) : null;
  const query = BrowseQuerySchema.pick({ path: true, after: true }).safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  let pages: number;
  try {
    pages = directoryPageCount(new URL(c.req.url).searchParams);
  } catch {
    return ssr.error(c, 400);
  }
  const requestedFile = c.req.query("file");
  const searchQuery = search ? SearchQuerySchema.safeParse({ ...searchRequest(search), ...query.data }) : null;
  if (searchQuery && !searchQuery.success) return ssr.error(c, 400);
  if (requestedFile && !EntryQuerySchema.safeParse({ path: requestedFile }).success) return ssr.error(c, 400);
  // Recent became Activity's "Me" (08.11.2026); old links and bookmarks keep working.
  if (view === "recent") return c.redirect(activityUrl({ actor: "me" }));
  const activityFilters = view === "activity" ? parseActivityFilters(new URL(c.req.url).searchParams) : undefined;
  if (activityFilters === null) return ssr.error(c, 400);
  const trashView = view === "trash";
  const editView = view === "edit" && !!requestedFile;
  const source = new URL(
    activityFilters
      ? activityUrl(activityFilters)
      : folderView
        ? `${url.pathname}${url.search}`
        : filesUrl(requestedBase, query.data.path, query.data.after, requestedFile),
    "https://files.invalid",
  );
  if (pages > 1) source.searchParams.set("pages", String(pages));
  if (view === "trash" || view === "shares" || view === "favorites" || editView) source.searchParams.set("view", view);
  if (c.req.query("refreshed") === "true") source.searchParams.set("refreshed", "true");
  const timeZone = getTimeZone(c);
  const now = new Date().toISOString();
  const initial: WorkspaceSnapshot = {
    source: `${source.pathname}${source.search}`,
    bases: { items: [], issues: [], editor: null },
    selectedId: null,
    directory: null,
    errorCode: null,
    now,
  };
  // Retention is named when a history search finds nothing; an unreadable configuration keeps the default.
  const retentionDays = await readConfiguration().then(
    (config) => config.activityRetentionDays,
    () => 365,
  );
  try {
    initial.bases = await filesService.bases(requestCall(c));
    const overview = showsOverview(source.searchParams, initial.bases.items.length);
    const selected = overview
      ? undefined
      : activityFilters
        ? initial.bases.items.find((base) => base.id === activityFilters.baseId)
        : requestedBase && view !== "shares"
          ? initial.bases.items.find((base) => base.id === requestedBase)
          : (initial.bases.items.find((base) => base.status === "existing") ?? initial.bases.items[0]);
    if (requestedBase && !selected && view !== "shares") throw new FilesError("not_found", 404);
    initial.selectedId = selected?.id ?? null;
    const address = addressFor(selected?.id ?? "");
    const browse = address.mode === "folder" ? browseOf(address.state) : undefined;
    initial.source = `${source.pathname}${source.search}`;
    if (activityFilters) {
      // The same request as the client's loader; a failed first page leaves the view to load and report it itself.
      const request = activityRequest(activityFilters, { now, timeZone });
      [initial.activity, initial.marks] = await Promise.all([
        filesService
          .activity(requestCall(c), request)
          .then((page) => ({ filters: activityFilters, page }))
          .catch(() => null),
        // "Me" also lists the files this person opened; without them it still shows the changes.
        activityFilters.actor === "me" ? filesService.recent(requestCall(c)).catch(() => undefined) : undefined,
      ]);
    } else if (view === "shares") initial.shares = await filesService.listShares(requestCall(c)).catch(() => null);
    else if (view === "favorites") initial.marks = await filesService.favorites(requestCall(c));
    // The trash shows its first page in the first picture; a failed read lets the view say so with Try again.
    else if (trashView && selected?.status === "existing")
      initial.trash = await filesService.trash(requestCall(c), { baseId: selected.id }).catch(() => null);
    else if (overview)
      // The overview's three parts are in the first picture, so nothing loads or moves after it; each fails alone.
      [initial.favoritesPreview, initial.recentByYou] = await Promise.all([
        filesService
          .favorites(requestCall(c), { limit: FAVORITES_PREVIEW + 1 })
          .then((items) => ({ items: items.slice(0, FAVORITES_PREVIEW), more: items.length > FAVORITES_PREVIEW }))
          .catch(() => null),
        Promise.all([
          filesService.activity(requestCall(c), { actor: "me", limit: RECENT_LINES }),
          filesService.recent(requestCall(c)).catch(() => []),
        ])
          .then(([page, opened]) => ({ page, opened }))
          .catch(() => null),
      ]);
    else if (editView && selected?.status === "existing")
      initial.editor = await filesService.editor(requestCall(c), { baseId: selected.id, path: requestedFile! });
    else if (selected?.status === "existing" && !trashView) {
      initial.directory = await directoryPages(
        pages,
        query.data.after,
        (after) =>
          searchQuery?.success
            ? searchPage(c, requestCall(c), selected, { ...searchQuery.data, after })
            : filesService.list(requestCall(c), { baseId: selected.id, ...query.data, ...browse, after }),
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_SECONDS * 1000)]),
      ).catch(async (error: unknown) => {
        const missing =
          (error instanceof FilesError && error.code === "not_found") || (error instanceof FilegateError && error.status === 404);
        if (!missing || !query.data.path || query.data.after) throw error;
        initial.moved = await movedLookup(c, selected.id, query.data.path);
        if (!initial.moved) throw error;
        c.status(404);
        return null;
      });
      if (requestedFile && initial.directory) {
        // Detail failures belong to the inspector, not the surrounding directory.
        initial.detail = await filesService.entry(requestCall(c), { baseId: selected.id, path: requestedFile }).catch(() => null);
        if (initial.detail) {
          const request = itemHistoryRequest(initial.detail.base, {
            ...initial.detail.entry,
            resourceId: initial.detail.entry.resourceId ?? initial.detail.resourceId,
          });
          initial.history = await filesService
            .activity(requestCall(c), request)
            .then((page) => ({ source: itemHistorySource(request), page }))
            .catch(() => null);
        }
      }
    }
  } catch (error) {
    if (
      (error instanceof FilesError || error instanceof FilegateError) &&
      error.code === "cursor_invalid" &&
      (query.data.after || pages > 1)
    ) {
      source.searchParams.delete("after");
      source.searchParams.delete("pages");
      source.searchParams.set("refreshed", "true");
      return c.redirect(`${source.pathname}${source.search}`);
    }
    if (error instanceof FilesError || error instanceof AccountIdentityError) {
      c.status(error.status);
      initial.errorCode = error.code;
    } else if (error instanceof FilegateError) {
      c.status(error.status === 404 ? 404 : 503);
      initial.errorCode = error.status === 404 ? "not_found" : "unavailable";
    } else throw error;
  }
  // Opening "Me" is using the new place, which counts as having seen the hint.
  const selectionPill = hintOpen(c, SELECTION_PILL_HINT, { allowed: true });
  if (activityFilters?.actor === "me") {
    markHintSeen(c, RECENT_MOVED_HINT);
    initial.hints = { selectionPill };
  } else initial.hints = { recentMoved: hintOpen(c, RECENT_MOVED_HINT, { allowed: true }), selectionPill };
  const locale = getLocale(c);
  const title = snapshotTitle(initial, t.files, browserMessages.resolve([locale]).t, locale);
  const scope = filesPageScope(initial) ?? undefined;
  return () => (
    <Layout context={{ scope }} c={c} title={title} fullWidth fullPage ui="v2">
      <FilesScreen initial={initial} preferences={preferences} timeZone={timeZone} retentionDays={retentionDays} />
    </Layout>
  );
});

/** The reader's own projection decides what this person may learn about the old address; the chain re-checks the new one. */
async function movedLookup(c: Parameters<typeof requestCall>[0], baseId: string, path: string) {
  const page = await filesService.activity(requestCall(c), { baseId, path, scope: "item" }).catch(() => null);
  const entry = page ? movedEntry(page, path) : null;
  if (!entry) return null;
  const chain = await filesService.movementChain(requestCall(c), { activityId: entry.id, oldPath: path }).catch(() => null);
  return chain ? { baseId, path, entry, chain } : null;
}
