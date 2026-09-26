# OAuth CLI

## What OAuth is

OAuth lets external applications use Cloud as an OAuth 2.0 and OpenID Connect provider through registered clients, redirect URLs, scopes, and access rules.

Use `cld oauth clients` to manage OAuth clients for the selected Cloud instance. OAuth client configuration controls which applications may redirect users and which access they can request.

## Inspect clients first

```bash
cld oauth clients list --json
cld oauth clients get <client-id-or-name> --json
```

Use the listed client ID when a name is ambiguous. Inspect redirect URIs, scopes, profiles, and access restrictions before changing a client.

## Create and update

```bash
cld oauth clients create \
  --name "Desktop helper" \
  --public \
  --redirect-uri "https://example.org/callback" \
  --scope openid \
  --scope profile
```

Use `--public` only for a client that cannot keep a secret. Add `--device-grant` to a public client that signs in on machines without a browser (RFC 8628 device codes); `clients update <client> --disable-device-grant` turns it off again. Confidential clients cannot use the device grant. Confidential clients print their secret once at creation or regeneration; store it before continuing. Use `cld oauth clients update <client> --help` to change redirect URIs, allowed scopes, profiles, users, groups, or the linked service account.

## Sensitive changes

```bash
cld oauth clients regenerate-secret <client-id-or-name> --yes
cld oauth clients delete <client-id-or-name> --yes
```

Regenerating a secret invalidates the prior secret. Deleting a client prevents new authorization flows for it. Confirm the client with `clients get` before either action.

## Complete command catalogue

Run `cld oauth clients <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| OAuth clients | `clients list`, `clients get`, `clients create`, `clients update`, `clients delete`, `clients regenerate-secret` |
