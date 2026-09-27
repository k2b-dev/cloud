/**
 * Offline mode for every HTML document Cloud sends to Gotenberg.
 *
 * Chromium in Gotenberg would otherwise run scripts and load every URL the
 * HTML names. The prepended policy allows only inline styles plus local files
 * and data URLs for styles, images, and fonts. Local files are the request's
 * named assets; Gotenberg keeps file access inside the request directory.
 * Removing elements that run code, navigate, embed documents, or open
 * connections is a second layer that does not rely on the policy, which
 * matters for header and footer templates that Chromium renders apart from
 * the document.
 */
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'";
const OFFLINE_HEAD = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

export const offlineHtml = (html: string): string =>
  OFFLINE_HEAD +
  new HTMLRewriter()
    .on("script, meta, base, iframe, frame, frameset, object, embed", {
      element(element) {
        element.remove();
      },
    })
    .on("link", {
      element(element) {
        // The policy limits a stylesheet to named assets and data URLs. Other
        // link types can preload, prefetch, or connect outside of it.
        if (element.getAttribute("rel")?.trim().toLowerCase() !== "stylesheet") element.remove();
      },
    })
    .transform(html);
