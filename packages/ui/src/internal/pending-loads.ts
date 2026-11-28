/**
 * The library's own loads still running, such as the prompt fields a focus preloads. A chunk needs its window while it
 * runs, so a test harness that removes its DOM awaits them first (`packages/ui/test/dom.ts`): a chunk that ran
 * without a window stays broken for the rest of the process. Only a harness creates the registry; a page has none,
 * and there a load is not tracked. The key is global, so the source and the built package share one registry.
 */
export const pendingLoadsKey = Symbol.for("@k2b/ui.pending-loads");

export const trackLoad = <T>(load: Promise<T>): Promise<T> => {
  const pending = Reflect.get(globalThis, pendingLoadsKey);
  if (pending instanceof Set) {
    pending.add(load);
    const done = () => pending.delete(load);
    load.then(done, done);
  }
  return load;
};
