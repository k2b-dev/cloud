# Cloud Login (`pwa-auth`)

A standalone SolidJS authenticator for approving sign-ins to multiple Clouds.
Each pairing has its own non-extractable device key. Crypto, discovery, and
API calls use only `appApproval` from
`@valentinkolb/cloud/browser/app-approval`.

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
is required. Hosting and deployment are separate work.
Each Cloud must explicitly enable app approval and trust this exact PWA origin.
See the [protocol guide](../../docs-site/docs/en/operations/app-approval.md).
Serve HTML with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`;
keep assets and scripts on this origin. Do not add analytics or remote scripts.

## UI and language

Use public `@k2b/ui` components, tokens, and system fonts. English and German
messages live in `src/i18n.ts`, using the same `i18n.define()` catalog as Cloud.
The entry resolves the selected language, sets `<html lang>`, and provides it
through `LocaleProvider`. Components read `useLocale()`. The compact settings
dialogs offer System, Deutsch, and English, plus System, Light, and Dark
appearance. System follows browser language and appearance changes. Preferences
persist on this origin through stdlib's `localStore`; no Cloud cookie is used.

The dots button opens the public `Dropdown` with Add Cloud, Language,
Appearance, and Install app. Add Cloud opens the pairing flow.
Language and appearance each open a compact shared dialog.

An installation guide opens once
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
A pairing link takes priority over the first-visit installation guide.

## Pair and approve

1. On your own Cloud profile page, open **Security → Devices**, start pairing
   and copy the complete link. In Cloud Login, choose **Add Cloud** and paste it.
   Alternatively, choose **Scan QR code** to use the camera inside Cloud Login,
   scan with the phone's camera, or open the same link on the same device.
   The in-app camera asks for permission only after you choose to scan.
2. Check the exact Cloud address before choosing **Trust Cloud and pair**.
   Choose a local account label and a device name. The local label distinguishes
   bindings; it is not an account identity attested by the server.
3. Compare the code in both windows. Confirm in the initiating Cloud session,
   check **Both codes match**, then choose **Finish pairing** here.
4. Open an incoming sign-in request, compare its code with the waiting browser
   and explicitly approve or deny. Opening Cloud Login never approves a sign-in.

Keys are structured-cloned into IndexedDB before claiming. A retained enrollment
record contains the original key and comparison, never the pairing secret.
After reload, paste the original link again before its five-minute expiry.
After completion, only the issuer/device binding remains. If the link expires
or the original key is lost, start fresh and revoke any old confirmed device.
Do not assume that Safari tabs, Home Screen apps and embedded browsers share
storage; perform pairing in the browser/app in which you will approve logins.

Requests refresh only while visible and online. Each binding fails independently.
Polling respects the SDK/server interval, uses bounded backoff, and coordinates
across tabs with IndexedDB reservations. Decisions reserve the request before
sending so lost replies, reloads, and other tabs cannot silently resend it.
Check the waiting browser and start a new sign-in after an uncertain result.

**Disconnect Cloud** can revoke the device remotely or explicitly remove it
locally. Local removal does not revoke it in Cloud; existing browser sessions
also require separate revocation. Deleted browser data has no key recovery or
backup: use another supported sign-in method, revoke, and pair again.

## QR camera

**Scan QR code** opens a rear-camera preview where available. Stop it at any
point to return to the paste field. Denied permission, an unavailable camera,
or an invalid code shows help and keeps pasting available. Decoding a code only
opens issuer consent; it neither connects to a Cloud nor claims a pairing.
An invalid or expired QR link shows an error toast and briefly turns the scan markers red.
The camera stays open for another code; repeated frames of the same rejected code
do not produce more toasts. A different code or a one-second gap without a decoded
QR code enables fresh feedback.

`qr-scanner` and its fallback worker are bundled locally and loaded on demand.
Camera frames stay on the device. Closing the dialog, stopping, successful
scanning, hiding the page or leaving it destroys the scanner and stops tracks.
Returning to the page does not reopen the camera automatically. A pending
permission response after closing also releases any stream it returns.
The distribution includes the library's MIT license in `licenses/`.

## Browser verification

`test/server.ts` uses the real Cloud service and HTTP routes with two issuers.
It refuses any database/cache outside the dedicated loopback test endpoints.
Run the existing guarded platform integration suite first to migrate that test
DB and initialize its test signing key. Then start the fixture with the same
`APP_ID=core`, `CLOUD_APP_APPROVAL_TEST=1`, `DATABASE_URL` and `REDIS_URL`:

```sh
bun test packages/cloud/src/services/app-approval.integration.test.ts
bun run pwas/pwa-auth/test/server.ts
```

The database must be `cloud_app_approval_test` on `127.0.0.1:55449`; the isolated
cache must be on `127.0.0.1:56399`. The fixture binds only `43220` and `43221` on
loopback and expects this PWA on port `4178`. Never deploy the fixture.

`test/browser-flow.js` is a Playwright CLI `run-code` function. With both servers
running, execute it in an isolated browser session. It creates and closes its
own context and exercises real pairing, reload recovery, non-exportability,
two-Cloud isolation, decisions, lost-response protection across tabs, independent
failures, foreground polling and revocation. It creates disposable test accounts
when the fixture starts. Tests never enable a live Cloud installation.

`test/qr-flow.js` runs the real worker decoder over a synthetic camera stream
with QR images from `test/fixtures/`. These encode a transport-only pairing with
no backend enrollment and a non-pairing URL. The test checks decoding without
automatic trust, invalid QR input, permission denial, late permission resolution,
stop, page hiding and page exit. It never opens a physical camera.

Physical camera scanning, installed iOS/Safari and Android same-device handoff still
need device acceptance. Desktop browser tests do not establish those guarantees.

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
