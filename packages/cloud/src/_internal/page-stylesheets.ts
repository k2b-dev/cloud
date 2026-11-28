import { versionedPublicHref } from "./static-assets";

/**
 * The stylesheets a page links, in cascade order: fonts and icons, the app's own sheet, then Core's shared sheet. A page
 * built only with `@k2b/ui/v2` and no Cloud shell (`MinimalLayout ui="v2"`, `page.stylesheets = "v2"`) links Core's
 * `v2.css` in place of `global.css`: v2 and Cloud's v2 additions, without v1 and the shell. Every other page is
 * unchanged.
 */
export const pageStylesheetLinks = (input: {
  appStylesheet: string;
  appVersion: string | undefined;
  sharedVersion: string | undefined;
  stylesheets?: "v2";
}): string =>
  [
    versionedPublicHref("/public/fonts.css", input.sharedVersion),
    versionedPublicHref("/public/tabler-icons.css", input.sharedVersion),
    versionedPublicHref(input.appStylesheet, input.appVersion),
    versionedPublicHref(input.stylesheets === "v2" ? "/public/v2.css" : "/public/global.css", input.sharedVersion),
  ]
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");

/**
 * The sheets a page gets: `v2` only when the registered Core declares `/public/v2.css`. An application on a newer
 * `@k2b/cloud` beside an older Core (a rolling update) keeps that Core's `global.css`, so the page never links a sheet
 * nobody serves. That sheet has neither the v2 frame of a visitor page nor its v2 footer, so the layouts ask the same
 * question and fall back: `MinimalLayout` to the v1 footer with its frame inline, `PwaLayout` to the v1 frame.
 */
export const servedStylesheets = (requested: "v2" | undefined, coreRoutes: readonly string[]): "v2" | undefined =>
  requested === "v2" && coreRoutes.includes("/public/v2.css") ? "v2" : undefined;

/**
 * The body of a page on Core's v2.css alone is the v2 scope too: its surface and colour scheme come from the v2 tokens,
 * and the browser paints the body's background over the whole canvas (overscroll included). Other pages keep their body.
 */
export const pageScopeClass = (stylesheets: "v2" | undefined): string => (stylesheets === "v2" ? " k2-ui" : "");
