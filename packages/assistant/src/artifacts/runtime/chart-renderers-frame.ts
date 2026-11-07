import type { RareChartRenderer } from "./chart-renderer-types";

let source = "";
let renderer: RareChartRenderer | undefined;
let loading: Promise<void> | undefined;
let track = (task: Promise<void>) => task;

/** Trusted bundled source, supplied by the composer; never an app-selected URL. */
export function configureChartModule(code: string, pending: (task: Promise<void>) => Promise<void>) {
  source = code;
  track = pending;
}

export const rareChartSvg: RareChartRenderer = (mapped, common) => renderer?.(mapped, common);

/** Parse and execute the separate offline asset once; a failed import can be retried. */
export function loadChartRenderer(): Promise<void> {
  if (renderer) return Promise.resolve();
  loading ??= track(
    (async () => {
      if (!source) throw new Error("The chart module is missing. Reopen the app to reload its assets.");
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try {
        const module = await import(/* @vite-ignore */ url);
        if (typeof module.rareChartSvg !== "function") throw new Error("The chart module did not provide its renderer.");
        renderer = module.rareChartSvg;
      } finally {
        URL.revokeObjectURL(url);
      }
    })(),
  ).catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
