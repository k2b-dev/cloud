import type { LayoutBreadcrumb } from "@k2b/cloud/ssr/layout-runtime";
import { baseLabel } from "./base-label";
import { filesUrl, pathCrumbs, showsOverview } from "./urls";
import type { WorkspaceSnapshot } from "./workspace-state";

type TrailBase = { id: string; label: string };

/**
 * The title array Files gives the shell: the app root (which the shell's rule
 * drops) and the current page. A folder is one level at every depth: the
 * parent row in its listing is the way up, and the sidebar tree shows where it
 * lies, so the shell draws no back link, path, or back arrow for it. Above a
 * storage root lies the overview of all storage, which is a level like a
 * folder. A document has no listing; its way up is its folder, with the
 * document's row selected, or the storage when it lies at the top.
 */
export const filesTitle = (
  appName: string,
  base: TrailBase | undefined,
  location: { folder: string; document?: { name: string; path: string } } | undefined,
): LayoutBreadcrumb[] => {
  const root = { title: appName, href: filesUrl() };
  if (!base || !location) return [{ title: appName }];
  const crumbs = pathCrumbs(location.folder);
  const document = location.document;
  if (document) {
    const folders = crumbs.map((crumb, index) => ({
      title: crumb.name,
      href: filesUrl(base.id, crumb.path, null, index === crumbs.length - 1 ? document.path : null),
    }));
    const above = folders.length ? folders : [{ title: base.label, href: filesUrl(base.id, "", null, document.path) }];
    return [root, ...above, { title: document.name }];
  }
  return [root, { title: crumbs.at(-1)?.name ?? base.label }];
};

/** The workspace title: the overview above storage roots, a folder, a document, or an app view. */
export const snapshotTitle = (
  snapshot: Pick<WorkspaceSnapshot, "source" | "directory" | "editor" | "bases">,
  appName: string,
  messages: { personal: string; allStorage: string },
  locale: string,
): LayoutBreadcrumb[] => {
  const params = new URL(snapshot.source, "https://files.invalid").searchParams;
  if (showsOverview(params, snapshot.bases.items.length)) return [{ title: appName, href: filesUrl() }, { title: messages.allStorage }];
  const view = params.get("view");
  const editor = snapshot.editor;
  if (view === "edit" && editor) {
    const path = editor.entry.path;
    return filesTitle(
      appName,
      { id: editor.base.id, label: baseLabel(editor.base, messages, locale) },
      { folder: path.split("/").slice(0, -1).join("/"), document: { name: editor.entry.name, path } },
    );
  }
  const directory = snapshot.directory;
  if (view || !directory) return [{ title: appName }];
  return filesTitle(appName, { id: directory.base.id, label: baseLabel(directory.base, messages, locale) }, { folder: directory.path });
};
