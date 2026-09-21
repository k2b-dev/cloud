import type { FibelPlugin } from "@k2b/fibel";
import { renderFontPreloads } from "../src/font-assets";
import { renderSolidImportMap } from "../src/solid-import-map";

export function cloudSitePlugin(stylesheets: string[] = ["homepage.css"], options: { preloadDisplayFont?: boolean } = {}): FibelPlugin {
  return {
    name: "cloud-site",
    setup(context) {
      const assets = `${context.config.routing.basePath}${context.config.routing.assetsPath}`;
      context.headTags.push(() =>
        [
          renderFontPreloads(assets, options.preloadDisplayFont),
          renderSolidImportMap(assets),
          ...stylesheets.map((stylesheet) => `<link rel="stylesheet" href="${assets}/${stylesheet}">`),
        ].join("\n    "),
      );
    },
  };
}
