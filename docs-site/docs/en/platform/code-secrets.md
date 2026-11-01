---
title: Code secrets
navTitle: Code secrets
section: Platform services
order: 968
description: Store write-only credentials per Code and approve their HTTP destinations with each version.
tags: [code, secrets, runner, security]
updated: 2026-11-01
---

# Code secrets

Editors can store credentials for one Code without exposing their values to
its source, bundle, runner or run history. A version may use a credential only
at the destination recorded in that version's approved manifest.

## Set, list and delete

The Core capabilities are `core.code.secret.set`, `core.code.secret.list`
and `core.code.secret.delete`. All three require an editor of that Code.
Cloud administration alone gives no access. Set and delete also require a
write-capable credential, and have `code: false`: Code cannot manage its own
credentials. Set accepts only private HTTP input from the editor or CLI;
Assistant, MCP, app tools and background mandates cannot set values. It uses
`idempotency: "none"`, so clients must omit idempotency keys. Reconcile a lost
response by reading metadata before replacing the value again.

Cloud administrators can inspect approved bindings in version-review content;
the editor-only list does not grant them access to current secret metadata.

Editors manage the same secrets on the **Secrets** tab of the
[Code page](/en/docs/platform/code-page) or with
[`cld code secret`](/en/docs/platform/code-cli). All of them reach these
services; none can read a value back.

Set and delete capability calls name `target: { type: "core.code", id: codeId }`;
omit `codeId` from their domain `input`. Flat tools use `code`. The list Query
and internal service schemas keep `codeId`.

Set receives this JSON input through a private editor or CLI input field.
Read the value from stdin; never put it in command arguments or a chat tool:

```json
{
  "name": "API",
  "binding_revision": null,
  "value": "fictional-example-value",
  "binding": {
    "origin": "https://api.example.com:8443",
    "pathPrefix": "/v1",
    "headers": ["authorization"]
  }
}
```

Use `binding_revision: null` for a new name. For an existing name, pass the
revision returned by list or set. A stale revision fails with `CONFLICT`.
Omit `binding` when replacing only the value. Values must be nonempty printable
ASCII header text. The complete input must fit `core.code.payload_bytes`.

Set returns `{ secret }`, containing `name`, `binding_revision`, `origin`,
`pathPrefix`, `headers` and `configured`. List receives `codeId`, optional
`cursor`, and `limit` (1–20, default 20), and returns `{ items, nextCursor }`.
Its items add `valueSetBy` and `valueSetAt`: who last wrote the value and when,
`null` for a value written before Cloud recorded this.
Follow the cursor to read all metadata. Neither operation returns a value or
ciphertext. There is no value-reading operation.

Delete receives `name` and `binding_revision` at the Code target, and returns
`{ deleted: true }`. Its capability uses the shared delete approval, with a
metadata-only review and a required idempotency key. It clears the value for every version immediately.
Metadata remains with `configured: false`, so old approval evidence remains
readable. Set a replacement value to recover. Deleting the Code removes its
values and binding history through the Code's database foreign keys.

Before a value travels, `POST /api/code/authoring/secretCheck` with
`{ codeId, binding }` answers editors `{ version: 1, allowed }`. `allowed` is false for this
installation's own addresses, which set also refuses.

Core exports `codeSecretContracts`, `CodeSecretMetadataSchema`,
`CodeSecretMetadata`, `CodeSecretListItemSchema`, `CodeSecretListItem`,
`setCodeSecret`, `listCodeSecrets`, `checkCodeSecretBinding`,
`currentCodeSecretBindings`, `reviewCodeSecretDeletion` and `deleteCodeSecret`
from `packages/core/src/code/index.ts` for its CLI and editor hosts. These
services take `CodeContext` and enforce the same authority on every surface.

## Bind the destination to a version

`cld code push`, `cld code submit`, Gustav's submit tool and the Code page's
**Secrets** tab select the current binding of every secret that has a value and add
the `internet` policy row. A deleted value stays out of new versions. On the
page, `POST /api/code/authoring/resubmit` with `{ codeId, baseVersionId }`
submits the latest source again against that base and refuses with `CONFLICT`
when a newer version exists.

A caller of `core.code.version.submit` selects bindings itself: copy
the metadata into `manifest.secrets`, omitting `configured`, `valueSetBy` and
`valueSetAt`:

```json
{
  "secrets": [{
    "name": "API",
    "binding_revision": "11111111-1111-4111-8111-111111111111",
    "origin": "https://api.example.com:8443",
    "pathPrefix": "/v1",
    "headers": ["authorization"]
  }],
  "internet": true,
  "policyRows": ["internet"]
}
```

Each entry follows `CodeSecretVersionBindingSchema` from
`@k2b/cloud/contracts`. The submission service verifies that its revision and
complete destination match immutable evidence belonging to this Code. The
manifest hash in `CodeVersionBindingSchema` covers these entries. Version
review includes the complete manifest, and `core.code.version.diff` also
returns `secrets` for the proposed version. A manifest without `secrets`
grants no secret access.

Changing an origin, path or allowed header creates a new `binding_revision`.
Existing versions continue using their original bindings. Submit and approve
a new version to use the changed destination, following the installation's
[Code policy](/en/docs/platform/code-policy). Replacing only the value keeps
the binding revision and takes effect on the next dispatched call, including
calls from older approved versions.

## Use the SDK

```ts
import { app, http, secrets } from "@sdk";

app.schedule("0 8 * * 1", async () => {
  const response = await http.fetch(
    "https://api.example.com:8443/v1/items",
    { headers: { authorization: `Bearer ${secrets.API}` } },
  );
  // response.status, response.headers, response.body (base64 bytes)
});
```

`secrets.API` is the opaque string `[secret:API]`. It never contains the
credential. `http.fetch` accepts a URL and optional `method`, `headers` and
UTF-8 `body`. Its result is `{ status, headers, body }`, with a base64 body so
binary responses survive the JSON bridge. Its checker evidence marks
`internet: true`; the trusted host includes the `internet` policy row when
submitting it.

Core injects values only into header placeholders. It refuses placeholders
in a URL or body, unknown names, unapproved headers, duplicate header names,
control characters and routing, cookie or hop-by-hop headers. Header names in
bindings are lowercase. The request origin includes its effective port;
`https://api.example.com` and `https://api.example.com:8443` differ. `/v1`
matches `/v1` and `/v1/items`, but not `/v10`.

Paths containing `.` or `..` segments, backslashes or percent escapes are
refused before URL normalization. This also refuses encoded and doubly
encoded slashes or traversal. Fragments and URL credentials are refused.
Installation-owned origins, including configured application and redirect
domains, are forbidden even if the application is offline.

## Dispatch without exposing the value

The [Code bridge](/en/docs/platform/code-bridge) checks the current lease,
policy, version approval and mandate before Core decrypts anything. Admission,
value selection and the issuance audit commit before the external request, so
a slow service cannot hold database locks needed by pause, revoke or heartbeats.
A request already issued may finish after a value replacement, delete or pause. A Core
`code.version` mandate needs `apps: ["core"]`, `runtime.http` and a `kind:
"http"` grant; fixed origin, URL and method restrictions still apply.
The version's secret binding narrows this grant further.

Current activation does not yet issue HTTP grants. Activated versions therefore
receive `code_http_forbidden` for HTTP calls until
[declared-origin activation support](https://github.com/k2b-dev/cloud/pull/2349)
is available. Storing values and approving bindings are available independently.

Core sends one request through `requestPublicHttps`, with public-address
validation, pinned DNS, bounded response bytes, the run's remaining deadline,
and cancellation. It follows no redirects and performs no retries. HTTP is
recorded as a possible Action so attempt recovery cannot automatically repeat
an external write.

Call observations retain placeholders. Core redacts raw, prefixed,
JSON-escaped, percent-encoded and base64 credential echoes from response bytes
and selected headers before constructing a response or storing a result.
Failures return stable codes without request, response, crypto or exception
text. A deleted or unreadable value prevents the request.

Choose a trusted external service: it receives the credential and can transform
or disclose it. Echo redaction cannot make an untrusted service safe.

## Include Code in root rotation

Code values use AES-256-GCM under the HKDF purpose
`cloud.code.secret.v1`, derived from the platform's `APP_SECRET` root.
Authenticated row context binds the ciphertext to the exact Code ID and name;
moving it to another row cannot decrypt it. Code has no independent root key.

`purposeSecretCipher` from `@k2b/cloud/services` writes with
`connections().appSecret.current` and can read with `current` or `previous`.
`PurposeSecretRoots` describes explicit roots for a trusted maintenance caller.

Automatic platform root rotation is a later App-identity feature. Core currently
starts from one `APP_SECRET`; it has no previous-root environment setting.
Changing that value alone makes existing encrypted state unreadable. Keep both
roots and coordinate **all** encrypted platform stores before changing it.

For a Code maintenance migration, stop writers and runs through the
installation's maintenance procedure. A trusted Core process can call
`reencryptCodeSecretBatch(input, sql, { current: newRoot, previous: oldRoot })`
without changing its connection snapshot. The root arguments are never request
input. This example is a Bun file at the repository root, run in the operator's
checkout of the deployed release, with dependencies installed and Core's
infrastructure environment prepared; the two root files are private mounts:

```ts
import { initializePlatform } from "@k2b/cloud/start";

await initializePlatform({ appId: "core", source: "env" });
const { sql, redis } = await import("@k2b/cloud");
const { reencryptCodeSecretBatch } = await import("./packages/core/src/code/secrets");
try {
  const roots = {
    current: await Bun.file("/run/secrets/app-secret-new").text(),
    previous: await Bun.file("/run/secrets/app-secret-old").text(),
  };
  let cursor: { codeId: string; name: string } | undefined;
  do {
    const page = await reencryptCodeSecretBatch({ limit: 50, cursor }, sql, roots);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
} finally {
  await sql.close();
  redis.close();
}
```

Each batch locks its rows, re-encrypts with the new root, and returns only a
count and cursor. It does not change binding revisions or manifests. An
unreadable row rolls back the entire batch; retain both roots, restore access
and repeat that batch. Do not resume writers or retire the old root until every
platform store has completed its migration and Core has restarted with the new
root. Keep a recoverable database and root-key backup according to the
installation's recovery policy. Losing both roots makes values unrecoverable.
See [Secrets and persistent state](/en/docs/data/secrets-and-persistent-state).
