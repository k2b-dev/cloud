/** The framing policy every page gets unless it states its own: only its own origin may frame it. */
export const DEFAULT_FRAME_ANCESTORS = "frame-ancestors 'self'";

// A missing type counts as HTML, because a browser may still render the body as a page.
const HTML_OR_UNTYPED = /^\s*(?:$|text\/html\s*(?:;|$)|application\/xhtml\+xml\s*(?:;|$))/i;
// Directives start a policy or follow `;`; the policies of several header lines arrive joined by `,`.
const FRAME_ANCESTORS_DIRECTIVE = /(?:^|[;,])\s*frame-ancestors(?=[\s;,]|$)/i;

/**
 * Gives an HTML answer the default framing policy: `Content-Security-Policy: frame-ancestors 'self'` and, for browsers
 * without CSP Level 2, `X-Frame-Options: SAMEORIGIN`. An answer that already names `frame-ancestors` or sets
 * `X-Frame-Options` keeps its own decision whole. An existing policy without the directive stays as sent; the default
 * joins it as a separate policy, which browsers enforce together with it.
 */
export const defaultFraming = (headers: Headers): void => {
  if (!HTML_OR_UNTYPED.test(headers.get("Content-Type") ?? "")) return;
  if (headers.has("X-Frame-Options") || FRAME_ANCESTORS_DIRECTIVE.test(headers.get("Content-Security-Policy") ?? "")) return;
  headers.append("Content-Security-Policy", DEFAULT_FRAME_ANCESTORS);
  headers.set("X-Frame-Options", "SAMEORIGIN");
};
