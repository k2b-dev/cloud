# Cloud approvals

`Approvals` lists the signed-in person's open Action approvals and lets them
approve or reject each one in place. Every app uses the same component and the
same Core route, `/api/approvals`, for its own scope: the requests whose effect
belongs to the app, or that the app asked for. The app builds no route, table,
or card of its own.

## Use Cloud approvals

Mount the list where people look for what the app is waiting on, such as an
**Approvals** view or the page of the resource an Action would change. Use the
band layout on a resource page and the list layout everywhere else. Do not
mount it to authorize anything: Cloud decides through its platform approval
requests and continues the waiting chat itself.

Load the first page during SSR with `loadPendingApprovals` from
`@k2b/cloud/server` and pass it as `initial`. The list then renders with the
page and never pushes content down when it arrives. Without `initial`, the
component loads in the browser and shows a loading state first.

## Import

```ts
import { Approvals, ApprovalsNavStatus, approvalNavCount } from "@k2b/cloud/approvals/ui";
import { loadPendingApprovals } from "@k2b/cloud/server";
```

## Props

- `app`: list the requests whose effect belongs to this app or that it asked
  for. Without it, the list shows every app's requests grouped by app, as the
  Core page **My account → Approvals** does.
- `link`: only requests whose review links to this same-origin path. Pass the
  same href your Action's review uses in `links`, for example the draft that a
  send Action would send.
- `initial`: the SSR page for the same `app` and `link`.
- `layout`: `list` (default) or `band`.

## Presentation

A list row shows the app's sentence as its title, the owning app, the chat it
waits in as a link, and how long ago Cloud asked. Below follow the review's
message and fields and the first long field, cut after three lines. The foot
names the level ("Asks every time" for `confirm`) and the expiry, then
**Details**, **Reject**, and **Approve**. **Details** opens a panel with the
whole review, its links, and the same decision.

Rows are set apart by space, not by lines or boxes. A decided row stays in
place at its height: its content dims, the icon turns into a check, and the
buttons turn into a receipt such as **Approved** or **Already decided
elsewhere**. The list changes only when it loads again. With more than one
open request, **Reject all** asks once and rejects them one after another.
There is no "approve all".

The approve buttons arm half a second after a row appears, so a click meant
for the page cannot approve it. Remember options (**Approve for this chat**,
**Always approve**) appear only on `standard` requests that offer them.

The band shows each request as one tinted row with its title, the chat, and
the decision; it renders nothing when no request waits.

The empty list says "Nothing is waiting for you." When `app` or `link` is set
and other apps have open requests, a line links to the Core page.

## Navigation count

Every app can add an **Approvals** row to its own navigation. Render the row
only when `approvalNavCount(appId, initialCount)` is above zero or the view is
open, and evaluate that only when the person navigates, so the row never
appears or leaves under the pointer. Put `<ApprovalsNavStatus app="mail"
initial={page.count} />` in the row's `meta`; it shows the live count and keeps
a muted 0 when the count drops while the row is shown.

The rail and the app grid already add each app's open approvals to its icon's
count. An app does not need a `nav.badge` route for that.

## Accessibility

Each row is an `article` named after its title. Receipts and errors replace
the buttons in the same place, and a failed decision says so in the row's foot
as an alert. The navigation count tells screen readers how many requests wait,
in the inherited locale.

## Runtime

The component reads `GET /api/approvals` and decides with
`POST /api/approvals/:id/decision` as the signed-in person. Core checks that
the person is the approver, that the request is still open, and the channel
rules of the request's level; then it continues the chat that asked, exactly as
a decision in the chat card does. After a decision the component refreshes the
rail counts.
