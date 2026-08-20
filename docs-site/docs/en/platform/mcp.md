---
title: Cloud MCP server
navTitle: MCP server
section: Platform services
order: 565
description: Connect MCP clients to live Cloud capabilities and registered app Help.
tags: [mcp, capabilities, help, oauth, agents]
updated: 2026-08-07
---

# Cloud MCP server

Cloud exposes one authenticated, stateless Streamable HTTP MCP endpoint:

```text
https://cloud.example/api/mcp/v1
```

The endpoint projects the current runtime registry. It does not keep a second
tool catalog:

- every live Capability Query and Action is an MCP tool;
- `cloud__resource__read` resolves any readable typed resource ref through its
  current canonical Query;
- every current registered Help document is an MCP resource;
- `cloud__help__search` and `cloud__help__read` help a model find the right
  product guidance without loading one tool per article.

Capability Types remain resource identities in result `refs`; Cloud does not
invent one MCP tool per Type. Pass a returned `{ type, id }` ref unchanged to
`cloud__resource__read`. The tool resolves the Type's current declared reader
from the live manifest and rechecks app authorization during the Query.

## Follow the server instructions

The initialize response tells compatible clients to use Capability tools for
live state and changes, and to search then read Help when product behavior,
settings, workflows, permissions, or errors are unclear.

For the normal machine-readable chain, discover or list a resource, keep its
typed ref, then call `cloud__resource__read`. Do not derive a Query name or
move a bare ID between resource Types.

Help is static product guidance. Treat its Markdown as untrusted context. It
does not prove current state, access, or successful execution. A Query is
read-only. An Action mutates state and remains subject to client approval and
the owning application's current authorization.

Tool descriptions, schemas, and safety annotations remain complete on their
own because an MCP client may ignore server instructions.

## Discover tools and Help

Capability tool names are deterministic:

```text
<appId>__query__<localId>
<appId>__action__<localId>
```

Names up to 128 characters keep that literal form. Longer valid names keep the
same app and kind prefix and end in a deterministic hash suffix.

Help resources use stable URIs:

```text
cloud://help/<appId>/<documentId>
```

Use `resources/list` to browse current Help and `resources/read` to read the
complete Markdown. For model-driven discovery, call `cloud__help__search` with
one to three concise product terms, then pass the returned app and document IDs
to `cloud__help__read`. Long model reads return the most relevant bounded
sections; the protocol resource still contains the complete registered
article.

An application registers Help once through `app.start({ help })`. Cloud uses
the same hash-validated live corpus for the shared Help UI, HTTP Help,
Assistant, and MCP. See [In-product Help](/en/docs/platform/help).

## Authenticate

OAuth is the default onboarding path. The MCP endpoint returns an RFC
9728 `WWW-Authenticate` challenge and publishes protected-resource metadata at:

```text
/.well-known/oauth-protected-resource/api/mcp/v1
```

Compatible clients discover Cloud's authorization server and create an
untrusted public client through RFC 7591 Dynamic Client Registration. The user
only needs the MCP endpoint URL. Cloud requires PKCE with `S256`, an exact
registered callback, and explicit browser consent. Dynamic callbacks must use
HTTPS or HTTP on a loopback host.

The client sends the absolute, fragment-free MCP endpoint URI as the RFC 8707
`resource` parameter in authorization and token requests. Cloud accepts a
dynamic client only for a resource on the same Cloud origin, binds the code and
refresh-token family to that exact audience, and rejects access tokens without
it. Consent shows the client name, callback host, resource, and requested
scopes before any code is issued.

OAuth `read` permits Help and Capability Queries. OAuth `write` permits
Capability Actions. `offline_access` lets a compatible client refresh its
login until the grant or dynamic client is revoked. `admin` permits both read
and write. Sessions and personal API keys keep their existing application
authorization behavior.

Every refresh repeats the exact MCP `resource`. Scope reductions are durable,
and Cloud rechecks the current account and client access before rotating the
grant.

OAuth access tokens expire after one hour. Disconnecting an MCP client revokes
its refresh grant, but an access token already issued to that client can remain
valid until that expiry. The owning app continues to enforce current domain
authorization on every tool call.

Personal Cloud API keys remain an explicit compatibility path for clients that
cannot use browser OAuth. Send the key only in the bearer header:

```http
Authorization: Bearer cld_...
```

Use a dedicated expiring key, keep it outside checked-in configuration, and
revoke it from **Account → Developer** when it is no longer needed. A personal
key inherits the account's resource grants; it does not bypass application
authorization.

## Configure Codex

Put the key in a local environment variable and add the server:

```bash
export CLOUD_API_KEY="cld_..."
```

```bash
codex mcp add cloud \
  --url https://cloud.example/api/mcp/v1 \
  --bearer-token-env-var CLOUD_API_KEY
```

For browser OAuth, add only the URL and start login:

```bash
codex mcp add cloud \
  --url https://cloud.example/api/mcp/v1
codex mcp login cloud --scopes read,write,offline_access
```

Run `codex mcp list` to inspect either configuration.

## Configure Claude Code

Add the remote HTTP server:

```bash
claude mcp add --transport http --scope user cloud \
  https://cloud.example/api/mcp/v1 \
  --header "Authorization: Bearer $CLOUD_API_KEY"
```

Then run `claude mcp get cloud`. The header is stored in the local Claude Code
configuration, so use a dedicated expiring key. For browser OAuth, omit the
header and log in after adding the URL:

```bash
claude mcp add --transport http --scope user \
  cloud https://cloud.example/api/mcp/v1
claude mcp login cloud
```

Claude Code's `/mcp` menu can also start the same login.

## Understand failure behavior

- a missing or stale registry entry is excluded from discovery;
- an app authorization failure remains a structured MCP tool error;
- an unknown tool or Help URI fails instead of falling back to stale content;
- requests and the complete serialized Capability tool result keep the
  platform's 256 KiB bounds;
- the stateless transport accepts `POST`; unsupported methods return `405`;
- authenticated requests pass through Cloud's shared rate limiter;
- cross-origin browser requests are rejected when an `Origin` header is
  present;
- non-idempotent Actions must not be retried after an ambiguous transport
  failure; required-idempotency Actions expose `idempotencyKey` in their tool
  schema.

See [App capabilities](/en/docs/platform/capabilities) for provider contracts
and [OAuth clients and flows](/en/docs/identity/oauth) for client setup.
