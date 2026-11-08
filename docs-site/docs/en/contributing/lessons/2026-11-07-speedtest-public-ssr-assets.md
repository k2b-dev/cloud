### Ship the public page and its assets as one build

- **What happened:** Extracting a shared UI into a standalone page exposed missing local font CSP permissions and stale fixed-name stylesheets during preview.
- **Root cause:** The new consumer had a separate CSP and asset cache lifecycle from the Cloud application.
- **Error class:** Incomplete consumer integration across SSR, assets and browser policy.
- **Guard:** `public-site.test.ts` boots the production bundle and checks DE/EN SSR, local hashed CSS and island assets, no cookies, and admission enforcement. `SpeedTestFlow.browser.test.ts` exercises the shared measurement UI and stable geometry. CI boots the standalone image and checks both public locales.
