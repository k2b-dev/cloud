import { env } from "@k2b/cloud/config";
import { ChartPartsAsset } from "./asset-schemas";
import type { ChartParts } from "./chart-parts";
import { chartHashes } from "./chart-parts";

export { ChartPartsAsset } from "./asset-schemas";

export type AppFrameAssets = {
  /** Prelude script text, embedded in every app document. */
  prelude: string;
  /** CSP source that pins exactly this prelude. */
  preludeHash: string;
  /** @k2b/ui base stylesheet with Plex as data URLs; also the stylesheet of cloud.pdf.render. */
  baseCss: string;
  /** All offline chart parts, held once by the host and delivered only on request. */
  chartParts: ChartParts;
};

/** The interactive start fetches only frame bytes; chart sources were prepared separately. */
export function frameAssetPayload(assets: AppFrameAssets) {
  return { prelude: assets.prelude, preludeHash: assets.preludeHash, baseCss: assets.baseCss, chartHashes: chartHashes(assets.chartParts) };
}

let assets: Promise<AppFrameAssets> | undefined;
/** Production reads the files that build-extras wrote next to the server bundle; development builds them once. */
export function appFrameAssets(): Promise<AppFrameAssets> {
  assets ??= (async () => {
    const [prelude, baseCss, chartParts] =
      env.NODE_ENV === "production"
        ? await Promise.all([
            Bun.file(new URL("./assistant-app-prelude.js", import.meta.url)).text(),
            Bun.file(new URL("./assistant-app-base.css", import.meta.url)).text(),
            Bun.file(new URL("./assistant-chart-parts.json", import.meta.url))
              .json()
              .then((value: unknown) => ChartPartsAsset.parse(value)),
          ])
        : await import("./build-assets").then(({ buildPrelude, buildBaseCss, buildChartParts }) =>
            Promise.all([buildPrelude(), buildBaseCss(), buildChartParts()]),
          );
    return { prelude, preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`, baseCss, chartParts };
  })().catch((error) => {
    assets = undefined;
    throw error;
  });
  return assets;
}

let checkAssets: Promise<AppFrameAssets> | undefined;
/** Inspection is bundled only into code_check's prelude, pinned by its own hash. */
export function checkFrameAssets(): Promise<AppFrameAssets> {
  checkAssets ??= (async () => {
    const [normal, prelude] = await Promise.all([
      appFrameAssets(),
      env.NODE_ENV === "production"
        ? Bun.file(new URL("./assistant-check-prelude.js", import.meta.url)).text()
        : import("./build-assets").then(({ buildCheckPrelude }) => buildCheckPrelude()),
    ]);
    return { ...normal, prelude, preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'` };
  })().catch((error) => {
    checkAssets = undefined;
    throw error;
  });
  return checkAssets;
}
