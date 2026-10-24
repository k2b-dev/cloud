# Standalone visit App-PWA example

Pair a shop iPad from an authenticated employee screen, then scan a visit QR on
the iPad and sign two fictional documents for **Lea Muster, €450**. No customer
Cloud account is created. The example performs no payment and makes no claim
that a signature proves identity or has a particular legal status.

## Prepare the application

Copy this directory into its own repository. It is a standalone consumer,
not a Cloud workspace application, and needs no entry in Cloud's Compose files.
Use Bun and a Cloud installation with the matching App-PWA public API:
`@k2b/cloud/app-pwa` (`createAppPwa`, query/command helpers) and
`@k2b/cloud/app-pwa/browser` (the strict QR parser).

**This source accompanies an unreleased Cloud change.** The manifest currently
uses the checkout's package versions; an older registry package with the same
version does not contain these new exports. Until the release containing
App-PWA is available, install a package archive produced from this change
instead. After that release, pin the matching published Cloud version and
commit your application's lockfile. Do not assume the older registry package
implements this API.

From the copied example directory:

```sh
bun install
# During development of this unreleased API, replace the Cloud dependency:
bun add /absolute/path/to/k2b-cloud-package.tgz
bun run typecheck
```

The operator must connect this service to the Cloud installation's Postgres,
Valkey, NATS JetStream and Core identity services. Core must have completed its
normal migrations and setup first. Use the installation's existing
`DATABASE_URL`, `REDIS_URL`, `NATS_SERVERS`, `SYNC_NAMESPACE`, `SYNC_REPLICAS`
and `APP_SECRET`. Supply secrets through the runtime environment. A separate
browser profile for the iPad avoids carrying employee sessions onto it.

Set Cloud's public URL (`app.url`, bootstrapped from `APP_URL`) to its exact
HTTPS address. The example resolves it with `publicCloudOrigin` and passes it
to the App-PWA service and the browser. HTTP and guessed request origins are
rejected. Set `CLOUD_IDENTITY_JWKS_ORIGIN` only if the deployment already uses a
private Core verification endpoint; no employee credential or cross-app
workload credential belongs in this example.

In `src/config.ts`, set `baseUrl` to the service address reachable from the
Cloud gateway. The example uses `http://visit-demo:3000` on the private network.
Expose the application through that gateway at the configured HTTPS origin.
The employee page is `/app/visit-demo/devices`; the independently installable
page is `/app/visit-demo/counter/`. Do not expose the application listener
publicly.

## Run or build

With the operator's environment supplied:

```sh
bun run dev
```

This uses the preload shipped by `@k2b/cloud` for SSR and the standard app CSS
pipeline. Visit the employee page through the gateway. A direct localhost page
does not satisfy the required HTTPS origin and Secure cookie contract.

For a production bundle:

```sh
bun run build
bun run start
```

Ship the entire `dist/` directory, including `_ssr/manifest.json`, browser
chunks and `public/visit-demo/`. Startup uses `app.start()` and its exclusive
setup lifecycle to create the `visit_demo` schema, seed the fictional customer,
documents and already-paid example payment, and set up the reserved platform
App-PWA tables. A setup failure prevents registration/readiness.

The package build also generates the manifest, icons, worker and neutral
offline page from the `installable` declaration. Installation on Safari uses
the platform's iOS instructions; Chromium offers installation when supported.
Keep the application's schema, including signature rows, under the operator's
normal database backup and retention policy. The example does not implement
scheduled deletion or alter installation-wide policy.

## Try the workflow

1. Sign in with a non-guest Cloud account and open **Laden-iPad koppeln**.
   Enter the device name. Show the pairing QR on the employee screen.
2. On the iPad's app page, choose **QR scannen**. Allow the camera and scan the
   employee's QR. The employee sees **Laden-iPad gekoppelt**, the name, and
   **Widerrufen**. Another pairing can then be started with an editable name.
3. Choose **Besuchs-QR zeigen** for that device and scan it on the iPad.
   Read the contract, sign with ink or a typed name, give consent and explicitly
   save. Read and sign the receipt next. It is offered only because the app's
   fictional payment row is already `paid`.
4. The last signature atomically completes the visit. The iPad shows a neutral
   confirmed completion; customer content is no longer readable. Choose
   **Sitzung beenden** to return to the next customer's flow.

A QR lasts at most two minutes. An expired visit QR offers a new **visit** QR;
it does not start another device pairing. Pairing retry keeps its request ID,
and a response with `qr: null` means the QR has already been claimed. The
employee list loads 20 devices per page and polls only the pages already loaded.

If camera access is denied, enable it in the browser/device settings and choose
**Erneut versuchen**. A foreign or malformed QR stays in the scanner. There is
no pasted URL, code or phone fallback. Directly opened QR fragments are erased
before asynchronous work and are never consumed as navigation.

A network failure hides customer content and leaves a recovery action. After
an uncertain signature save, **Speicherstatus prüfen** reconciles the original
attempt before another signature can be submitted. An uncertain close remains
unconfirmed until the server answers. Reload, hidden pages, Back and BFCache
discard unsaved ink; customer content is fetched again only after validation.

## Reuse the public seams

- `src/platform.ts` configures the closed router and repeats real app access
  checks for every staff action. User and role-setting reads use
  `accounts.users.get({ id: signIn.userId }, { db: tx })` on the supplied
  transaction, so authorization never waits for a second pool connection. The signed-in app policy explicitly exempts
  only the counter surface. Guest HTTP requests enter the closed router before
  application authentication and never fall back to an employee identity.
- `src/domain.ts` owns the visit subject and the customer, payment, document
  revision and signature rows. Old revisions and signatures stay intact. Domain reads and writes use the transaction
  supplied by the platform. Revision checks, signatures, attempt recording and
  visit completion commit together. Closing early revokes the visit in the
  platform transaction. Signature blobs never enter the read model.
- `src/http.ts` bootstraps the browser before use, sends bounded schema-checked
  JSON POST requests to the configured origin with same-origin credentials and
  CSRF, and queries documents using the visit ID from status. Two-second polls
  are reads; only successful explicit commands can renew idle time. Attempts
  remember their original visit ID; reconciliation uses `committed`/`unknown`
  and the platform's explicit `completed` flag, never a stored private result.
- `.island.tsx` entry points receive serializable props. The public SSR and
  browser's first render are the same neutral screen inside `MinimalLayout`.
  `QrScanner` and `SignatureInput` are shared `@k2b/ui` controls.

The example accepts at most 256 KiB of signature JSON. Its request budget adds
JSON's worst-case six-byte character escaping and a fixed envelope; its
response budget covers the fixed document text or one device page. Foreground
HTTP requests have a ten-second recovery deadline. It declares no device-only
Cloud service operation and has no cross-app credential.

## Verification

From the Cloud source checkout, run the focused checks:

```sh
bun test packages/cloud/examples/app-pwa/test/http.test.ts \
  packages/cloud/examples/app-pwa/test/domain.test.ts \
  packages/cloud/examples/app-pwa/test/render.test.ts
bun run --cwd packages/cloud typecheck
bunx --no-install tsc -p packages/cloud/examples/app-pwa/tsconfig.test.json --noEmit
bunx --no-install biome check packages/cloud/examples/app-pwa
```

Browser tests are in `test/Kiosk.browser.test.ts`. They cover customer and
employee flows, retries, pagination, camera denial, synthetic decoded QR
delivery through the shared scanner, stale reads, real reload/history navigation,
simulated BFCache restoration and
light/dark phone and iPad layouts. Run them with the repository's Chromium and
WebKit runners. Synthetic scanning does not verify a real camera.

Run the domain and platform integration suites with the repository's isolated
`CLOUD_TEST_*` infrastructure. Verify the production bundle behind a gateway,
including the generated installation assets. On a physical iPad, also verify
installation, camera resume, touch/Pencil signing and Safari storage separation.
