---
title: OAuth clients and flows
navTitle: OAuth
section: Identity and access
order: 355
description: Configure OAuth clients and choose authorization code or client credentials.
tags: [identity, oauth, oidc]
updated: 2026-09-02
---

# OAuth clients and flows

Use authorization code when an integration acts for a person. Use client
credentials when a service acts on one application resource.

Both flows use the platform identity model. Applications receive `actor` and
`accessSubject`; they do not verify OAuth tokens themselves.

Cloud has three client origins:

- `managed`: created and configured by an administrator;
- `first_party`: seeded by Cloud and protected from editing or deletion;
- `dynamic`: untrusted public clients registered automatically through RFC
  7591 and authorized through explicit user consent.

The first-party `cld` command uses Cloud's protected `cloud-cli` registration
for login, refresh, and logout. It does not dynamically register or accept an
alternate OAuth client ID. Dynamic registration is for clients without a prior
relationship with the Cloud instance.

## Authorization-code flow

The flow uses:

```text
GET  /oauth/authorize
POST /oauth/token
```

The authorization request accepts:

| Parameter | Required | Meaning |
| --- | --- | --- |
| `client_id` | Yes | OAuth client ID |
| `redirect_uri` | Yes | Exact registered redirect URI |
| `response_type` | Yes | Must be `code` |
| `scope` | No | Space-separated allowed scopes |
| `resource` | No | Exact allowed RFC 8707 resource audience |
| `state` | No | Client state returned unchanged |
| `nonce` | No | Included in OpenID Connect processing |
| `code_challenge` | Public clients | PKCE challenge |
| `code_challenge_method` | With challenge | Must be `S256` |

Every client that uses PKCE must use `S256`. Public clients must use PKCE;
confidential clients may omit it because they also authenticate at the token
endpoint. Cloud does not accept PKCE `plain`.

Dynamic clients additionally require an explicit `resource` on the same Cloud
origin. Before issuing a code, Cloud shows the resource owner the client name,
callback host, exact resource, and requested scopes. Approval and denial are
single-use and expire after five minutes. Authorization responses include the
issuer identifier so clients can reject mix-up attacks.

Exchange the returned code:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<code>&
redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&
client_id=<client-id>&
code_verifier=<verifier>
```

When the authorization request used `resource`, the token request must repeat
the exact same value. Cloud binds the authorization code and any resulting
refresh-token family to it. This is required by the
[Cloud MCP server](/en/docs/platform/mcp).

Confidential clients can send credentials through HTTP Basic or the form.

The resulting access token resolves to a user actor. `offline_access` can
produce a refresh token.

Refresh tokens rotate on every successful use. A refresh request can reduce
its scopes, but cannot add scopes; the reduced set remains in effect for later
rotations. Resource-bound grants must repeat the exact `resource` on every
refresh. Cloud also rechecks the account, client scopes and audiences, profile
or explicit client access, and client existence before issuing a replacement.
If any check fails, the grant cannot mint another access token.

The OpenID Connect UserInfo endpoint accepts only user access tokens that
contain `openid`, were issued for the requesting client, and still refer to an
active account and registered client. ID tokens and resource-only access tokens
are rejected.

The OpenID Connect `sub` claim is the immutable Cloud user UUID. Human-readable
account names remain available through `uid`; changing a login name does not
change the subject seen by clients.

## Client-credentials flow

The OAuth client must:

- be confidential;
- reference an active resource-bound service account;
- allow every requested scope;
- allow the optional requested resource audience.

Request a token:

```http
POST /oauth/token
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&
scope=read&
resource=https%3A%2F%2Fcloud.example%2Fapi%2Finventory
```

Every `resource` value is an absolute URI without a fragment. When supplied,
the resulting access token is valid only for that exact audience.

The token resolves to a resource-bound service-account actor.

The application must still verify:

- `appId`;
- `resourceType`;
- `resourceId`;
- the service-account access grant;
- the credential scope cap.

OAuth scopes do not grant domain access. See
[Resource authorization](/en/docs/identity/authorization#limit-resource-bound-credentials).

## Configure an OAuth client

OAuth client creation supports:

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Display name, 1–120 characters |
| `description` | None | Description, up to 1,000 characters |
| `redirectUris` | `[]` | Allowed authorization-code callbacks |
| `logoutUri` | None | Optional post-logout URI |
| `scopes` | `openid profile email` | Allowed scopes |
| `audiences` | `cloud` | Allowed token audiences and resource values |
| `serviceAccountId` | `null` | Resource service account for client credentials |
| `allowedProfiles` | `user, guest` | User profiles allowed to authorize |
| `accessMode` | `profiles` | Profile-based or explicit user/group access |
| `allowedUserIds` | `[]` | Users allowed in `specific` mode |
| `allowedGroupIds` | `[]` | Direct or nested group members allowed in `specific` mode |
| `isPublic` | `false` | Public client without a secret |

Supported scopes:

```text
openid profile email groups offline_access read write admin
```

Automatic discovery advertises only the delegated dynamic-client subset:
`openid profile email offline_access read write`. The privacy-sensitive
`groups` scope and privileged `admin` scope remain available only to explicitly
configured managed or first-party clients.

Scope, audience, redirect, user, and group lists accept at most 50 entries.

`serviceAccountId` is valid only for an active resource-bound service account.
Clients with a service-account binding must be confidential.

## Register a dynamic public client

OAuth clients that do not have a prior relationship with the Cloud instance
can discover `registration_endpoint` in the OpenID configuration and send RFC
7591 metadata to:

```text
POST /oauth/register
```

Cloud accepts authorization-code public clients only. A request must use JSON,
contain one to ten exact callback URIs, use `token_endpoint_auth_method: none`,
and request only `authorization_code` and optional `refresh_token` grants.
Callbacks must use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `::1`; user
information, fragments, and embedded credentials are rejected. Optional
`application_type` values are `native` and `web`.

Dynamic registration does not grant access. The later authorization request
must use PKCE `S256`, an explicit same-origin resource, allowed scopes, and
browser consent. Access tokens stay bound to that exact audience. Administrators
can identify and revoke dynamic clients from **Admin → OAuth**; revocation also
invalidates existing access and refresh tokens. Abandoned dynamic registrations
that never start authorization are cleaned up automatically.

When registration includes `scope`, Cloud registers exactly that allowed
subset. When it omits `scope`, Cloud uses the advertised delegated default:
`openid profile email offline_access read write`.

## Restrict authorization

`allowedProfiles` rejects account profiles outside the configured list.

With `accessMode: "profiles"`, every allowed profile may authorize. With
`accessMode: "specific"`, the user must also be listed directly or belong to an
allowed group. Nested group membership is included.

These client restrictions decide who may authorize the OAuth client. They do
not replace application resource permissions.

Client creation, updates, secret rotation, and revocation are atomic and
recorded in the Cloud audit log. Expired codes and refresh grants are removed
by the OAuth app's background cleanup.

The admin API and **Admin → OAuth** page list clients in bounded pages and can
search by name, client ID, or description. API callers use `page`, `per_page`
(maximum 100), and optional `search` query parameters.

## Validate access tokens

Applications do not import `oauthTokens` or verify JWTs. Apply
`auth.requireRole("authenticated")`, then read `actor` and `accessSubject` from
the request context.

Access tokens expire after one hour. A signing key rotates on its next use
after 30 days; JWKS publishes the retired public key for a two-hour grace period so
tokens issued before a rotation remain verifiable. Revoking a refresh grant or
signing out an OAuth client prevents future refreshes but does not revoke an
already issued access token. That token can remain valid until its one-hour
expiry. Current-client validation and domain authorization still apply on each
request.

The OAuth application still owns the public protocol, clients, consent,
authorization codes, refresh families, discovery, and token response. It does
not hold a platform signing private key. After it validates the grant, it asks
Core's closed OAuth authority to construct and sign the permitted access and ID
token shapes. Core reloads the current client and principal before signing.
The OAuth workload credential is bound to the `oauth` application and the
`identity:oauth-issue` scope; it is not user authority and cannot submit an
arbitrary JWT claim set.

Create that credential once through
`POST /api/admin/identity/workloads/oauth/credentials` with
`{"name":"OAuth Core issuance","scopes":["identity:oauth-issue"]}`. Put the
one-time returned token in the OAuth app's `CLOUD_APP_CREDENTIAL`; do not give
it to Core, another app, or a browser.

During a rolling migration, `CLOUD_OAUTH_ISSUANCE_MODE=legacy` keeps signing
with the existing `oauth.keys` key while all verifiers gain dual-read support.
After the Core authority and OAuth workload credential are deployed, set the
mode to `core`. During OAuth setup, the application first calls Core's closed
readiness endpoint with its workload credential. Core confirms that the exact
workload binding and an active OAuth signer are available. Only then does OAuth
atomically record the one-way cutover in PostgreSQL and erase legacy private
key material. A failed readiness check leaves both the database mode and the
legacy key unchanged. Once cut over, the shared database state prevents another
updated OAuth replica from resuming legacy issuance even if its local setting
still says `legacy`.

Existing client IDs, secrets, routes, claims, issuer, audiences, one-hour
access-token lifetime, authorization codes, and refresh families remain
unchanged. Authorization-code, refresh, and client-credentials exchanges use
one-shot internal grant reservations; arbitrary claims or client assertions do
not cross the authority boundary. A definitive Core grant rejection remains a
public `invalid_grant` response. An unknown transport or server outcome remains
`server_error` and is not retried automatically. Verifiers continue accepting
an already issued legacy token for the existing two-hour public-key grace. A
`kid` present in Core's authority never falls back to a same-named legacy key
when the Core key is revoked or expired.

After a Core authority error during refresh, OAuth atomically checks the exact
reservation nonce, status, and issuance marker. Only a reservation proven not
to have issued tokens is released for a later client retry. If Core already
claimed issuance, or the database cannot prove a safe release, the refresh
family stays fail-closed. A temporary Core outage therefore does not by itself
destroy a provably unused refresh grant.

The audience migration installs its old-writer compatibility trigger and
backfills snapshots in one transaction. Older OAuth replicas that omit the
snapshot still capture the exact resource or current client audiences; newer
writers supply it directly without that extra client lookup. Keep the trigger
until every old writer is retired. Before enabling Core issuance, also replace
every binary that predates the database issuance gate. See
[Runtime configuration](/en/docs/operations/runtime-configuration).

Continue with [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).
