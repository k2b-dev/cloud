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
 *
 * Chromium takes the PDF title from the document's first `<title>`. Without
 * one it falls back to the random name Gotenberg gives the uploaded file,
 * which PDF viewers then show. A caller title fills that gap: it goes ahead
 * of the document, so it becomes the first title, unless the document names
 * itself with a non-blank HTML `<title>`. SVG titles label graphics, template
 * content stays inert, and removed elements take their titles with them, so
 * none of them count. A title of only whitespace character references, such
 * as `&#32;`, still counts and leaves the random name; generated HTML does not
 * write whitespace that way.
 */
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'";
const OFFLINE_META = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

/**
 * The caller's doctype when it leads the document after whitespace, comments,
 * and an XML declaration. Repeating it ahead of the policy keeps the caller's
 * rendering mode: HTML without a doctype still renders in quirks mode. Comments
 * end where HTML ends them, including `<!-->` and `<!--->`; `<?…>` ends at the
 * first `>`. A single forward scan keeps the time linear in the input size.
 */
const leadingDoctype = (html: string): string => {
  let at = 0;
  for (;;) {
    while (/\s/.test(html.charAt(at))) at += 1;
    if (html.startsWith("<!--", at)) {
      if (html.startsWith(">", at + 4)) at += 5;
      else if (html.startsWith("->", at + 4)) at += 6;
      else {
        const dashes = html.indexOf("-->", at + 4);
        const bang = html.indexOf("--!>", at + 4);
        if (dashes < 0 && bang < 0) return "";
        at = dashes >= 0 && (bang < 0 || dashes < bang) ? dashes + 3 : bang + 4;
      }
    } else if (html.startsWith("<?", at)) {
      const end = html.indexOf(">", at + 2);
      if (end < 0) return "";
      at = end + 1;
    } else {
      if (html.slice(at, at + 9).toLowerCase() !== "<!doctype") return "";
      const end = html.indexOf(">", at + 9);
      return end < 0 ? "" : html.slice(at, end + 1);
    }
  }
};

/** An empty comment stands in for a removed element, so the text on either side stays separate. */
const REMOVED = "<!---->";

// Chromium parses noscript content as markup when JavaScript is disabled.
// math, foreignObject, and desc: see the module comment.
const REMOVED_ELEMENTS = [
  "script",
  "noscript",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "math",
  "foreignObject",
  "desc",
];
const INERT_TITLES = ["svg", "template", ...REMOVED_ELEMENTS].map((element) => `${element} title`).join(", ");

const escapeTitle = (title: string): string => title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const offlineHtml = (html: string, title?: string): string => {
  // Only the text of the first HTML title element names the document.
  let current: { inert: boolean } | undefined;
  let firstSeen = false;
  let named = false;
  const offline = new HTMLRewriter()
    .on("title", {
      element() {
        if (current && !current.inert) firstSeen = true;
        current = { inert: false };
      },
      text(chunk) {
        if (!firstSeen && !current?.inert && chunk.text.trim()) named = true;
      },
    })
    // Runs after the title handler for the same element, in registration order.
    .on(INERT_TITLES, {
      element() {
        if (current) current.inert = true;
      },
    })
    .on(REMOVED_ELEMENTS.join(", "), {
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
  const fallbackTitle = title?.trim() && !named ? `<title>${escapeTitle(title.trim())}</title>` : "";
  return leadingDoctype(html) + OFFLINE_META + fallbackTitle + offline;
};
