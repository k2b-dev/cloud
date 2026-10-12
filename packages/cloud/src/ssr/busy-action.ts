import { createSignal } from "solid-js";

/** Keep the trigger focused and ignore repeated clicks while its code loads. */
export function createBusyAction() {
  const [busy, setBusy] = createSignal(false);
  return {
    busy,
    async run<T>(load: () => Promise<T | undefined>, open: (loaded: T) => void) {
      if (busy()) return;
      setBusy(true);
      try {
        const loaded = await load();
        if (loaded !== undefined) open(loaded);
      } finally {
        setBusy(false);
      }
    },
  };
}
