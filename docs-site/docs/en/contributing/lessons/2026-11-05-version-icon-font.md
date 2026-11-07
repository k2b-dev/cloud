### Keep the icon font under a content version

- **What happened:** A warm Cloud app tab downloaded the complete icon font again after HTTP cache eviction.
- **Root cause:** Core rewrote the font URL to a stable filename, which the verified service worker asset catalog correctly excluded.
- **Error class:** Mutable asset addresses prevent verified static cache reuse.
- **Guard:** `tabler-assets.test.ts` builds the real font assets, checks the CSS URL against the complete font's SHA-256, and requires the same bytes and digest in the platform catalog. `static-assets.test.ts` checks immutable font responses, and `tabler-font.browser.test.ts` checks reserved icon geometry with the actual versioned font.
