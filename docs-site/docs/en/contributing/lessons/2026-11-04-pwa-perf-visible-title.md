### Measure the title that the person can see

- **What happened:** Every PWA performance profile timed out on Start.
- **Root cause:** The probe compared textContent, which concatenated the hidden narrow and wide title variants, with one expected title; pages with their own content headings hide the outer shell heading. Chat was also missing from the local application set; the separate manifest HTTP client did not inherit Chromium’s certificate pin, WebKit reported controlled-navigation refusals as page errors; mutation settling retained pending requests from departed documents.
- **Error class:** Browser probes treating hidden DOM text as visible content.
- **Guard:** scripts/perf-baseline/browser.test.ts covers both responsive title variants and visible content headings; model.test.ts fixes the PWA application set including Chat; the isolated harness exercises the browser manifest fetch and waits for the visible arrival title; the existing browser-test refusal classification keeps real page and cross-origin errors visible; host-request regression coverage resets departed requests without dropping a current mutation.
