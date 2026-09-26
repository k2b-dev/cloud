---
title: Standalone service accounts and agents
navTitle: Service accounts and agents
section: Identity and access
order: 352
description: Give an integration or a coding agent its own principal with an OAuth client or API keys, and grant it access like a user.
tags: [identity, service-accounts, agents, oauth, client-credentials]
updated: 2026-09-26
---

# Standalone service accounts and agents

A standalone service account is a principal of its own: it has a name, it is
not delegated by a user, and it is not bound to one application resource. Grant
it access exactly like a user, through Space membership, Notebook access, or
any other resource grant. A new account starts with nothing.

Every service account has one `kind`:

| Kind | Identity | Grants |
| --- | --- | --- |
| `user_delegated` | A credential acting for one user | The delegated user's live grants |
| `resource_bound` | A machine identity bound to one app resource | Explicit grants, capped to that resource |
| `standalone` | An integration with its own identity | Explicit grants on the account |
| `agent` | A standalone account that surfaces as an agent | Explicit grants on the account |

`agent` changes presentation only: pickers, entity search, and the Accounts app
show a robot icon and the label "Agent" instead of a key. It carries no extra
permission and no different token rules. Use it for coding agents and other
automated workers that people should recognize in assignee lists, activity, and
audit trails.

The request contract does not change. A standalone account authenticates as a
`service_account` actor with `delegatedUser: null`, and its `accessSubject` is
`{ type: "service_account", serviceAccountId }`. Application code that treats
"not user-delegated" as "resource-bound" is wrong: check
`serviceAccount.kind === "resource_bound"` before reading `appId`,
`resourceType`, or `resourceId`. See
[Request identity](/en/docs/identity/authentication).

## Create the account

Administrators create standalone accounts through Core's administrator API:

```http
POST /api/admin/identity/service-accounts
Content-Type: application/json

{"name":"Release agent","kind":"agent"}
```

`kind` defaults to `standalone`; `name` is unique among standalone accounts,
case-insensitively. `GET /api/admin/identity/service-accounts` lists them with
`kind`, `status`, `search`, `page`, and `perPage` filters, and
`GET /api/admin/identity/service-accounts/<id>` reads one. User-delegated and
resource-bound accounts are not part of this list; they stay with their owning
user or application.

## Choose the credential

A standalone account can hold both credential forms at once. Agents always use
the OAuth client; integrations choose.

| Credential | Lifetime | Revocation | Create with |
| --- | --- | --- | --- |
| OAuth client (`client_credentials`) | Access tokens expire after one hour; the secret is long-lived | Disable the account, rotate the secret, or delete the client | `POST /api/oauth/admin/clients` with `serviceAccountId` |
| API key | Static bearer until revoked or expired | Revoke the key or disable the account | `POST /api/admin/identity/service-accounts/<id>/api-keys` |

The OAuth client must be confidential (`isPublic: false`). Its allowed scopes
cap every token; an agent client created by `cld admin agents create` receives
the same scopes as a `cld login` device session:
`openid profile email offline_access read write`. Because the client has no
user, `allowedProfiles`, `accessMode`, and redirect URIs are irrelevant; leave
them empty. `GET /api/oauth/admin/clients?serviceAccountId=<id>` finds the
clients of one account.

Tokens follow the standard [client-credentials flow](/en/docs/identity/oauth#client-credentials-flow).
The access token carries `principal_type: "service_account"`,
`service_account_id`, and `service_account_kind` (`standalone` or `agent`); the
`app_id`, `resource_type`, and `resource_id` claims are `null`.

API keys are minted once; the raw token appears only in the creation response.
Their metadata is listed and revoked like every other service-account key in the
Accounts app and through `cld accounts service-accounts`.

## Revoke centrally

```http
PATCH /api/admin/identity/service-accounts/<id>
Content-Type: application/json

{"status":"disabled"}
```

A disabled account rejects every credential immediately: the token endpoint
answers `invalid_client`, access tokens that were already issued stop resolving
to an actor, and API keys fail authentication. Setting `status` back to
`active` restores them. Rotating an OAuth client secret invalidates the previous
secret at once but leaves already issued access tokens valid until they expire.

Creation, status changes, API-key creation, and OAuth client operations are
recorded as audit events with the administrator as actor and the service
account as target.

## Grant access

Grant a standalone or agent account access like a person: pick it in a
Space or Notebook permission editor, or use the CLI:

```bash
cld spaces access grant "Roadmap" --service-account "Release agent" --permission write
cld notebooks access grant "Product Notes" --service-account "Release agent" --permission read
cld spaces access search-principals "Release agent" --kind service_account
```

The REST API takes the same principal:
`{"principal":{"type":"service_account","serviceAccountId":"<id>"},"permission":"write"}`.

Two limits apply to every request, and the lower one wins:

- the account's grant on the resource, resolved through the same shared
  resolver as for a user (direct grant, authenticated, and public grants);
- the scopes of the credential it presents. A token with only `read` cannot
  write, even with a `write` grant; a token without `read` reaches nothing.

Scopes never add access, and there is no resource binding to widen or narrow.
In Spaces an agent lists the Spaces it was granted, reads and changes items,
claims tasks, reports progress, and comments under its own name. In Notebooks
it lists its notebooks, reads notes, and writes notes with a `write` grant.
Actions that belong to a person stay user-only: creating a Space or Notebook,
managing access and API keys, personal views such as favorites and the Spaces
work overview,
and editing or deleting comments (and, in Notebooks, writing comments).
Resource-bound API keys keep their binding and behave as before.

## Use an agent from the CLI

`cld admin agents` provisions an agent end to end:

```bash
cld admin agents create "Release agent" --profile release-agent --yes
cld admin agents ls --json
cld admin agents rotate-secret "Release agent" --profile release-agent --yes
cld admin agents revoke "Release agent" --yes
```

`create` creates the account with `kind: "agent"`, creates its confidential
OAuth client under the administrator's authority, and writes a local `cld`
profile that holds the client ID and the client secret. The secret is never
printed and never logged; it is stored like a refresh token, in the config file
with owner-only permissions or, with `--fd0`, in fd0. Pass `--server` when the
profile should point at another origin than the administrator's own profile.

A profile with client credentials obtains an access token through the
client-credentials grant on first use, caches it in the profile until shortly
before it expires, and obtains a new one after a `401`. Nothing else changes:
the agent runs the same `cld` commands as a person, under its own identity, and
only sees what it was granted. Read the CLI's `cld admin reference` for the
complete command list.
