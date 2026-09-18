import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { AccountIdentityError } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import { ssr } from "../config";
import { BrowseQuerySchema, EntryQuerySchema, SearchQuerySchema } from "../contracts";
import { FilesError, filesService } from "../service";
import { parsePreferences } from "./browser-preferences";
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
  const trashView = c.req.query("view") === "trash";
  const initial: WorkspaceSnapshot = {
    source: `${filesUrl(requestedBase, query.data.path, query.data.after, requestedFile, search, scope)}${trashView ? `${requestedBase || query.data.path ? "&" : "?"}view=trash` : ""}`,
    bases: { items: [], issues: [] },
    selectedId: null,
    directory: null,
    errorCode: null,
  };
  try {
    initial.bases = await filesService.bases(actor);
    const selected = requestedBase
      ? initial.bases.items.find((base) => base.id === requestedBase)
      : (initial.bases.items.find((base) => base.status === "existing") ?? initial.bases.items[0]);
    if (requestedBase && !selected) throw new FilesError("not_found", 404);
    initial.selectedId = selected?.id ?? null;
    if (selected?.status === "existing" && !trashView) {
      initial.directory = search
        ? await filesService.search(actor, { baseId: selected.id, ...query.data, q: search, scope })
        : await filesService.list(actor, { baseId: selected.id, ...query.data });
      if (requestedFile) {
        // Detail failures belong to the inspector, not the surrounding directory.
        initial.detail = await filesService.entry(actor, { baseId: selected.id, path: requestedFile }).catch(() => null);
      }
    }
  } catch (error) {
    if (error instanceof FilesError || error instanceof AccountIdentityError) {
      c.status(error.status);
      initial.errorCode = error.code;
    } else if (error instanceof FilegateError) {
      c.status(error.status === 404 ? 404 : 503);
      initial.errorCode = error.status === 404 ? "not_found" : "unavailable";
    } else throw error;
  }
  const cloudUrl = publicCloudOrigin(await coreSettings.get<string>("app.url"));
  return () => (
    <Layout c={c} title={t.files} fullWidth fullPage>
      <Workspace initial={initial} preferences={parsePreferences(c.req.header("cookie"))} cloudUrl={cloudUrl} />
    </Layout>
  );
});
