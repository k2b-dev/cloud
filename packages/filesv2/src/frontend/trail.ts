import type { LayoutBreadcrumb } from "@k2b/cloud/ssr/layout-runtime";
import { baseLabel } from "./base-label";
import { filesUrl, pathCrumbs } from "./urls";
import type { WorkspaceSnapshot } from "./workspace-state";

type TrailBase = { id: string; label: string };

/**
 * The title array Files gives the shell, so the page trail shows the folder
 * path: the app root (which the shell's rule drops), the folders above, and
 * the current folder. The storage itself is no level, because the sidebar
 * names it, so a top-level folder shows its title alone. A document's way up
 * is its folder, with the document's row selected, or the storage when it
 * lies at the top.
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
  const folders = crumbs.slice(0, -1).map((crumb) => ({ title: crumb.name, href: filesUrl(base.id, crumb.path) }));
  return [root, ...folders, { title: crumbs.at(-1)?.name ?? base.label }];
};

/** The title array for what the workspace shows: a folder, a document in the editor, or one of the app's own views. */
export const snapshotTitle = (
  snapshot: Pick<WorkspaceSnapshot, "source" | "directory" | "editor">,
  appName: string,
  messages: { myFiles: string },
  locale: string,
): LayoutBreadcrumb[] => {
  const view = new URL(snapshot.source, "https://files.invalid").searchParams.get("view");
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
