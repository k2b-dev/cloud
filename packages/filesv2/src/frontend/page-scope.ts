import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { ENTRY_TYPE, entryRefId, FOLDER_TYPE } from "../resource-ref";
import type { WorkspaceSnapshot } from "./workspace-state";

/** The displayed place; refs describe identity and never confer permission. */
export function filesPageScope(snapshot: WorkspaceSnapshot): CloudResourceRef | null {
  if (snapshot.errorCode || snapshot.moved) return null;
  const params = new URL(snapshot.source, "https://files.invalid").searchParams;
  if (["activity", "shares", "favorites", "trash", "recent"].includes(params.get("view") ?? "")) return null;
  const editor = snapshot.editor;
  if (editor) {
    const id = editor.entry.resourceId ?? entryRefId(editor.base.id, editor.entry.path);
    return id ? { type: ENTRY_TYPE, id } : null;
  }
  const directory = snapshot.directory;
  if (!directory || directory.failure) return null;
  const file = params.get("file");
  if (file) {
    const detail = snapshot.detail?.base.id === directory.base.id && snapshot.detail.entry.path === file ? snapshot.detail : null;
    const entry = detail?.entry ?? directory.items.find((entry) => entry.path === file);
    const id = entry?.resourceId ?? detail?.resourceId ?? entryRefId(directory.base.id, file);
    return id ? { type: entry?.directory ? FOLDER_TYPE : ENTRY_TYPE, id } : null;
  }
  const id = directory.resourceId ?? entryRefId(directory.base.id, directory.path);
  return id ? { type: FOLDER_TYPE, id } : null;
}
