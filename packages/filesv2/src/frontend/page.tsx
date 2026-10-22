import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { AccountIdentityError, coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import { ssr } from "../config";
import { BrowseQuerySchema, EntryQuerySchema, SearchQuerySchema } from "../contracts";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import { readConfiguration } from "../service/configuration";
import { activityRequest } from "./ActivityView";
import { browserMessages } from "./browser-messages";
import { browseOptions, parsePreferences, viewFor } from "./browser-preferences";
import { itemHistoryRequest, itemHistorySource, movedEntry } from "./history-requests";
import { filesMessages } from "./messages";
import { snapshotTitle } from "./trail";
import { activityUrl, filesUrl, parseActivityFilters, showsOverview } from "./urls";
import Workspace from "./Workspace.island";
import type { WorkspaceSnapshot } from "./workspace-state";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const query = BrowseQuerySchema.safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  const requestedFile = c.req.query("file");
  const search = c.req.query("q")?.trim() || undefined;
  const scope = c.req.query("scope") === "folder" ? ("folder" as const) : ("tree" as const);
  if (search && !SearchQuerySchema.safeParse({ ...query.data, q: search }).success) return ssr.error(c, 400);
  if (requestedFile && !EntryQuerySchema.safeParse({ path: requestedFile }).success) return ssr.error(c, 400);
  const requestedBase = c.req.query("base");
  const preferences = parsePreferences(c.req.header("cookie"));
  let browse = browseOptions(new URL(c.req.url).searchParams, viewFor(preferences, requestedBase ?? ""));
  const view = c.req.query("view");
  const activityFilters = view === "activity" ? parseActivityFilters(new URL(c.req.url).searchParams) : undefined;
  if (activityFilters === null) return ssr.error(c, 400);
  const trashView = view === "trash";
  const editView = view === "edit" && !!requestedFile;
  const source = new URL(
    activityFilters
      ? activityUrl(activityFilters)
      : filesUrl(requestedBase, query.data.path, query.data.after, requestedFile, search, scope, browse),
    "https://files.invalid",
  );
  if (view === "trash" || view === "shares" || view === "recent" || view === "favorites" || editView) source.searchParams.set("view", view);
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
    browse = browseOptions(new URL(c.req.url).searchParams, viewFor(preferences, selected?.id ?? ""));
    if (!activityFilters) for (const [key, value] of Object.entries(browse)) source.searchParams.set(key, String(value));
    initial.source = `${source.pathname}${source.search}`;
    if (activityFilters) {
      // The same request as the client's loader; a failed first page leaves the view to load and report it itself.
      const request = activityRequest(activityFilters, { now, timeZone });
      initial.activity = await filesService
        .activity(requestCall(c), request)
        .then((page) => ({ filters: activityFilters, page }))
        .catch(() => null);
    } else if (view === "shares") initial.shares = await filesService.listShares(requestCall(c));
    else if (view === "recent") initial.marks = await filesService.recent(requestCall(c));
    else if (view === "favorites") initial.marks = await filesService.favorites(requestCall(c));
    else if (editView && selected?.status === "existing")
      initial.editor = await filesService.editor(requestCall(c), { baseId: selected.id, path: requestedFile! });
    else if (selected?.status === "existing" && !trashView) {
      initial.directory = search
        ? await filesService.search(requestCall(c), { baseId: selected.id, ...query.data, ...browse, q: search, scope })
        : await filesService.list(requestCall(c), { baseId: selected.id, ...query.data, ...browse }).catch(async (error: unknown) => {
            // An old folder address: the history may know where the folder went. Without visible history it stays 404.
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
            path: initial.detail.entry.path,
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
      <Workspace initial={initial} preferences={preferences} cloudUrl={cloudUrl} timeZone={timeZone} retentionDays={retentionDays} />
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
