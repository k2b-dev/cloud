import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { listenPopState } from "@k2b/ssr/nav";

export const listenForSelectedItem = (select: (itemId: string | null) => void): (() => void) =>
  listenPopState(({ url }) => {
    select(url.searchParams.get("item"));
  });

type Folder = { title: string; href: string };

export const showFolder = (folders: Folder[], folder: { name: string }) =>
  layout.update({ breadcrumbs: [{ title: "Files", href: "/app/files" }, ...folders, { title: folder.name }] });

export const renameNote = (note: { title: string }) => layout.update({ title: note.title });

export const goUpInPlace = (openFolder: (href: string) => Promise<void>): (() => void) =>
  layout.handleUp((href) => {
    if (new URL(href, location.origin).pathname !== "/app/files") return false;
    void openFolder(href);
    return true;
  });
