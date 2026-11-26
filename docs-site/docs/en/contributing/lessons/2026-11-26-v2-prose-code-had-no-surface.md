### v2 Prose showed a code block as plain text in the flow

- **What happened:** Markdown code in v2 `Prose` (the Proxy Auth Traefik example, the JSON of a log entry in gateway-ops) had no surface of its own. The block ran straight into the text around it. It also wrapped long lines like prose, so on a phone a line of JSON broke at any sign.
- **Root cause:** `Prose`'s stylesheet set type, spacing, links and lists, but no rule for `code` and `pre`. The browser's own monospace face was the only difference, and the measure rule `overflow-wrap: anywhere` reached into the block.
- **Error class:** A primitive that renders Markdown styles only the elements its first callers used, and the next Markdown element falls back to the browser's defaults.
- **Guard:** `Prose` sets code in the mono face, gives inline code a light fill, and gives a fenced block its own quiet surface that keeps its lines and scrolls sideways. `packages/ui/src/v2/hydration.browser.test.ts` checks at 390 px that a JSON line wider than the phone stays one line, scrolls inside its framed block and never widens the page. The `content` recipe shows a code block.
