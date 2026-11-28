/**
 * Text that starts the comment carrying an island's props, the wrapper's first child: `<!--ssr-props:{…}-->`.
 * The transform writes it; `mount()` reads it. A comment is invisible to CSS (`:empty`, `:first-child`, `+`) and to
 * `textContent`, so the server markup looks to selectors as it does once the island has rendered.
 */
export const PROPS_COMMENT = "ssr-props:";
