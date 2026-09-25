# Cloud Login

An installable web app for approving sign-ins to multiple Clouds. Pair each
account once, compare the sign-in code, and approve or deny the request.
An optional six-digit app PIN protects all connected accounts on this device.
Choose it before the first pairing or add it later through **App security**.

Deployment address: **[cloud-login.pwa.k2b.dev](https://cloud-login.pwa.k2b.dev)**.
Each Cloud must enable app sign-in and trust this exact origin.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/ui build
bun run dev:pwa-auth
```

Open `http://localhost:4178/`. Reload to rebuild; development does not register
a service worker. Use the same origin in your development Cloud's settings.

## Guides

- [Use and host Cloud Login](../../docs-site/docs/en/operations/cloud-login.md)
- [Development and browser tests](DEVELOPMENT.md)
- [Release process](../../docs-site/docs/en/contributing/release-process.md) and [Run Cloud Login](../../docs-site/docs/en/operations/cloud-login.md)

The app is a standalone website. It uses the public Cloud app-approval SDK and
`@k2b/ui`; no central account server is required. Push notifications are
optional and need Postgres and NATS on the server; see
[Send push notifications](../../docs-site/docs/en/operations/cloud-login.md#send-push-notifications).
