import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AccountIdentityError, coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import { ssr } from "../config";
import { BrowseQuerySchema, EntryQuerySchema, SearchQuerySchema } from "../contracts";
import { FilesError, filesService } from "../service";
import { browseOptions, parsePreferences, viewFor } from "./browser-preferences";
import { filesMessages } from "./messages";
import { filesUrl } from "./urls";
import Workspace from "./Workspace.island";
import type { WorkspaceSnapshot } from "./workspace-state";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const actor = c.get("actor");
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
  const trashView = view === "trash";
  const editView = view === "edit" && !!requestedFile;
  const source = new URL(filesUrl(requestedBase, query.data.path, query.data.after, requestedFile, search, scope, browse), "https://files.invalid");
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
    initial.bases = await filesService.bases(actor);
    const selected = requestedBase && view !== "shares"
      ? initial.bases.items.find((base) => base.id === requestedBase)
      : (initial.bases.items.find((base) => base.status === "existing") ?? initial.bases.items[0]);
    if (requestedBase && !selected && view !== "shares") throw new FilesError("not_found", 404);
    initial.selectedId = selected?.id ?? null;
    browse = browseOptions(new URL(c.req.url).searchParams, viewFor(preferences, selected?.id ?? ""));
    for (const [key, value] of Object.entries(browse)) source.searchParams.set(key, String(value));
    initial.source = `${source.pathname}${source.search}`;
    if (view === "shares") initial.shares = await filesService.listShares(actor);
    else if (view === "recent") initial.marks = await filesService.recent(actor);
    else if (view === "favorites") initial.marks = await filesService.favorites(actor);
    else if (editView && selected?.status === "existing") initial.editor = await filesService.editor(actor, { baseId: selected.id, path: requestedFile! });
    else if (selected?.status === "existing" && !trashView) {
      initial.directory = search
        ? await filesService.search(actor, { baseId: selected.id, ...query.data, ...browse, q: search, scope })
        : await filesService.list(actor, { baseId: selected.id, ...query.data, ...browse });
      if (requestedFile) {
        // Detail failures belong to the inspector, not the surrounding directory.
        initial.detail = await filesService.entry(actor, { baseId: selected.id, path: requestedFile }).catch(() => null);
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
  const title = initial.editor
    ? [
        { title: t.files, href: filesUrl(initial.editor.base.id, initial.editor.entry.path.split("/").slice(0, -1).join("/"), null, initial.editor.entry.path) },
        { title: initial.editor.entry.name },
      ]
    : t.files;
  return () => (
    <Layout c={c} title={title} fullWidth fullPage>
      <Workspace initial={initial} preferences={preferences} cloudUrl={cloudUrl} />
    </Layout>
  );
});
