# Cloud approvals

Approvals look the same in every place, so a person always recognises one.
`ApprovalFrame` draws every approval and `ApprovalCard` fills it for a
Capability Action: in the Assistant chat, the side panel, the
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
import { ApprovalFrame } from "@k2b/cloud/approvals/frame";
import Approvals from "@k2b/cloud/approvals/list";
import ApprovalsNavStatus, { approvalNavCount } from "@k2b/cloud/approvals/navigation";
import { loadPendingApprovals } from "@k2b/cloud/server";
```

The combined `@k2b/cloud/approvals/ui` entry remains available. Prefer the
focused entries above to keep list and proposal code out of a summary-only view.

## Props

- `app`: list the requests whose effect belongs to this app or that it asked
  for. Without it, the list shows every app's requests grouped by app, as the
  Core page **My account → Approvals** does.
- `link`: only requests whose review links to this same-origin path. Pass the
  same href your Action's review uses in `links`, for example the draft that a
  send Action would send. A list with `link` shows nothing until a request for
  it waits, and no count or bulk action.
- `initial`: the SSR page for the same `app` and `link`.

There are no look props. `ApprovalCard` and `ApprovalFrame` take data and
answers only; the `approval-card-calls` rule rejects `class`, `style`, variants,
and spreads on either. `ApprovalFrame` composes the public `NoticeRow` with its quiet detail line; apps do not restyle its controls or grid.

## Approval frame

Something that must look like an approval but is no Capability Action, such as
switching on a Code version or an admin's review of one, fills `ApprovalFrame`
with its own data. The frame knows no Capability:

- `locale`, `state` (`open`, `sending`, `decided`, `expired`, `loading`) and
  `mode` (`approve`, `edit`) describe the current interaction.
- `source` names the app for accessibility. `status` supplies state metadata;
  the visible `sentence` says the state once, without a separate state label.
- `sentence` accepts plain text or `ActionText`. Chips become their full text
  in the summary. `reason.text` is the quiet line, with `quietTitle` when its
  full text differs from the rendered content.
- `details` supplies `{ label, context?, reason?, content, note? }`. A separate
  `reason` keeps summary facts out of the dialog’s introductory reason. Pass `content` as a
  function to mount the complete proposal only when the person opens it.
  Optional `load` prepares its module before the dialog opens; a rejected load
  leaves a visible error on the card and **See everything** retries it.
  `notes` and `meta` remain available in that detail view.
- `confirm` is the main control. Set `filled: false` for a neutral action or
  supply `href` for navigation. A domain-specific control such as a split
  button can be passed through `actions`; its renderer receives `{ narrow }`
  for the public button size and variant. Supply at most two logical controls.
- `secondary` is a direct second decision. It never loads the proposal.
  `detailsPlacement="quiet"` puts **See everything** in the quiet line,
  leaving both card controls for decisions.
- `decline`, `back`, `more` and the `remember` checkbox are available through
  **See everything**. `waiting` disables decisions; `unavailable` disables
  confirmation while leaving rejection and the proposal reachable.
- `link` makes **See everything** navigate to the full page. When additional
  decisions need a detail dialog, that dialog also exposes the link.
- `reserve: false` makes an actionless terminal receipt compact on phones.
  Loading always reserves its space. `alert` and `quietAlert` announce errors
  separately from the ordinary status sentence.

Keep the same frame through state changes. Give it the current sentence,
quiet line and actions rather than replacing it with `Chat.Outcome`.

An app that confirms an Action itself before it runs it, such as a runner
dialog, draws the review's details with `ApprovalDetails` from
`@k2b/cloud/approvals/ui`: the same details as the card, without a second look.

## The card

The card has one shield icon, one 14 px sentence and one quiet 13 px line.
It uses the AI surface in light and dark mode, 12 px corners and no nested
box, rule or shadow. The state appears once in the sentence. Full proposals,
messages, consequences and additional decisions are behind **See everything**.

On desktop the two text lines sit 2 px apart and are vertically centred in a
64 px card. Both truncate with an ellipsis; keep the full quiet text in its
`title`. The action column takes only the width it needs. Public buttons use
`size="sm"`.

At 35 rem of the card's container and below, text stays at the top and actions
move below it. Two actions have equal widths: the secondary one on the left
with a neutral frame, the main one on the right. A single action fills the
row. Public buttons use `size="md"`. The sentence and quiet line each show up
to two lines. The transition reserve derives from those four text lines,
the control height and spacing. Controls stay at the bottom with a buffer
above; only actionless terminal receipts become compact. The card and the
following content stay in place through sending, failure, retry and loading.

Answers arm half a second after a request appears in the list, so a click meant
for the page cannot approve it. A complete proposal that is not inline must be
read before it can be approved; the approve answer says why it waits.

## Drafts

When an editable `Draft` is present, the compact card states its intent.
**See everything** or its main control opens the fields, with labels above
them. Read-only recipients, places and files remain context; review links
open the source app when those need changing.

**Send …** submits changed values for a fresh review. The dialog keeps the
fields and values when that fails. Once reviewed, those fields become
read-only and the main control confirms exactly that proposal. **Change**
returns to editing; **Discard** declines it. Converted older reviews and
Code-version requests remain read-only.

## States and outcomes

An answer changes the sentence, quiet line and controls in the same frame.
Focus follows the next main control or the result frame when the person has
not deliberately moved it elsewhere. **Approved.** says that the chat it came
from carries the Action out. Code-version approvals instead say that the
approval was recorded for this version. A rejection reads as the app's rejected
sentence and "You declined.". When another tab or channel decided first, or the
request expired or was withdrawn, the line says **Already decided elsewhere** or
**Expired or withdrawn** in a neutral tone. A decision that did not go through
says so and offers **Answer again**, which brings the question back. In the
chat, the full details retain outcome links and **Check again** when a status
query is available.

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

Each request is an `article` named after its question. The compact frame is
named by its kind and app. Its sentence is a polite status region; failures
have their own alert region. **See everything** opens a focus-managed dialog
or follows the full-page link. The remember choice is a real checkbox.
A failed **Show more** is announced as an alert, and focus stays on its retry
button. Navigation counts use the inherited locale.

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

Capability send approvals show **Send** and **Don't send** directly on the card.
**See everything** is a quiet link beside the reason and expiry, including on
phones. Rejection never waits for a full proposal. **Don't ask again in this
chat** is in the detail dialog; **Change** sits on the left of its footer and
the decision pair stays together on the right. A reviewed draft's send action
is filled. The app name is announced by the card's accessible name, not repeated
in its quiet line.

Administrator reviews show **Approve version N** and **Reject or request changes …**.
The latter opens the decision dialog with both choices and the required text.
The change list is a separate section below the frame. This page has no
**See everything** control.
