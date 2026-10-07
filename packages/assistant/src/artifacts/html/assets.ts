import { env } from "@k2b/cloud/config";

export type AppFrameAssets = {
  /** Prelude script text, embedded in every app document. */
  prelude: string;
  /** CSP source that pins exactly this prelude. */
  preludeHash: string;
  /** @k2b/ui base stylesheet with Plex as data URLs; also the stylesheet of cloud.pdf.render. */
  baseCss: string;
};

let assets: Promise<AppFrameAssets> | undefined;
/** Production reads the files that build-extras wrote next to the server bundle; development builds them once. */
export function appFrameAssets(): Promise<AppFrameAssets> {
  assets ??= (async () => {
    const [prelude, baseCss] =
      env.NODE_ENV === "production"
        ? await Promise.all([
            Bun.file(new URL("./assistant-app-prelude.js", import.meta.url)).text(),
            Bun.file(new URL("./assistant-app-base.css", import.meta.url)).text(),
          ])
        : await import("./build-assets").then(({ buildPrelude, buildBaseCss }) => Promise.all([buildPrelude(), buildBaseCss()]));
    return { prelude, preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`, baseCss };
  })().catch((error) => {
    assets = undefined;
    throw error;
  });
  return assets;
}
