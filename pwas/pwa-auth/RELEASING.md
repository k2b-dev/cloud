# Release Cloud Login

Cloud Login is an independent static website image. Publishing an image does
not deploy it or change any Cloud installation. The source package stays private;
release versions come from Git tags, not an npm package version.

## Verify the release commit

Use a reviewed commit that includes the PWA and its workspace dependencies.
Do not include unrelated work from a busy checkout. From the repository root:

```sh
docker build -f pwas/pwa-auth/Dockerfile -t cloud-pwa-auth:verify .
docker run --rm --name cloud-login-verify --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges -p 127.0.0.1:4189:3000 cloud-pwa-auth:verify
# In another terminal:
bun pwas/pwa-auth/scripts/check-http.ts
```

The image build runs a frozen, filtered workspace install, builds the public UI,
checks PWA types, runs PWA and vault tests, and builds the production shell.
The HTTP check verifies the manifest, icons, screenshots, every precached asset,
cache headers, HEAD support and rejection of non-public paths.

Before broad rollout, verify installation, camera access, passkey-provider PRF
support, PIN recovery, two-Cloud pairing and approval on the browsers/devices
being supported. Desktop tests cannot certify Face ID or Android hardware.
The browser scripts in `test/` cover these flows with synthetic credentials;
`test/offline-flow.js` verifies offline startup and waiting updates against its
isolated fixture. Do not deploy test servers.

## Publish

`.github/workflows/pwa-auth.yml` builds and checks the container for relevant
pull requests and manual runs. These runs do not publish. A tag such as
`pwa-auth-v0.1.0` triggers the same checks and then publishes:

```text
ghcr.io/<repository-owner>/cloud-pwa-auth:pwa-auth-v0.1.0
```

The owner is lowercased by the workflow. The image contains `linux/amd64` and
`linux/arm64` variants. The workflow uses the repository's `GITHUB_TOKEN` with
package write permission. The first publication may require the operator to
set the GHCR package visibility or grant the deployment system read access.

After approval, tag the exact verified commit and push that tag. Check the
workflow result and both architectures with `docker buildx imagetools inspect`.
Record the image digest and deploy by digest. Never reuse a release tag.

## Deploy and update

The project deployment origin is `https://cloud-login.pwa.k2b.dev`.
Expose container port 3000 through its HTTPS reverse proxy. `/health` is a
readiness endpoint. Independent deployments can use another stable HTTPS origin.
The container runs as the unprivileged `bun` user and supports a read-only root
filesystem. It needs no volume, Cloud credentials or server-side database.

Preserve response MIME types, `Cache-Control` and `Referrer-Policy` headers.
Do not cache HTML, `sw.js` or the manifest at the proxy. Hashed `/assets/` files
are immutable. Do not inject analytics, scripts or an authentication gateway:
users must be able to open and install the shell before pairing a Cloud.

Route a release coherently; avoid randomly mixing old and new replicas while
an app shell downloads. For CDN/static hosting, upload new hashed assets before
switching HTML and the worker, and retain old hashed assets during rollout.
The service worker precaches the shell and waits until old windows close before
activating an update. A reload alone does not force an update.

Configure the exact HTTPS origin in each Cloud's app sign-in settings; see
[Run Cloud Login](../../docs-site/docs/en/operations/cloud-login.md). Clouds may
have different HTTPS origins and require no PWA-side issuer list. Keep the PWA
origin stable: local vault storage and passkeys belong to it. The built image
contains no fixed hostname and can be promoted without rebuilding.

Retain the prior image digest for operational rollback. Check storage-format
compatibility before reverting application code after users have opened a newer
version. Changing the deployment image does not reset or recover device vaults.

The image build passes `PWA_VERSION` (release tag) and `PWA_REVISION` (source
commit) into the app. **Settings** displays them so reports identify the installed
build. Custom Docker builds can supply these with `--build-arg`; without a
version, the app displays `unreleased`.
