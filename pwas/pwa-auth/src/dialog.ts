import { type DialogRender, dialogCore, type OpenDialogOptions } from "@k2b/ui";

const entries: { id: number; close: () => void }[] = [];
let nextId = 0;
let returning: Promise<void> | undefined;

/** Dialogs add a same-URL history entry; Back dismisses them without losing the app. */
export async function openDialog<T>(view: DialogRender<T>, options?: OpenDialogOptions): Promise<T | undefined> {
  await returning;
  const id = ++nextId;
  const entry = { id, close: () => dialogCore.close() };
  const previousState = { ...history.state };
  // Reload/Forward does not resurrect a modal or its sensitive transient state.
  if (entries.length === 0 && previousState.cloudLoginDialog !== undefined) {
    delete previousState.cloudLoginDialog;
    history.replaceState(previousState, "");
  }
  history.pushState({ ...previousState, cloudLoginDialog: id }, "");
  entries.push(entry);
  const pop = () => {
    const target = history.state?.cloudLoginDialog;
    while (entries.length && entries.at(-1)?.id !== target) entries.pop()?.close();
  };
  window.addEventListener("popstate", pop);
  try {
    return await dialogCore.open(view, options);
  } finally {
    window.removeEventListener("popstate", pop);
    const index = entries.indexOf(entry);
    if (index !== -1) entries.splice(index, 1);
    if (history.state?.cloudLoginDialog === id) {
      // Wait for our synthetic Back before another dialog can push a new entry.
      returning = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        history.back();
      });
      await returning;
      returning = undefined;
    }
  }
}

/** Remove sensitive modal content synchronously when the app locks. */
export function closeDialogs() {
  for (const entry of [...entries].reverse()) entry.close();
}
