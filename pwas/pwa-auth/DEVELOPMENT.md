# Develop and verify Cloud Login

For local startup, see [README](README.md). From the repository root:

```sh
bun run --cwd pwas/pwa-auth typecheck
bun run --cwd pwas/pwa-auth test
bun run --cwd pwas/pwa-auth build
PORT=4189 bun pwas/pwa-auth/scripts/serve.ts
# In another terminal:
bun pwas/pwa-auth/scripts/check-http.ts
```

The production server listens on port 3000 unless `PORT` is set. It requires
only Bun and the built `dist/` directory. Use an isolated origin for production
worker tests so they do not affect development storage.

## UI and language

Use public `@k2b/ui` controls and tokens. English and German messages live in
`src/i18n.ts`, using Cloud's `i18n.define()` pattern and the inherited UI locale.
The menu groups account management, settings, security, and installation.
Pending requests open a bottom sheet; approving always requires an explicit
choice after comparing the code. Language and theme preferences are local.

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

`test/native-flow.js` checks mobile target sizes, Back/Close behavior and theme
initialization while the app module is blocked. Manifest screenshots are real
390×844 captures of the welcome and pairing views plus a 1280×720 desktop view.

To verify a production worker without affecting the dev origin, run a production
build, then `bun run pwas/pwa-auth/test/offline-server.ts`. This loopback-only
fixture serves a private snapshot on `127.0.0.1:4179` and simulates two releases.
Run `test/offline-flow.js` with Playwright CLI. It checks offline startup, a
static-only cache, waiting updates, and activation after old windows close.
Playwright blocks network access separately from its simulated offline indicator.
Stop the fixture after testing; never deploy it.

## Icons

The build extracts literal Tabler names from all emitted JavaScript chunks and
subsets the existing font using `subset-font`. It keeps Tabler's public CSS
classes without shipping the whole icon catalog. Use literal icon names in this
app so they remain discoverable by the build.

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
