import { createSignal } from "solid-js";

/** Keep the trigger focused and ignore repeated clicks while its code loads. */
export function createBusyAction() {
  const [busy, setBusy] = createSignal(false);
  return {
    busy,
    async run<T>(load: () => Promise<T | undefined>, open: (loaded: T) => void | Promise<void>) {
      if (busy()) return;
      setBusy(true);
      try {
        const loaded = await load();
        // An opener that still loads its own code keeps the trigger busy until what it opens shows.
        if (loaded !== undefined) await open(loaded);
      } finally {
        setBusy(false);
      }
    },
  };
}
