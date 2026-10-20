---
title: OAuth clients and flows
navTitle: OAuth
section: Identity and access
order: 355
description: Configure OAuth clients and choose authorization code, device authorization, or client credentials.
tags: [identity, oauth, oidc]
updated: 2026-10-19
---

# OAuth clients and flows

Use authorization code when an integration acts for a person. Use the device
authorization grant when that person signs in on a machine without a usable
browser, such as a server reached over SSH. Use client credentials when a
service acts on one application resource.

Both flows use the platform identity model. Applications receive `actor` and
`accessSubject`; they do not verify OAuth tokens themselves.

Cloud has three client origins:

- `managed`: created and configured by an administrator;
- `first_party`: seeded by Cloud and protected from editing or deletion;
- `dynamic`: untrusted public clients registered automatically through RFC
  7591 and authorized through explicit user consent.

The first-party `cld` command uses Cloud's protected `cloud-cli` registration
for login, refresh, and logout. Every browser `cld login` opens a consent page,
even when the person is already signed in. `cld login --device` uses the same
registration through the device authorization grant. `cld login --user`
starts that grant with `login_hint`, and `cld login --ttl` sends `ttl`. `cld`
does not dynamically register or accept an alternate OAuth client ID. Dynamic registration is for clients without a prior
relationship with the Cloud instance.

## Confirm new access

Creating a refresh-token family with `offline_access` requires a browser
sign-in from the last ten minutes. Cloud checks that sign-in inside the
transaction that records the authorization, and Core requires that recorded
confirmation before activating the family. OAuth tokens, API keys, and mobile
app sessions do not count as browser confirmation. Access-token-only grants
and rotation of an existing refresh family keep their existing behavior.

On consent and device pages, an older session asks the person to confirm their
identity first. Denying a request remains available without signing in again.
Managed clients requesting `offline_access` return through
`/auth/login?redirectTo=…`: the return URL keeps the same authorization request
and adds `reauthenticate=1`. After signing in with the same account, the person
returns to that request. This confirmation does not sign out the existing
session. Managed requests without `offline_access` keep their normal flow.

A terminal Cloud Login approval also counts as confirmation when it is consumed
in the issuance transaction and matches this exact device grant: client,
scopes, stored login lifetime, and person. The refresh family cannot outlive
that stored lifetime. A missing confirmation or a mismatched approval returns
`invalid_grant`; clients must start a new sign-in. `cld` says to run `cld login`
again and confirm in the browser.

Each new browser-confirmed refresh family sends a **New access** notice to the
person, with email and browser delivery recommended. It names the command line
for `cloud-cli`, or the application for other clients, and shows the time in
the installation timezone. If the access was not yours, contact your
administrator. The notice links to `/me/security`. Existing families and
refresh rotation do not send this notice. Terminal Cloud Login approval itself
confirms the access; that path does not send this additional notice.

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

The person approves in a web session. The mobile app's session never
authorizes a client: `/oauth/authorize` treats it as no session and leads to
sign-in, and consent decisions from it are refused.

Every page a person sees during an authorization, from code entry and consent
to the result and `/oauth/error`, is a standalone page: one centered card
without the Cloud header, rail, or app navigation, with the language and theme
settings in its footer. On phones the card is flat and uses the full width.

Every client that uses PKCE must use `S256`. Public clients must use PKCE;
confidential clients may omit it because they also authenticate at the token
endpoint. Cloud does not accept PKCE `plain`.

Dynamic clients additionally require an explicit `resource` on the same Cloud
origin. Before issuing a code, Cloud shows the resource owner the client name,
callback host, exact resource, client ID, and requested scopes, with a note that
the client is unverified. Approval and denial are
single-use, bound to the person who opened the request, and expire after five
minutes. A decision whose `Origin` header is not Cloud's own origin, the origin
of the `app.url` setting, ends on `/oauth/error` with `invalid_request`; this
includes `Origin: null`. The consent page sends its address as a referrer only
to Cloud itself, so a browser submits its form with Cloud's origin.
Authorization responses include the issuer identifier so clients can reject
mix-up attacks.

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
produce a refresh token. The exchange accepts the optional `ttl` form
parameter described under [Login lifetime](#login-lifetime).

Refresh tokens rotate on every successful use. Rotation keeps the family's
absolute expiry. A refresh request can reduce its scopes, but cannot add
scopes; the reduced set remains in effect for later rotations. Resource-bound
grants must repeat the exact `resource` on every refresh. Cloud also rechecks
the account, client scopes and audiences, profile or explicit client access,
and client existence before issuing a replacement.
If any check fails, the grant cannot mint another access token.

Authorization codes capture their granted audiences when created. Both the
initial access token and its refresh family keep that snapshot; adding a client
audience later does not widen an existing grant.

The OpenID Connect UserInfo endpoint accepts only user access tokens that
contain `openid`, were issued for the requesting client, and still refer to an
active account and registered client. It applies the same live account-epoch
check as Cloud applications. ID tokens and resource-only access tokens are
rejected.

The OpenID Connect `sub` claim is the immutable Cloud user UUID. Human-readable
account names remain available through `uid`; changing a login name does not
change the subject seen by clients.

The `email` claim is present only when the account has an email address.
Local accounts can exist without one when the operator
[allows it](/en/docs/accounts/registration#allow-local-accounts-without-email);
their ID tokens and UserInfo responses omit `email` even with the `email` scope.
Clients should identify users by `sub`.

## Login lifetime

Authorization-code and device logins have an absolute end. Without `ttl`, the
refresh-token family lasts 90 days, except for
[Cloud Login approval](#approve-in-cloud-login). Access and ID tokens last at
most one hour and never outlive the login.

The Cloud extension `ttl` requests a shorter login lifetime in integer seconds.
Send it on `POST /oauth/token` with `grant_type=authorization_code`, or on
`POST /oauth/device_authorization`, including requests with `login_hint`.
For example, `ttl=600` requests ten minutes.
Use decimal digits only, without a leading zero, from 1 to 15 digits. Zero,
negative values, fractions, and empty values return `invalid_request`.
Sending `ttl` with any other token grant also returns `invalid_request`.
A refresh request cannot set or extend the login lifetime.

Cloud caps `ttl` at the session length setting `user.session.expiry_hours`
(converted to whole seconds) and the 90-day default, whichever is shorter.
For device requests, Cloud stores the capped lifetime when authorization
starts and checks the current cap again when issuing tokens. Lowering the
setting does not shorten logins that already exist. Without `ttl`, this
setting does not change the 90-day OAuth lifetime for requests without
`login_hint`.

Every token response that carries `refresh_token` also includes
`refresh_token_expires_in`: the whole seconds remaining until the family's
absolute expiry. This applies to authorization-code exchanges, approved device
polls, and refreshes. `expires_in` gives the access token's lifetime, which can
be shorter than one hour when the login ends sooner. Rotation never moves the
family expiry.

Both discovery documents, `/.well-known/openid-configuration` and
`/.well-known/oauth-authorization-server`, advertise
`cloud_login_ttl_supported: true`. Clients can check it before sending `ttl`.

`cld login --ttl 8h` checks this marker, sends `ttl`, and prints the end from
`refresh_token_expires_in`.

## Device authorization flow

The device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628))
lets a person approve a sign-in on another device. The client shows a short
code, and the person enters it in a browser where they are already signed in
to Cloud. `cld login --device` uses this flow on headless machines.

The flow uses:

```text
POST /oauth/device_authorization
GET  /oauth/device
POST /oauth/token
```

Only public clients with `allowDeviceGrant` enabled can use it. The first-party
`cloud-cli` client is enabled. Managed public clients must opt in. Dynamic and
confidential clients cannot. Other clients receive `unauthorized_client`.

Start an authorization:

```http
POST /oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=<client-id>&scope=openid%20offline_access%20read
```

```json
{
  "device_code": "<opaque device code>",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://cloud.example/oauth/device",
  "verification_uri_complete": "https://cloud.example/oauth/device?user_code=WDJB-MJHT",
  "expires_in": 600,
  "interval": 5
}
```

The request also accepts the optional `ttl` form parameter described under
[Login lifetime](#login-lifetime). The requested scopes must be allowed for the
client. Without `scope`, Cloud requests `openid`. The user code has eight
characters from an alphabet without `0`, `O`, `1`, and `I`. It is displayed as
`XXXX-XXXX` and accepted without the dash or in lowercase. Both codes expire
after ten minutes. Cloud stores only SHA-256 hashes of both codes.

The person opens the verification URI, enters the code, and sees the client
name, client ID, the code again, the requested scopes, and a warning to approve
only codes they started themselves. Deny and Allow sit side by side, Allow as
the primary action. After a decision the page and its tab title show the
result: the device is connected, or it was not, and the tab can be closed. A
confirmation that expired or was already answered ends on "Request no longer
valid", which asks the person to start the sign-in on the device again and
offers to enter another code. Code entry rejects a code that already expired
with the same message as a mistyped one. The page requires a browser session on
the web. API keys, OAuth access tokens and the mobile app's session cannot
approve a device. The client profile and access rules apply exactly as in the
authorization-code flow. The approve or deny form carries a single-use
confirmation token bound to that person, and cross-origin submissions are
rejected. Cloud records both decisions in the audit log as
`oauth.device.authorize`.

Poll the token endpoint no faster than `interval`:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&
device_code=<device code>&
client_id=<client-id>
```

| Error | Meaning | Client action |
| --- | --- | --- |
| `authorization_pending` | Not yet approved or denied | Poll again after `interval` |
| `slow_down` | Polled within five seconds of the previous poll | Add five seconds to the interval |
| `access_denied` | The person denied the request | Stop |
| `expired_token` | The ten minutes passed | Start again |
| `invalid_grant` | Unknown code, another client's code, already redeemed, or missing grant confirmation | Start a new sign-in and confirm in the browser |

After approval, the next poll returns the same token response as the
authorization-code flow, including a rotating refresh token when
`offline_access` was granted. A device code can mint tokens only once, and
only for the client that started it. Core rechecks at issuance that the client
still allows the grant.

Rate limits:

- `POST /oauth/device_authorization`: 10 requests per minute for each client IP
  address;
- code entry: after 10 wrong or expired codes, further entries from that IP
  address or account are refused until 15 minutes after the first failure;
- polling: one poll every five seconds for each device code; faster polls
  receive `slow_down`.

The OAuth app's background cleanup removes device authorizations one hour after
expiry and immediately after their tokens are issued.

### Approve in Cloud Login

First-party clients can send `login_hint` to request approval in the person's
paired Cloud Login. Today this is available to the Cloud CLI's `cloud-cli`
registration. [Cloud Login approval](/en/docs/operations/app-approval) must be
turned on, and the paired app must support terminal sign-ins.
The account must have accepted the terms once in the browser.
Until then, the request behaves like an unknown account and expires.

```http
POST /oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=cloud-cli&scope=openid%20offline_access%20read&login_hint=alice
```

Use a username or email address. Cloud trims surrounding whitespace and accepts
1–254 characters. Email lookup is case-insensitive.

```json
{
  "device_code": "<opaque device code>",
  "comparison": "012345",
  "expires_in": 300,
  "interval": 5
}
```

The person compares the six digits with Cloud Login, reviews the client,
scopes and login lifetime, then approves or denies. There is no `user_code`
or verification URI: this request cannot be approved by entering a code in
the browser. It expires after five minutes.

Poll `/oauth/token` with the normal device-code grant. The same errors apply:
`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, and
`invalid_grant` on replay or when the account was signed out everywhere after
approval. Unknown, ambiguous and unpaired accounts get the
same start response and remain pending until expiry. No account lookup result
is exposed to the client.

Without `ttl`, the login lasts `user.session.expiry_hours`, up to 90 days.
A shorter `ttl` reduces that lifetime. The lifetime is absolute; refreshing
never extends it. Clients without `login_hint` keep the existing device flow
and 90-day default.

`cld login --user alice` checks `cloud_login_hint_supported`, uses this flow,
and prints the six digits to compare.

Start errors:

| Error | Meaning | Client action |
| --- | --- | --- |
| `invalid_request` | Non-first-party client, malformed hint, or approval turned off | Correct the request or start without `login_hint` |
| `invalid_scope` | Empty, disallowed, or `admin` scopes | Request allowed scopes; use the plain device flow for `admin` |
| HTTP 503 `temporarily_unavailable` | Core cannot accept the request | Try later; operators should update Core before OAuth |

An older Core without the approval route also produces 503. Both discovery
documents advertise `cloud_login_hint_supported: true`; clients should check
this marker before using the extension.

## Client-credentials flow

The OAuth client must:

- be confidential;
- reference an active resource-bound or standalone service account;
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

The token resolves to a service-account actor of the bound account's kind.
`service_account_kind` is `resource_bound`, `standalone`, or `agent`; for the
standalone kinds the `app_id`, `resource_type`, and `resource_id` claims are
`null`. See [Standalone service accounts and agents](/en/docs/identity/service-accounts).

For a resource-bound account the application must still verify:

- `appId`;
- `resourceType`;
- `resourceId`;
- the service-account access grant;
- the credential scope cap.

For a standalone account the application checks the service-account access
grant like any other principal.

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
| `serviceAccountId` | `null` | Resource-bound or standalone service account for client credentials |
| `allowedProfiles` | `user, guest` | User profiles allowed to authorize |
| `accessMode` | `profiles` | Profile-based or explicit user/group access |
| `allowedUserIds` | `[]` | Users allowed in `specific` mode |
| `allowedGroupIds` | `[]` | Direct or nested group members allowed in `specific` mode |
| `isPublic` | `false` | Public client without a secret |
| `allowDeviceGrant` | `false` | Allow the device authorization grant; public clients only |

Supported scopes:

```text
openid profile email groups offline_access read write admin
```

Automatic discovery advertises only the delegated dynamic-client subset:
`openid profile email offline_access read write`. The privacy-sensitive
`groups` scope and privileged `admin` scope remain available only to explicitly
configured managed or first-party clients.

Scope, audience, redirect, user, and group lists accept at most 50 entries.

`serviceAccountId` is valid only for an active resource-bound or standalone
service account. Clients with a service-account binding must be confidential.
`GET /api/oauth/admin/clients?serviceAccountId=<id>` lists the clients of one
account.

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

User access tokens carry an `auth_epoch` claim matching the account's current
authentication epoch. Applications and `/oauth/userinfo` check it on every
request; tokens with a missing or invalid claim, or a different epoch, are
rejected. ID tokens and client-credentials tokens do not carry this claim.

Signing an account out everywhere ends its OAuth sign-ins: refresh families,
authorization codes and device codes approved but not yet redeemed (in the
browser or in Cloud Login), and already issued user access tokens. This
includes password changes in the profile or at sign-in, administrator password
resets, password resets by link, an administrator signing the account out
everywhere, account expiry, and directory synchronization that ends the
account's sessions. The next refresh or code
exchange returns `invalid_grant`; access tokens stop working on the next
request. Signing out of one browser ends only that browser session.

Access tokens expire after at most one hour, and never after the login ends.
Core owns signing-key rotation and publishes public keys for their verification
lifetime. Revoking an individual refresh grant or signing out an OAuth client
prevents future refreshes; its already issued access token can remain valid
until expiry. Current-client validation and domain authorization still apply
on each request.

Core signs OAuth tokens. The OAuth application owns the public protocol,
clients, consent, authorization codes, refresh grants and discovery. Core and
OAuth require the configured broker secret; see
[Runtime configuration](/en/docs/operations/runtime-configuration) for setup.
If the signer or broker secret is unavailable, OAuth cannot start or issue tokens.

A rejected grant returns `invalid_grant`. An uncertain issuance outcome returns
`server_error` and is not retried automatically. A refresh grant is released
for retry only when Cloud can establish that no tokens were issued; otherwise
it stays blocked to prevent duplicate issuance.

Continue with [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).
