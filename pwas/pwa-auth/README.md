# pwa-auth

A standalone SolidJS PWA shell for approving Cloud sign-ins. This scaffold
currently shows an unconnected preview. Pairing, credentials, and approvals
await the verified Core protocol. It does not contact a Cloud.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
# Build the public UI package after a fresh checkout or UI changes.
bun run --cwd packages/ui build
bun run dev:pwa-auth
```

Open http://127.0.0.1:4178. Reload to rebuild source changes; there is no HMR.
Use `PORT=4179 bun run --cwd pwas/pwa-auth dev` to choose another port.

```sh
bun run --cwd pwas/pwa-auth build
bun run --cwd pwas/pwa-auth typecheck
bun run --cwd pwas/pwa-auth test
```

The build writes a static website to `dist/`. Serve it at the root of its own
stable HTTPS origin. Each future PWA lives beside this package with its own
build and deployment. No Cloud server, session broker or runtime configuration
is required by this shell. Hosting and deployment are separate work.

## UI and language

Use public `@k2b/ui` components, tokens, and system fonts. English and German
messages live in `src/i18n.ts`, using the same `i18n.define()` catalog as Cloud.
The entry resolves the selected language, sets `<html lang>`, and provides it
through `LocaleProvider`. Components read `useLocale()`. The compact settings
dialogs offer System, Deutsch, and English, plus System, Light, and Dark
appearance. System follows browser language and appearance changes. Preferences
persist on this origin through stdlib's `localStore`; no Cloud cookie is used.

The dots button opens the public `Dropdown` with Add Cloud, Language,
Appearance, and Install app. Add Cloud is disabled while pairing is unavailable.
Language and appearance each open a compact shared dialog.

The shell has no simulated approval controls. An installation guide opens once
on the first visit. The origin-local `pwa-auth.install-hint` record remembers
that it has been shown, including dismissal with Escape or the backdrop.
The menu can reopen it at any time. Clearing site data resets this preference.
The automatic introduction never triggers the native installation prompt.
Installation is user-initiated:
a captured `beforeinstallprompt` event opens the browser prompt once. Accepting
it reports a request, not completed installation; `appinstalled` confirms that.
Dismissal permits continued browser use, and prompt failures show manual help.
Without that event, icon-led steps cover Apple Home Screen, Mac Safari Dock,
Android, and a general browser-menu fallback. Detection is guidance only, not
proof of installability. Known embedded-browser signatures show an external
browser handoff. Its copy action uses only the origin and root path, excluding
query strings and fragments. Unknown embedded browsers may receive general
guidance. Standalone mode hides the action and suppresses the introduction.
Confirmed installation closes an open guide. EN/DE text and the selected theme
apply to every dialog; shared UI owns focus, Escape, and the rounded frame.
No service worker, offline approval, or forced update behavior is introduced.
Real iOS/Android installation still needs device verification. Guidance follows
[Apple's Home Screen instructions](https://support.apple.com/en-euro/guide/iphone/iphea86e5236/ios)
and [the browser install-event lifecycle](https://web.dev/articles/customize-install).
Future API integration must use the reviewed public
browser contracts from `@valentinkolb/cloud`; the shell has no unused Cloud
runtime dependency.

## Icons

`ti ti-cloud-lock-open` comes from Tabler 3.46.0 (MIT). `public/favicon.svg`
was generated with the repository's Cloud favicon renderer in
`packages/cloud/scripts/app-favicon.ts`, including its light/dark gradient.
`public/icons/app-icon.svg` contains the same mark on a fixed light background
with inset space for Home Screen masks. Keep the Tabler license with the icons.

Regenerate the checked-in PNGs with librsvg:

```sh
rsvg-convert -w 192 -h 192 public/icons/app-icon.svg -o public/icons/icon-192.png
rsvg-convert -w 512 -h 512 public/icons/app-icon.svg -o public/icons/icon-512.png
rsvg-convert -w 180 -h 180 public/icons/app-icon.svg -o public/icons/apple-touch-icon.png
```
