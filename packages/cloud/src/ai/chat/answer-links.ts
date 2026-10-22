/**
 * Root scheme-less Cloud resource links in sanitized Assistant answer HTML.
 * Normalized links stay root-relative under /app/ or /open/ and can never change origin.
 */
export function rootResourceLinks(html: string): string {
  // sanitize-html emits double-quoted attributes with ", <, and > escaped in values.
  return html.replace(/<a\b[^>]*>/g, (tag) => tag.replace(/(\shref=")((?:app|open)\/)/g, "$1/$2"));
}
