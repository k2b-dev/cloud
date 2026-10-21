---
title: Action approvals
navTitle: Action approvals
section: Identity and access
order: 357
description: How Cloud records, decides, and uses one approval for exactly the Action a person saw.
tags: [identity, approvals, capabilities, audit]
updated: 2026-10-20
---

# Action approvals

When Cloud asks a person to approve an Action, it records the question as one
approval request owned by the platform. The Assistant chat, `cld`, and code in
Assistant Studio ask through the same record, so one decision answers the
question wherever the person gives it.

An application does not opt in. When the Assistant, in a chat or in
`cld assistant`, or code in Assistant Studio calls a Capability Action without
`approval: "none"`, Cloud asks first, as described in
[Approve Capability Actions](/en/docs/ai/tools-and-approvals#approve-capability-actions).
The application declares its Actions, an optional
[review](/en/docs/platform/capabilities#describe-an-action-before-it-runs), and
its approval sentence; Cloud does the rest. A direct call with a person's own
credential, such as `cld capabilities action` or a request to
`/api/capabilities`, does not ask: the person makes that call themselves.

## What a request records

| Field | Meaning |
| --- | --- |
| Scope | The application that owns the effect and the Action, taken from the capability ID, never from the caller |
| Approval scope | The app-owned scope from the review, used for remembered approvals |
| Requester | Who asked: an Assistant turn and its tool call, or a Studio capability call |
| Approver | The person who may decide: the owner of the chat, or the person running the Studio code |
| Level | `standard` when the person may remember the approval of this call, otherwise `confirm` |
| Sentence and review | What the person read, as a snapshot in their language |
| Input and review digests | SHA-256 over the canonical Action input and over the review snapshot |
| Status | `pending`, then `approved`, `rejected`, `expired`, or `cancelled`; `approved` becomes `consumed` when the Action runs |
| Decided via | The decision channel: `web_session`, `app_session`, `oauth`, `api_key`, `invocation`, `acp_bridge`, or `cloud_login` |
| Deciding device | The Cloud Login device that decided, if any; an approval from a device revoked since then is not used |
| Approver's sign-out epoch | The approver's authentication epoch when Cloud asked; signing out everywhere moves it and ends the request |
| Expiry | When an undecided request stops accepting a decision |

The level follows what the call offers. An Action with
`approval: "rememberable"` whose review names an approval scope for the
arguments, a tool whose policy allows remembering, and a website request are
`standard`. Every other approval is `confirm`: an Action without `approval`,
which includes every destructive and open-world Action, and a call of a
rememberable Action whose review leaves out the scope, because that call asks
every time. Cloud records the level and checks the decision channel.

## Where to decide

A person can decide the same request in these places:

- The approval card in the chat that waits for it.
- The owning app's list or band, rendered with the shared `Approvals` component.
  Mail shows a band on the draft that the Assistant wants to send.
- The Assistant's **Approvals** view at `/app/assistant?approvals=1`.
  Its navigation row sits above **Studio** while a request waits.
  The row appears or disappears only on navigation. It stays while the view
  is open. If its count reaches zero before navigation, it shows a muted `0`.
- [Cloud Login](/en/docs/operations/cloud-login), on a paired phone.
  It shows the request, then asks for an explicit approve or reject choice.
- **My account → Approvals** at `/me/approvals`, for all apps.
  Use `/me/approvals?app=mail` to filter by app.

The approvals page uses the same card as the chat: a sentence with typed chips,
Cloud's reason line, the preview, two answers, and one outcome line. The reason
comes from the app's review or declared policy, not the model's explanation;
legacy reviews and Actions without a policy use `app_asks`. Filling a missing
reason in a displayed copy never changes the approval snapshot or its digest.

The list and the band's detail panel reuse the chat's preview and reading
controls. They show the stored review, including its locale and revision links.
An excerpt without a link can expand in place; a preview with an `open` link
opens the app's reviewed revision. These surfaces share the
[review limits](/en/docs/platform/capabilities#describe-an-action-before-it-runs): opening the approvals
page does not recover content omitted from the snapshot. The app must make
the complete proposed content available at that link. A saved resource that
does not yet contain the proposed edits cannot serve as that complete review.

The lists contain only open, unexpired requests that a chat still waits for.
They include Assistant chats and Studio code that asked through a chat.
A Studio request answered in an open Studio page is not listed.
Each page holds up to 20 requests, newest first. An app filter includes
requests whose effect belongs to that app or that the app asked for.

The rail and app grid add each app's open approvals to its icon count.

## Decision channels

| Channel | Approve `standard` | Approve `confirm` | Reject either level |
| --- | --- | --- | --- |
| Web or app session | Yes | Yes | Yes |
| The person's `cld`, OAuth, or API key | Yes | Yes | Yes |
| Cloud Login (`cloud_login`) | Yes | Yes | Yes |
| Editor bridge (`acp_bridge`) | Yes | No | Yes |

Without the ACP header, personal credentials decide both levels as before.
A client that sends `x-cloud-client: acp` declares itself as an editor bridge.
Cloud records its decisions as `acp_bridge`. Approving an open `confirm`
request through that channel returns `403`. The request stays open so the
person can approve it in Cloud. A request that is already decided or has
expired answers the bridge as it answers every other channel.

Cloud cannot verify this header. It is the bridge's own declaration.
It protects against the editor that drives the bridge. It does not protect
against a client that holds the person's `cld` token and leaves the header out.

## Decide once

- **First decision wins.** Two decisions that arrive at the same time, for
  example from two open tabs, cannot both apply. The second one gets the
  existing conflict answer of its route, or succeeds unchanged when it repeats
  the same decision.
- **Only the approver decides.** Another account gets the same answer as for a
  request that does not exist.
- **One question, one request.** When Cloud asks the same question again, for
  example after a restart, it keeps the request and the snapshot it recorded
  first. A decision on it never applies to a changed effect; that effect asks
  again, as described below.
- **Requests expire.** A chat request accepts a decision for 24 hours, like the
  turn that waits for it. A Studio capability call waits up to one day. No
  request waits longer than 24 hours.
- **Signing out everywhere ends open requests.** They leave lists, counts,
  and Cloud Login. A decision on such a request answers as expired.
- **Ending the wait cancels the request.** When a turn ends, its open requests
  and the approvals no call used are cancelled. A Studio capability call that is
  still open after one day is abandoned, and its request with it.

Rejecting is always possible while the request is open, also when the owning
application is unavailable.

## Pending approvals notification

Core sends **Pending approvals** when a request waits from a turn that did
not start in a signed-in browser session, such as `cld` or an editor bridge.
A person gets at most one notice every 15 minutes. One notice covers all
their waiting requests. A request that arrives within 15 minutes of the last
notice is included in a later notice, which Core sends once the 15 minutes
have passed. Core sends no notice for a request that an earlier notice
already included. It also sends none when the person has decided another
request since the newest waiting request arrived, because they are already
deciding in Cloud. Requests created before Core first registered this
notification are not notified.

The title is **Approval waiting** for one request or **N approvals waiting**
for several. The count includes all waiting requests from eligible turns.
The body shows the newest request's plain question and reason. With several
requests, a last line says how many more wait. The whole
notification uses the question's language: the language of the turn that
asked, or the app's base language when the app lacks that one. Email adds the link after those lines. Older events
and failures to load the question keep the general approval notice.
The notification opens `/me/approvals`. It has no decision buttons.
A browser push shows only the title: the question names people and their
addresses, so it stays off lock screens and paired devices. Browser delivery
is recommended. Users can change delivery in their
notification settings.

Cloud also wakes paired Cloud Login phones for open requests asked outside
Cloud's pages. Only devices that have read the Action inbox receive these
pushes, at most once per device in 30 seconds. A truncated `sends` question
stays in the browser and sends no phone push; it still counts in the inbox's
`moreActions`. See [Device text mapping](/en/docs/operations/app-approval#approve-an-action).
A push is a hint; the phone reads the signed request before the person
decides.

## Use an approval once, for what was shown

An approval is used directly before the Action runs, not when the person
decides. At that moment Cloud computes the input digest from the real input
again and runs the Action's review again. Both must match the snapshot the
person saw. Then the request changes from `approved` to `consumed` in one step,
so no other call can use it.

| Situation | Assistant chat | Studio code |
| --- | --- | --- |
| Review and input unchanged | The Action runs | The Action runs |
| The review changed, for example a draft got another recipient | Cloud asks again with the current review; nothing runs | The call fails with `CONFLICT`; the person can still decline |
| The device that approved was revoked, or the person signed out everywhere | Cloud asks again; nothing runs | The call fails with `CONFLICT` |
| The approval was already used, for example after a restart during the Action | The call ends with an error and does not run again; a new call asks again | The stored result is returned, or `CONFLICT` |

Asking again about a changed review keeps the call's idempotency key, so an
application that already performed the effect does not perform it a second
time.

A turn that continues after a later question of the same call runs the tool
from its start again, and that run uses the call's earlier approvals again. It
is the same call, not a second one.

Where an approval is used depends on who runs the effect. A chat uses it right
before the tool or Action runs. When code in Assistant Studio asks through the
chat, the Studio capability call uses its own request as it runs. A website
request from code uses the chat's request when the chat hands the decision to
it; Assistant sends each such request at most once.

The input digest binds only the input. When an Action's input refers to state
that can change, such as a draft ID, only the repeated review protects the
person, and only for what the review shows. Give such Actions a revision in
their input, as Mail's `draft.send` does with `expectedRevision`, and check it
in the Action.

## Audit

Every decision writes an audit event `auth.action.approve` or
`auth.action.deny`. Its target is the approval request, labelled
`<appId>.<action>`, and its metadata names the level, the requester, and the
`decidedVia` channel: `web_session`, `app_session`, `oauth`, `api_key`,
`invocation`, `acp_bridge`, or `cloud_login`. Assistant tool calls also keep
the channel next to their approval state. Cloud Login decisions also record
`deviceId` in the audit metadata. The device signs the digest of the view the
person saw; a changed view, expired request, or decision elsewhere returns
`409`.

Approval requests are deleted with the capability execution records, 90 days
after they expired.

## Remembered approvals stay separate

Where allowed, **Yes, and don't ask again in this chat** remembers the reviewed
scope for that chat. The browser no longer offers **Always approve**; earlier
choices still apply until the next major release. These choices and allowed
websites remain preferences in Assistant and resolve a later matching call
without a new request. Only a person in a signed-in browser session can remember a website.
Routines (scheduled tasks) and mandates never ask and never use a remembered approval;
see [Background mandates](/en/docs/identity/background-mandates).
Remembering and revoking a preference each write an [audit event](/en/docs/platform/audit-events#remembered-ai-approvals).

## Show approvals in your app

Mount `Approvals` from `@k2b/cloud/approvals/ui` with your app ID in `app`.
For one resource, also pass `link`. Use the same href that the Action's review
uses in `links`. Load the first page during SSR with
`loadPendingApprovals(c, query)` from `@k2b/cloud/server`.
Pass that page as `initial` for the same query.

In server code:

```ts
import { type AuthContext, loadPendingApprovals } from "@k2b/cloud/server";
import type { Context } from "hono";

export const loadInventoryApprovals = (c: Context<AuthContext>) =>
  loadPendingApprovals(c, { app: "inventory" });
```

Call this loader in your authenticated SSR handler.
Pass its result to your island:

```tsx
import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";

export const InventoryApprovals = (props: { initial: ApprovalPage }) =>
  <Approvals app="inventory" initial={props.initial} />;
```

Use `layout="band"` above a resource. The band shows nothing when the loaded
page has no requests. Decided rows stay as receipts until the next load.
The default `list` layout includes an empty state.
Without `initial`, the component loads in the browser.

An optional navigation row can use `ApprovalsNavStatus` and `approvalNavCount`
from the same UI entry point. Pass the app ID and the initial page's `count`.
`ApprovalsNavStatus` renders the count. `approvalNavCount(app, initial)` reads
its current value. Keep row visibility stable until navigation.

No app-owned approval route, table, or opt-in is needed.
See [Cloud approvals](/en/ui/cloud/approvals) for the component properties,
navigation example, and decision states.

## Approval routes

Core serves these routes for authenticated, user-backed actors only.
Each route reads or decides that person's own requests.
An actor without a user gets `403`. An unauthenticated caller gets `401`.

| Route | Input | Success response |
| --- | --- | --- |
| `GET /api/approvals` | Optional query fields `app`, `link`, and `cursor` | `{ items, nextCursor, count, elsewhere }` |
| `GET /api/approvals/counts` | None | `{ total, apps }` |
| `POST /api/approvals/:id/decision` | UUID `id` and JSON `{ approved, remember? }` | `{ status: "approved" }` or `{ status: "rejected" }` |

`app` matches the effect owner or requester app. `link` matches an exact review
link href that starts with `/`. Both filters apply when both are present.
Pass `nextCursor` as `cursor` for the next page. It is `null` at the end.
`count` includes matching requests across all pages. `elsewhere` counts the
person's other open requests. It is zero without an app or link filter.
Invalid query fields or cursors return `400`.

Each item contains `id`, `app` (`id`, localized `name`, nullable `icon`),
`action`, `assurance`, `sentence`, nullable `review`, `requester`
(`kind: "chat"`, `appId`, nullable `title`, `href`), `remember`
(`chat`, `always`, `website` booleans), `createdAt`, and `expiresAt`.
The timestamps use ISO strings. `apps` maps app IDs to positive open counts.
An approval can count for both its effect owner and requester app.
`total` counts each request once.

`approved` is a boolean. `remember` is optional and accepts `"chat"` or
`"always"` only where the request allows it. Website remembering requires
`"chat"` and a signed-in browser session.
A successful decision continues the waiting chat, like its approval card.

| Decision status | Meaning |
| --- | --- |
| `200` | Decision accepted, or the same decision repeated |
| `400` | Invalid ID or body, or a choice that cannot be remembered |
| `403` | No user-backed actor, or the ACP bridge tried to approve an open `confirm` request |
| `404` | No request for this person, an expired request, or the chat no longer waits |
| `409` | The request already has a different decision |
| `429` | Too many requests from this person; retry after `Retry-After` seconds |

The decision body is limited to 1 KiB. A larger body returns `413`.
All three routes use Cloud's per-person API rate limit, like `/api/ai`.

## Platform-owned service

`@k2b/cloud/services/approvals` owns the table, migration, and the `request`,
`decide`, and `consume` functions. It also provides `listPending`,
`countPending`, and `presentPendingApproval` for platform consumers.
These functions are platform-owned. Applications show and decide requests
through the shared component and Core route. They load initial data through
`loadPendingApprovals` from `@k2b/cloud/server`.

## Upgrade

For the initial platform-request upgrade, Core creates `approvals.requests`
on start and gives every chat
approval that is still open a request, with the same digests the running
Assistant computes. A Studio capability call that was waiting during the
upgrade receives its request when the person decides, and keeps the one day it
had to wait. A chat Action whose review changed since the question asks
again instead of running. See
[Deployment requirements](/en/docs/operations/deployment-requirements#record-approvals-as-platform-requests)
for the initial upgrade order. See
[Decide pending approvals in Cloud](/en/docs/operations/deployment-requirements#decide-pending-approvals-in-cloud)
for the list routes and ACP channel upgrade.
