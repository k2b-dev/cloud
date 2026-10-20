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

Each request is the same question card as the Assistant chat (card v4): one
sentence, Cloud's reason line, the thing itself, and two answers that name the
deed and target. A new review gives the app's sentence with chips and its
preview. An older review shows its message as the question, every detail as a
row, and Markdown as one block; a request without a review asks its sentence.
Above the card, one quiet line names the owning app, links the chat it waits
in, and says how long ago Cloud asked and when the request expires.

An answer collapses the card at once to one outcome line in its place, with
the focus on that line; what follows moves up by the answer the person gave.
**Approved.** says that the chat it came from carries the Action out. A
rejection reads as the app's rejected sentence and "You declined.". When
another tab or channel decided first, or the request expired or was withdrawn,
the line says **Already decided elsewhere** or **Expired or withdrawn** in a
neutral tone. A decision that did not go through says so and offers **Answer
again**, which brings the question back. The list changes only when it loads
again. With more than one open request, **Reject all** asks once and rejects
them one after another. There is no "approve all".

**Show more** loads the next 20 requests below the rows already shown. If
that fails, the rows stay, an error appears next to the button, and the
button becomes **Try again**.

The answers arm half a second after a row appears, so a click meant for the
page cannot approve it. The quiet **Yes, and don't ask again in this chat**
link appears only on `standard` requests that offer remembering for the chat.
**Always approve** is no longer offered; choices made earlier still apply.

The band shows each request as one tinted row with its title, the chat, and
**Details**, **Reject**, and **Approve**. **Details** opens the same question
card in a panel. The band renders nothing when the loaded page has no requests.

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

Each row is an `article` named after its question. The card is a group named
by its sentence and described by its reason. The outcome line takes the focus
after an answer and announces itself through a polite live region; in a band, a
failed decision says so in the row's foot as an alert. A failed **Show more** is announced as an alert, and focus stays
on the button that retries it. The navigation count tells screen readers how many requests wait,
in the inherited locale.

## Runtime

The component reads `GET /api/approvals` and decides with
`POST /api/approvals/:id/decision` as the signed-in person. Core checks that
the person is the approver, that the request is still open, and the channel
rules of the request's level; then it continues the chat that asked, exactly as
a decision in the chat card does. After a decision the component refreshes the
rail counts.

## Example

Load the first page in the authenticated SSR handler:

```ts
const page = await loadPendingApprovals(c, { app: "mail", link: draftHref });
```

Pass it to the island that shows the draft:

```tsx
<Approvals app="mail" link={draftHref} initial={page} layout="band" />;
```

Use the same `draftHref` in the Action review's `links`.
See [Action approvals](/en/docs/identity/approvals#show-approvals-in-your-app)
for the server and island imports.
