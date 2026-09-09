/** Consume registry invalidations without queuing one snapshot read per event. */
export const watchRegistryChanges = async ({
  signal,
  watch,
  onChange,
}: {
  signal: AbortSignal;
  watch: (signal: AbortSignal) => AsyncIterable<{ type: string }>;
  onChange: () => Promise<void>;
}): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let dirty = false;
  let refresh: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  const invalidate = () => {
    dirty = true;
    if (refresh) return;
    refresh = (async () => {
      while (dirty) {
        dirty = false;
        await onChange();
      }
    })()
      .catch((error: unknown) => {
        failure = { error };
        controller.abort();
      })
      .finally(() => {
        refresh = undefined;
        if (dirty && !failure) invalidate();
      });
  };
  try {
    while (!controller.signal.aborted) {
      for await (const event of watch(controller.signal)) {
        if (controller.signal.aborted) break;
        invalidate();
        // A resync invalidates even when the next watch replays no entries.
        if (event.type === "resync_required") break;
      }
    }
  } finally {
    controller.abort();
    signal.removeEventListener("abort", abort);
    // Finish the current read and any invalidation already received during it.
    while (refresh) await refresh;
    if (failure) throw failure.error;
  }
};
