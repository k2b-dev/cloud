import { toast } from "@k2b/ui";
import { assistantMessages } from "./messages";

/**
 * An action whose module loads on first use, so it stays out of the workspace bundle. One run at a time: a second
 * press while the module loads or its dialog is open does nothing. A module that cannot load says so and offers to
 * reload the page; errors of the action itself stay the action's.
 */
export const lazyAction = <M>(load: () => Promise<M>) => {
  let busy = false;
  return async <R>(locale: string, use: (module: M) => Promise<R> | R): Promise<R | undefined> => {
    if (busy) return undefined;
    busy = true;
    try {
      let module: M;
      try {
        module = await load();
      } catch {
        const t = assistantMessages.resolve([locale]).t;
        toast.error(t.partLoadFailed, { duration: 0, action: { label: t.reloadPage, onClick: () => window.location.reload() } });
        return undefined;
      }
      return await use(module);
    } finally {
      busy = false;
    }
  };
};
