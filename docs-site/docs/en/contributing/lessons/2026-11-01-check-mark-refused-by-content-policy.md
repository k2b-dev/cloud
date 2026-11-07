### A checked box lost its check under the notes site's content policy

- **What happened:** After #2360, a checked task-list box on the public notes site was a filled violet square without a check. No release contained the defect.
- **Root cause:** The check was a `data:` SVG in `background-image`, and the site sends `img-src 'self' blob:`. `task-marker.browser.test.ts` and the SPA test server sent no policy, and neither looked at the check. The screenshot for #2360 came from the same policy-free harness.
- **Error class:** A shared library depends on what its host's content policy allows, and tests run under a looser policy than production.
- **Guard:** The SPA test server now sends the site's real `contentSecurityPolicy()`. The welcome-note test requires light pixels inside the checked box and no `securitypolicyviolation` event. `base.test.ts` rejects `data:` URLs in `base.css`. The test tolerates only `script-src eval`, from Zod's caught `new Function` probe.
