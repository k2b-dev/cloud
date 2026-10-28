### App colors lost at a dialog portal

- **What happened:** Settings, file chooser, resource picker, and other app dialogs showed the platform blue instead of the app's colors ([#1458](https://github.com/k2b-dev/cloud/issues/1458)).
- **Root cause:** App color properties were set only on `.cloud-app-canvas`, while UI dialogs mount in a portal under the page shell's body, outside that canvas.
- **Error class:** App colors lost at a dialog portal.
- **Guard:** The page shell carries the current app's validated accent scope. `packages/cloud/src/ssr/Layout.render.test.tsx` checks exact body markup, invalid and absent accents, app Help, focus and admin pages, and unchanged minimal pages. `packages/cloud/src/ssr/dialog-app-colors.browser.test.ts` checks inherited settings and row colors, stable category geometry, and local accent overrides in light and dark mode at desktop and phone sizes.
