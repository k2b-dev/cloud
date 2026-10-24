---
title: Run Studio apps with a machine identity
navTitle: Studio machine execution
section: Identity and access
order: 650
description: Grant an agent or service account explicit Studio execution and effect rights.
tags: [identity, studio, service-accounts, authorization]
updated: 2026-10-23
---

# Run Studio apps with a machine identity

An agent or standalone service account can execute a published Studio app
without a human conversation or an open browser. The caller keeps its own
identity. Its creator's permissions, personal data, secrets and remembered
approvals do not apply.

## Grant access and execution

1. Create an [agent or service account](/en/docs/identity/service-accounts)
   and a credential with the required scope.
2. Open the Studio app's permissions and add that named account.
3. Under **Machine execution**, enable **Execute published code** and choose
   each required data or effect right. Save the rights.
4. Publish the app and call its execution endpoint with that published version.

A direct app grant is required. Access through a linked Project, all signed-in
accounts or a public link does not authorize machine execution. Resource-bound
accounts also remain confined to their exact `assistant` / `artifact` binding.

| Authority | What it permits |
| --- | --- |
| App **Use** and credential `read` | Read the published source |
| App **Use**, credential `write`, execution enabled | Execute the specified current published version |
| Shared files and keys: **Read** | Read shared KV and files |
| Shared files and keys: **Read and write** | Read, write and delete shared KV/files; save generated downloads there |
| App database: **Read** | Read-only queries and row reads in the app's connected database |
| App database: **Read and write** | Also insert, update and delete rows, subject to the table's own write rules |
| Allowed secret names | Use only those app machine secrets in their configured HTTP headers |
| Allowed HTTP requests | Send requests to each exact HTTPS origin with the listed methods |
| App **Manage**, credential `admin` | Read and edit working source and inspect machine rights |
| **Manage sharing**, app **Manage**, credential `admin` | Change app grants and machine rights |

Credential scopes cap these rights; they never supply a missing grant. A `read`
credential cannot write data or execute code, even when the account has more
rights. Execution does not grant source management or sharing authority.

The database must already be connected and its tables configured by an app
manager. A machine writes rows as `service_account:<account-id>`, including
when a table allows changes only to the caller's own rows.

Managers use a browser session or an OAuth token with `admin` scope to change
machine rights and app machine secrets. The app management grant is still required;
installation administrators can use the existing administrative view.

## Configure machine secrets and HTTP

In the same permissions dialog, add **App machine secrets**. Give each secret
a name, exact HTTPS origin, header and prefix. Values are encrypted and are
never loaded back into the editor. Replacing or removing a secret requires
its current revision.

Grant a machine the secret's name and the HTTP origin/method separately.
For example, `https://api.example.com GET` permits GET requests anywhere on
that origin. Paths and query parameters do not narrow an origin grant.

App code uses the existing runtime interface:

```ts
const response = await cloud.http.fetch("https://api.example.com/report", {
  headers: { authorization: cloud.http.secret("reportApi", { prefix: "Bearer " }) },
});
return await response.json();
```

The explicit origin/method grant authorizes this request. Personal approvals
are never consulted. Existing HTTPS network restrictions, body/response
budgets, deadlines and response secret redaction still apply.

## Call the API

Authenticate with the account's API token or OAuth access token.
The execution route is:

```text
POST /api/assistant/artifacts/machine/:id/execute
```

Send a fresh UUID `requestId`, `createdAt` as the current Unix time in
milliseconds, and the integer `publishedVersion`. To invoke a named app
action, also send `action` and its schema-valid JSON `input`.
Without an action, Studio runs the app's script entry without input.

The response contains `requestId` and `result` with `status`, JSON `output`
and generated file references. Generated files are saved under
`runs/<requestId>/<filename>` in shared app storage and require its write right.
The existing runtime can read shared storage and database rows; personal KV,
chat files, personal secrets and human approval flows are unavailable.

Read the outcome with:

```text
GET /api/assistant/artifacts/machine/:id/runs/:requestId
```

The caller needs current app access and can inspect only its own executions.
Status records contain identities and outcomes, never input bodies or output
payloads. A lost response does not authorize replay: the same admitted
`requestId` will not execute again. Requests older than the existing HTTP
retention window of 1 day are rejected.

Source reads use `GET /:id/source` under the same machine API prefix.
A manager can request `?draft=true` and update working source with
`PUT /:id/source` using the existing artifact update contract.
Sharing uses `POST /:id/grants`, `PUT /:id/grants/:accessId`, and
`PUT /:id/access/:accessId` for execution rights. Rights updates require
`expectedRevision`; a new rights record uses `null`.
Publishing and human conversations retain their separate existing flows.

For an application that continues work after authentication, the public
`isRequestCredentialCurrent(c)` helper from `@k2b/cloud/server` rechecks the
request credential without its initial cache. Pass the same `oauthAudience`
option used at route admission. Recheck resource and effect grants as well;
a current credential alone does not authorize an effect.

The same prefix exposes `POST /:id/storage` for shared JSON operations,
`GET`/`PUT /:id/storage/file?key=…` for binary files (including generated
output references), and `POST /:id/database` for the existing flat row/query
contract. These endpoints independently require their explicit data right and
credential scope; they do not imply execution authority. Their
`X-Studio-Request-Id` response header identifies the operation in the audit trail.

## Stop access and recover failures

Disable execution, remove the direct grant, revoke the credential, or disable
the account to stop new operations. Studio checks current authority at
admission, before effects and while execution continues. Work that waited
also checks again. A changed publication stops execution pinned to the old
version. An already admitted external effect may have completed.

| Code | Recovery |
| --- | --- |
| `ACCESS_DENIED` | Ask a manager to check the direct grant, execution/effect rights, account status and credential scope. |
| `CONFLICT` | Read the current published version or rights revision before making a new request. |
| `STORAGE_FULL` | Free shared storage or ask the operator to adjust its existing budget. |
| `EXECUTION_BUSY` | Retry after another Studio execution finishes. |
| `EXECUTION_ALREADY_ADMITTED` | Read the existing request's status. |
| `EXECUTION_UNKNOWN`, `EXECUTION_TIMEOUT` or `EXECUTION_CANCELLED` | Inspect shared data and external services before deliberately issuing a new request. |

Studio stops the sandbox and closes its host on cancellation, authority loss
or the existing 45-second operation deadline. Execution shares the existing
Studio host budget and retains worker, storage, HTTP and database limits.
