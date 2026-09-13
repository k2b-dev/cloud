export type ChartCursorState = { source: symbol; x: number } | null;

/** Share one numeric X value between line charts. Create one instance per group. */
export function createChartCursor(options: { formatX?: (x: number) => string } = {}) {
  let state: ChartCursorState = null;
  const listeners = new Set<(state: ChartCursorState) => void>();
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  return {
    formatX: options.formatX,
    read: () => state,
    subscribe(listener: (state: ChartCursorState) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    move(source: symbol, x: number) {
      if (!Number.isFinite(x) || (state?.source === source && state.x === x)) return;
      state = { source, x };
      notify();
    },
    clear(source: symbol) {
      if (state?.source !== source) return;
      state = null;
      notify();
    },
  };
}
export type ChartCursor = ReturnType<typeof createChartCursor>;
