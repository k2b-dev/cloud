import type { LayoutBreadcrumb } from "@k2b/cloud/ssr/layout-runtime";
import { baseLabel } from "./base-label";
import { filesUrl, pathCrumbs, showsOverview } from "./urls";
import type { WorkspaceSnapshot } from "./workspace-state";

/**
 * The title array Files gives the shell: the app root (which the shell's rule
 * drops) and the current page. A folder is one level at every depth: the
 * parent row in its listing is the way up, and the sidebar tree shows where it
 * lies, so the shell draws no back link, path, or back arrow for it. Above a
 * storage root lies the overview of all storage, which is a level like a
 * folder. An open document is one level too: its editor's own close leads
 * back to where the person came from, so the shell repeats neither its name
 * nor a way up above the editor.
 */
const filesTitle = (appName: string, base: string, folder: string): LayoutBreadcrumb[] => [
  { title: appName, href: filesUrl() },
  { title: pathCrumbs(folder).at(-1)?.name ?? base },
];

/** The workspace title: the overview above storage roots, a folder, a document, or an app view. */
export const snapshotTitle = (
  snapshot: Pick<WorkspaceSnapshot, "source" | "directory" | "editor" | "bases"> & { moved?: { baseId: string; path: string } | null },
  appName: string,
  messages: { personal: string; allStorage: string; activity?: string },
  locale: string,
): LayoutBreadcrumb[] => {
  const params = new URL(snapshot.source, "https://files.invalid").searchParams;
  if (showsOverview(params, snapshot.bases.items.length)) return [{ title: appName, href: filesUrl() }, { title: messages.allStorage }];
  const view = params.get("view");
  const editor = snapshot.editor;
  if (view === "edit" && editor) return [{ title: appName, href: filesUrl() }, { title: editor.entry.name }];
  if (view === "activity" && messages.activity) return [{ title: appName, href: filesUrl() }, { title: messages.activity }];
  const moved = snapshot.moved;
  if (!view && moved) {
    const base = snapshot.bases.items.find((item) => item.id === moved.baseId);
    if (base) return filesTitle(appName, baseLabel(base, messages, locale), moved.path);
  }
  const directory = snapshot.directory;
  if (view || !directory) return [{ title: appName }];
  return filesTitle(appName, baseLabel(directory.base, messages, locale), directory.path);
};
