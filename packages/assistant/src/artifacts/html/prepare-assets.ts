import { AppFrameAsset, FrameAsset, PreparedChartAssets } from "./asset-schemas";
import type { AppFrameAssets } from "./assets";
import type { ChartParts } from "./chart-parts";

const assets = new Map<string, Promise<AppFrameAssets>>();
const charts = new Map<string, Promise<ChartParts>>();

async function json(url: string, priority: RequestPriority = "auto"): Promise<unknown> {
  const response = await fetch(url, { priority });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function chartParts(base: string): Promise<ChartParts> {
  let pending = charts.get(base);
  if (!pending) {
    pending = json(`${base}/chart-parts`, "low")
      .then((value) => PreparedChartAssets.parse(value).chartParts)
      .catch((error) => {
        charts.delete(base);
        throw error;
      });
    charts.set(base, pending);
  }
  return pending;
}

/** A start joins preparation before mounting, preserving cold offline first use. */
export function loadAppAssets(base: string): Promise<AppFrameAssets> {
  let pending = assets.get(base);
  if (!pending) {
    pending = Promise.all([json(`${base}/app-assets?charts=separate`).then((value) => FrameAsset.parse(value)), chartParts(base)])
      .then(async ([frame, chartParts]) => {
        const hashes = frame.chartHashes;
        if (
          hashes.shared === chartParts.shared.hash &&
          Object.keys(hashes.kinds).length === Object.keys(chartParts.kinds).length &&
          Object.entries(hashes.kinds).every(([kind, hash]) => chartParts.kinds[kind]?.hash === hash)
        )
          return { prelude: frame.prelude, preludeHash: frame.preludeHash, baseCss: frame.baseCss, chartParts };
        // A deployment between idle preparation and Start must not mix builds.
        const current = AppFrameAsset.parse(await json(`${base}/app-assets`));
        charts.set(base, Promise.resolve(current.chartParts));
        return current;
      })
      .catch((error) => {
        assets.delete(base);
        throw error;
      });
    assets.set(base, pending);
  }
  return pending;
}

/** Schedule after the host's first paint. Does not start an app or fetch its frame assets. */
export function scheduleChartPreparation(base: string): () => void {
  if (charts.has(base)) return () => {};
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prepare = () => {
    void chartParts(base).catch(() => {
      // Speculation is optional; a real Start retries and reports a failure in its surface.
      console.warn("Chart asset preparation failed. The next app start will retry.");
    });
  };
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(prepare);
      else timer = setTimeout(prepare, 0);
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}
