### Opening a paused Code page showed raw JSON

- **What happened:** A person who opened the page of a paused or removed automation in the browser saw
  `{"code":"code_route_not_found"}` instead of a page: no words in their language and no way out.
- **Root cause:** Code hosting (`packages/core/src/code/hosting.ts`) answered every refusal and failure with the stable
  JSON code, also for a browser navigation. The codes are the contract for scripts and the page's own island; only the
  sign-in redirect looked at whether a person had opened the page.
- **Error class:** A raw machine error instead of a page on a navigation.
- **Guard:** Hosting renders the Cloud's error page (`ssr.error`) for every refusal or failure of a navigation
  (`isCodePageNavigation`: GET, `Accept: text/html`, not the island's tree request), the same page for missing, paused
  and inaccessible Code. `page.render.test.ts` covers the page in German and English, the try-again variant, and that
  scripts and the island keep the JSON codes.
