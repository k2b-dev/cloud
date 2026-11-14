# Cloud approvals

Approvals look the same in every place, so a person always recognises one.
`ApprovalCard` draws every approval: in the Assistant chat, the side panel, the
**Approvals** list, Code pages, other apps, and on phones. Only its width
follows the place. `Approvals` lists the signed-in person's open approvals with
that card and lets them approve or reject each one in place. Every app uses the
same component and the same Core route, `/api/approvals`, for its own scope.
The app builds no route, table, or card of its own.

## Use Cloud approvals

Mount the list where people look for what the app is waiting on, such as an
**Approvals** view, or beside the resource an Action would change with `link`.
Do not mount it to authorize anything: Cloud decides through its platform
approval requests and continues the waiting chat itself.

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
  send Action would send. A list with `link` shows nothing until a request for
  it waits, and no count or bulk action.
- `initial`: the SSR page for the same `app` and `link`.

There are no look props. `ApprovalCard` takes data and answers only; the
`approval-card-calls` rule rejects `class`, `style`, variants, and spreads on it.

An app that confirms an Action itself before it runs it, such as a runner
dialog, draws the review's details with `ApprovalDetails` from
`@k2b/cloud/approvals/ui`: the same details as the card, without a second look.

## The card

- **Ground.** A tinted ground in the AI colour (`--k2b-ai-surface`) in every
  place, light and dark, with 14 px corners, no rules, and no shadow. The card
  sets its own AI primary scope, so it looks the same in a blue app. A flat side
  panel keeps the tint: a tint without a shadow is no depth.
- **Head.** "Approval · App" with a shield icon and the app's icon tile. After
  an answer, the head ends with the state as a word and an icon: Running, Done,
  Declined, Expired, Failed, or Unclear.
- **Question.** The app's sentence with chips (16 px), then Cloud's reason line
  with its icon, such as "Sends something to other people."
- **Details.** The app's [view blocks](/en/docs/platform/capability-views) on the
  surface colour under "Details from App". An image and the details that follow
  it stand as one row. Only the app's part comes from the app.
- **Answer row.** Left, quiet facts: "Expires in 9 min" where Cloud knows the
  expiry, and either the checkbox **Don't ask again in this chat** (only on
  `standard` requests that offer it) or "Asks every time". Right, **Change** for
  a draft, the decline answer, and the one filled approve answer. Below 32.5 rem
  of the card's own width the answers take the full row and the facts sit under
  them.

Answers arm half a second after a request appears in the list, so a click meant
for the page cannot approve it. A complete proposal that is not inline must be
read before it can be approved; the approve answer says why it waits.

## Drafts

When the review's details contain a `Draft`, the card starts as "Draft · App"
in edit mode: one raised island with the intent, the note "Nothing goes out
before you approve.", the fields with their labels above them, **Discard**, and
**Send …**. Read-only context rows such as "To" stand above the fields; people,
places, and files are never edited here. A review link with `rel: "edit"` such
as **Change recipients in Mail** opens the app.

**Send …** sends the edited values to Cloud, which reviews the Action again with
them. The same card then becomes the approval: the ground turns to the tint and
the fields lose their edge in 200 ms; size, head, fields, and answer row stay in
place. The text is locked while the card asks; **Change** returns to editing. A
person approves exactly what they see. Under `prefers-reduced-motion` the
switch has no transition. Converted older reviews and Code-version requests are
never editable.

## States and outcomes

An answer collapses the card at once to its head and one outcome line in its
place, with the focus on that line. **Approved.** says that the chat it came
from carries the Action out. Code-version approvals instead say that the
approval was recorded for this version. A rejection reads as the app's rejected
sentence and "You declined.". When another tab or channel decided first, or the
request expired or was withdrawn, the line says **Already decided elsewhere** or
**Expired or withdrawn** in a neutral tone. A decision that did not go through
says so and offers **Answer again**, which brings the question back. In the
chat, an unclear outcome offers **Check again**, and a failed Action **Try
again**.

A `code_version` request links to its Code instead of a chat, labelled
**Code “title”**. It addresses current Cloud admins and never offers remembered
choices. For the author, approval is disabled with a reason that another admin
is needed, unless that person is the sole active human admin. A required recent
sign-in leaves a recovery message to sign in again, return, and retry. Rejection
remains available.

Above each card in the list, one quiet line links the chat or Code it waits in
and says how long ago Cloud asked. With more than one open request, **Reject
all** asks once and rejects them one after another. There is no "approve all".
**Show more** loads the next 20 requests; if that fails, the rows stay, an error
appears next to the button, and the button becomes **Try again**. The empty list
says "You're all set." When `app` is set and other apps have open requests, a
line links to the Core page.

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

Each request is an `article` named after its question. An open card is a
section named by its sentence and described by its reason; a decided card is
named by its kind, app, and state. The outcome line takes the focus after an
answer and announces itself through a polite live region. The remember choice is
a real checkbox. A failed **Show more** is announced as an alert, and focus stays
on the button that retries it. The navigation count tells screen readers how
many requests wait, in the inherited locale.

## Runtime

The component reads `GET /api/approvals` and decides with
`POST /api/approvals/:id/decision` as the signed-in person. Core checks that
the person is the approver, that the request is still open, and the channel
rules of the request's level; then it continues the chat that asked, exactly as
a decision in the chat does. After a decision the component refreshes the rail
counts. Code-version decisions use the current Cloud-admin role and the version
owner's transaction instead of a waiting chat.

## Example

Load the first page in the authenticated SSR handler:

```ts
const page = await loadPendingApprovals(c, { app: "mail", link: draftHref });
```

Pass it to the island that shows the draft:

```tsx
<Approvals app="mail" link={draftHref} initial={page} />;
```

Use the same `draftHref` in the Action review's `links`.
See [Action approvals](/en/docs/identity/approvals#show-approvals-in-your-app)
for the server and island imports.
