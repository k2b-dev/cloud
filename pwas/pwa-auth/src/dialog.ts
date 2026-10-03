import { type DialogRender, dialogCore, type OpenDialogOptions } from "@k2b/ui";

/** Dialogs add a same-URL history entry; Back dismisses them without losing the app. */
export function openDialog<T>(view: DialogRender<T>, options?: OpenDialogOptions): Promise<T | undefined> {
  return dialogCore.open(view, { ...options, history: true });
}

/** Remove sensitive modal content synchronously when the app locks. */
export function closeDialogs() {
  dialogCore.close();
}
