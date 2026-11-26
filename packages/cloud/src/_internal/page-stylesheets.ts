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
