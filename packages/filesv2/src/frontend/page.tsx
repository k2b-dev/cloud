import { type AuthContext, getLocale, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { AccountIdentityError, coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import type { Context } from "hono";
import { filegateErrorCode } from "../api/filegate-error";
import { ssr } from "../config";
import { type BaseSummary, BrowseQuerySchema, EntryQuerySchema, type SearchQuery, SearchQuerySchema } from "../contracts";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import { SEARCH_REQUEST_SECONDS } from "../service/search";
import { browserMessages } from "./browser-messages";
import { browseOptions, parsePreferences, viewFor } from "./browser-preferences";
import { filesMessages } from "./messages";
import { searchRequest, searchState } from "./search-state";
import { snapshotTitle } from "./trail";
import { filesUrl, showsOverview } from "./urls";
import Workspace from "./Workspace.island";
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
  const search = searchState(new URL(c.req.url).searchParams);
  // A search orders and filters itself; only a folder reads the browse options.
  const query = (search ? BrowseQuerySchema.pick({ path: true, after: true }) : BrowseQuerySchema).safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  const requestedFile = c.req.query("file");
  const searchQuery = search ? SearchQuerySchema.safeParse({ ...searchRequest(search), ...query.data }) : null;
  if (searchQuery && !searchQuery.success) return ssr.error(c, 400);
  if (requestedFile && !EntryQuerySchema.safeParse({ path: requestedFile }).success) return ssr.error(c, 400);
  const requestedBase = c.req.query("base");
  const preferences = parsePreferences(c.req.header("cookie"));
  let browse = browseOptions(new URL(c.req.url).searchParams, viewFor(preferences, requestedBase ?? ""));
  const view = c.req.query("view");
  const trashView = view === "trash";
  const editView = view === "edit" && !!requestedFile;
  const source = new URL(
    filesUrl(requestedBase, query.data.path, query.data.after, requestedFile, search, browse),
    "https://files.invalid",
  );
  if (view === "trash" || view === "shares" || view === "recent" || view === "favorites" || editView) source.searchParams.set("view", view);
  if (c.req.query("refreshed") === "true") source.searchParams.set("refreshed", "true");
  const initial: WorkspaceSnapshot = {
    source: `${source.pathname}${source.search}`,
    bases: { items: [], issues: [], editor: null },
    selectedId: null,
    directory: null,
    errorCode: null,
  };
  try {
    initial.bases = await filesService.bases(requestCall(c));
    const overview = showsOverview(source.searchParams, initial.bases.items.length);
    const selected = overview
      ? undefined
      : requestedBase && view !== "shares"
        ? initial.bases.items.find((base) => base.id === requestedBase)
        : (initial.bases.items.find((base) => base.status === "existing") ?? initial.bases.items[0]);
    if (requestedBase && !selected && view !== "shares") throw new FilesError("not_found", 404);
    initial.selectedId = selected?.id ?? null;
    browse = browseOptions(new URL(c.req.url).searchParams, viewFor(preferences, selected?.id ?? ""));
    if (!search) for (const [key, value] of Object.entries(browse)) source.searchParams.set(key, String(value));
    initial.source = `${source.pathname}${source.search}`;
    if (view === "shares") initial.shares = await filesService.listShares(requestCall(c));
    else if (view === "recent") initial.marks = await filesService.recent(requestCall(c));
    else if (view === "favorites") initial.marks = await filesService.favorites(requestCall(c));
    else if (editView && selected?.status === "existing")
      initial.editor = await filesService.editor(requestCall(c), { baseId: selected.id, path: requestedFile! });
    else if (selected?.status === "existing" && !trashView) {
      initial.directory = searchQuery?.success
        ? await searchPage(c, requestCall(c), selected, searchQuery.data)
        : await filesService.list(requestCall(c), { baseId: selected.id, ...query.data, ...browse });
      if (requestedFile) {
        // Detail failures belong to the inspector, not the surrounding directory.
        initial.detail = await filesService.entry(requestCall(c), { baseId: selected.id, path: requestedFile }).catch(() => null);
      }
    }
  } catch (error) {
    if ((error instanceof FilesError || error instanceof FilegateError) && error.code === "cursor_invalid" && query.data.after) {
      source.searchParams.delete("after");
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
  const cloudUrl = publicCloudOrigin(await coreSettings.get<string>("app.url"));
  const locale = getLocale(c);
  const title = snapshotTitle(initial, t.files, browserMessages.resolve([locale]).t, locale);
  return () => (
    <Layout c={c} title={title} fullWidth fullPage>
      <Workspace initial={initial} preferences={preferences} cloudUrl={cloudUrl} />
    </Layout>
  );
});
