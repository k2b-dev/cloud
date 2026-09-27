/**
 * Offline mode for every HTML document Cloud sends to Gotenberg.
 *
 * Chromium in Gotenberg would otherwise run scripts and load every URL the
 * HTML names. The prepended policy allows only inline styles plus local files
 * and data URLs for styles, images, and fonts. Local files are the request's
 * named assets; Gotenberg's default deny list keeps file access inside its
 * working directory under `/tmp`. Removing elements that run code, navigate,
 * embed documents, or open connections is a second layer that does not rely
 * on the policy, which matters for header and footer templates that Chromium
 * renders apart from the document.
 *
 * MathML (`math`) and the SVG elements that hold HTML (`foreignObject`,
 * `desc`) go as well; they have no print use in Cloud documents. SVG shapes,
 * images, `title`, and links stay, so graphics still render.
 */
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'";
const OFFLINE_META = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

/**
 * The caller's doctype when it leads the document after whitespace and
 * comments. Repeating it ahead of the policy keeps the caller's rendering
 * mode: HTML without a doctype still renders in quirks mode.
 */
const leadingDoctype = (html: string): string => {
  let rest = html.trimStart();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->", 4);
    if (end < 0) return "";
    rest = rest.slice(end + 3).trimStart();
  }
  return /^<!doctype[^>]*>/i.exec(rest)?.[0] ?? "";
};

/** An empty comment stands in for a removed element, so the text on either side stays separate. */
const REMOVED = "<!---->";

export const offlineHtml = (html: string): string =>
  leadingDoctype(html) +
  OFFLINE_META +
  new HTMLRewriter()
    // Chromium parses noscript content as markup when JavaScript is disabled.
    // math, foreignObject, and desc: see the module comment.
    .on("script, noscript, meta, base, iframe, frame, frameset, object, embed, math, foreignObject, desc", {
      element(element) {
        element.replace(REMOVED, { html: true });
      },
    })
    .on("link", {
      element(element) {
        // The policy limits a stylesheet to named assets and data URLs. Other
        // link types can preload, prefetch, or connect outside of it.
        if (element.getAttribute("rel")?.trim().toLowerCase() !== "stylesheet") element.replace(REMOVED, { html: true });
      },
    })
    .transform(html);
