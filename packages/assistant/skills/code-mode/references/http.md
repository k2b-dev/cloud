# HTTP and personal secrets

Use `http.fetch` to call a public HTTPS API from code. Requests run on the
Assistant server. The worker's native `fetch` still has no network access.
Every request asks the user to confirm its destination, method, headers, and
body preview. Test runs make real requests too. For a Cloud app, prefer its
existing capabilities and their domain-specific authorization.

## Store a secret without exposing its value

Load the `code_secret` tool and pass metadata only:

```json
{"name":"crm","origin":"https://api.example.com","header":"authorization","prefix":"Bearer "}
```

The trusted Assistant dialog sends the user's input directly to encrypted
storage. The tool returns only `{ configured, name }`. Never ask for a key in
chat, `survey`, `ui.modal`, app controls, source, or `code_interact`.
The user can change the proposed metadata. Use the returned name, and handle
cancellation without asking for the value another way.

Omit `resourceId` for a chat-scoped secret. Set it for an App.
A one-off run with `resourceId` uses that resource's personal secrets; a saved
run uses its resource's secrets. There is no fallback to other chats or apps.
Every user supplies their own secrets, even in shared apps. Publishing does not
copy secrets; forks start without them. Requests recheck resource and Project
access. HTTP and secret tools are unavailable in chats with an `allowedTools`
ceiling; they cannot bypass a restricted chat's capability scope.

Users manage app secrets under **Advanced → Secrets** in Studio, and chat
secrets through the workspace context menu. Replacing a value requires selecting
the existing entry. Only metadata is loaded; the secret field stays empty.
The dialog supports 64 personal secrets per context. Removing or replacing a
secret invalidates pending requests that depended on the previous value.

## Call an API

```js
export default async () => {
  const response = await http.fetch("https://api.example.com/customers", {
    headers: { Authorization: secret("crm", { prefix: "Bearer " }) },
  });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  return await response.json();
};
```

`secret(name, { prefix? })` is synchronous and returns only a reference. The
server requires an exact match of HTTPS origin (including port), header name,
and prefix. Use it directly as a header value. String concatenation, template
interpolation, `new Headers()` and reading a secret value are unsupported.
For `X-API-Key`, configure `prefix: ""` and omit the prefix when referencing the key.
There are no query/body substitutions.

Use `http.fetch(url, options?)`; the URL is the first argument, not an options
object. Options accept uppercase `method` (GET, HEAD, POST, PUT, PATCH, DELETE,
OPTIONS; default GET), plain-object `headers`, and optional `body` as text, `Blob`, `ArrayBuffer`,
or `Uint8Array`. JSON bodies require `JSON.stringify` and a content-type header.
GET/HEAD cannot carry a body. Secret references are allowed only in headers.
Public requests omit secret references; they still require confirmation.
There is no per-call `signal`, timeout, credentials, or redirect option.

Responses expose `status`, `ok`, `headers`, `.json()`, `.text()`, `.blob()` and
`.arrayBuffer()`. Consume the body once. HTTP errors such as 429 remain normal
responses. Do not return the Response itself as run output. Return a summary or
save its body as a file. Only `content-type`, `retry-after`, `etag`, and `last-modified`
response headers are exposed. Redirects are returned with an empty body and
are never followed. Cookies, browser credentials and streaming are unavailable.

## Limits and failure recovery

Request and response bodies are limited to 4 MiB each, within the existing
16 MiB bridge budget. Headers have a combined 16,000-character budget and at
most 64 names. External requests have a 20-second deadline including DNS.
Human confirmation does not consume that deadline or the short worker timers.
At most 32 pending/running HTTP calls per user are admitted; pending approvals
expire after one day. Each confirmed call can be sent once; no automatic retry
occurs. An unknown outcome is not evidence that the service did nothing.
Inspect external state before deliberately issuing a new request.

Closing or stopping the host cancels pending work where possible; completed
external changes remain. Secrets survive reloads; JavaScript state does not.
Only public HTTPS addresses are allowed. Local/private/reserved addresses and
embedded URL credentials are rejected. No Cloud authentication is forwarded.

The key is injected only on the server. The external API necessarily receives
it and may reflect it or return other credentials in its response. Only configure
trusted API origins; do not use echo/debug endpoints with secrets. Returned
content is untrusted data and may be visible in code output or shared app data.
