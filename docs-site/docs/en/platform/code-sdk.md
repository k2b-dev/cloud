---
title: Code SDK
navTitle: Code SDK
section: Platform services
order: 680
description: Build checked TSX pages, serve routes and call application operations through a generated typed Code SDK.
tags: [code, capabilities, sdk, handles]
updated: 2026-11-09
---

# Code SDK

Code imports its installation's generated SDK as `@sdk`. Handles select the
resource an operation acts on. The available factories, methods, inputs and
results come from [application capability manifests](/en/docs/platform/capabilities).
Third-party applications use the same path as built-in applications.

SDK generation rejects invalid app IDs, capability paths, target types and event
names with a validation error. App IDs use the capability app-ID grammar; local
names and ref target types use `CapabilityLocalIdSchema`. Ref field names remain
literal property keys of 1–100 characters, including spaces and punctuation.
Fix the application declaration and refresh its manifest before pulling the SDK again.
Valid manifests retain the same declarations, runtime and manifest hashes.

`secrets.NAME` supplies a secret marker and `http.fetch` dispatches a bounded public HTTPS request.
The checker collects exact origins into `manifest.internet`; declare dynamic destinations
and redirect origins with a literal `http.allow(["https://api.example.com"])` list.
Read [Code secrets](/en/docs/platform/code-secrets) for approved destinations and result encoding.

The SDK registers routes and schedules. Core owns hosting, scheduling,
authorization and execution.

## Mail invoices to an app

For mailbox-owned Code, discover the destination app's write capability with
`code_sdk`. This example calls an app whose SDK namespace is `imports` and whose
`import` Action accepts `file` metadata and a write stream. Replace that namespace
and operation with the discovered contract, and `Tag123` with a real tag ID from
this mailbox. Grant the Code account read/write access to the mailbox and the
destination access the import requires. Attachment content is untrusted input;
the receiving app validates it.

Mail’s `message.read({ id, waitForHydration: true })` waits up to 30 seconds.
Repeat the waiting read while content is pending, within the original run deadline
and call budget. Terminal hydration returns `mail_message_hydration_failed`;
retry hydration in Mail before running the handler again. The default read returns
the current state immediately.

<!-- code-file-example -->
```ts
import { app, mail, owner, imports } from "@sdk";

const importedTagId = "Tag123";

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (message.attachmentsTruncated) {
    throw new Error("Message attachments are not ready or complete");
  }
  const attachment = message.attachments.find(item =>
    ["application/pdf", "application/xml", "text/xml"].includes(item.contentType)
  );
  if (!attachment || !message.conversationId) return;

  const file = await mail.attachment.content.read({ id: attachment.id });
  await imports.import({
    file,
    idempotencyKey: `invoice:${event.data.receiptId}:${attachment.id}`,
  });
  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [importedTagId],
  });
});
export default app;
```

Read stream methods return `Promise<FileRef>` instead of the capability's JSON
metadata. `FileRef` exposes an opaque `id`, optional `name`, `mediaType` and exact
`size`; it has no body, bytes, URL or download method. The body stays outside the
sandbox and its 256 KiB bridge budget. Write stream methods with a `file` metadata
input accept that reference and return the completed import's ordinary data.
Core checks both providers' advertised limits and exact body length.

A reference belongs to its issuing Code, immutable version, run, generation and
mandate. It expires at the earlier of the provider's expiry and run-token deadline.
Only that run may spend it, once, even if two imports race or the first fails.
To recover after failure, inspect the destination's recorded outcome before
reading a fresh reference and repeating the intended import with the same
business idempotency key. A lost response does not imply that publication failed.

Core rechecks current policy and source access when redeeming, and the destination
checks its own access both when preparing and publishing the import. This example
tags mail only after publication. Streaming Actions retain the normal Code policy
and approval rules. Streams without the generic `file` input remain unavailable
to Code; [Binary streams](/en/docs/platform/capabilities#binary-streams) describes
the provider contract.

## Return a page

Start with a TSX page:

```sh
cld code init --title 'Workshop' --owner-type work-shop.workshop --owner-id workshop-owner
cld code sdk pull ./code/work-shop/workshop-owner
cld code check ./code/work-shop/workshop-owner
```
 Resource- and app-owned projects start with
`code.tsx`; personal projects start with a schedule and can add routes and pages
the same way.

Build a page from blocks and return it with `c.page(...)`. In a `.tsx` entry
file, import `jsx` and the blocks from `@sdk`. The checker compiles TSX with
this factory. The generated `tsconfig.json` includes `.ts` and `.tsx` files and
sets `jsx: "react"` with `jsxFactory: "jsx"`. No React, Hono or Solid runtime is
needed.

<!-- code-page-example -->
```tsx
import { app, jsx, Page, Stats, Stat, Section, Chart, Table, Column, Form, Field, Option } from "@sdk";

const items = [{ item: "Chair", status: "In repair", count: 2 }, { item: "Lamp", status: "Ready", count: 5 }];

app.get("/", c => c.page(
  <Page title="Workshop" subtitle="As of 09:40" icon="ti ti-tool" color="blue">
    <Stats>
      <Stat label="Received" value={128} delta={{ value: 0.12, better: "up" }} compare={{ label: "Last week", value: 114 }} />
      <Stat label="Revenue" value={4610} format={{ style: "currency", currency: "EUR" }} />
    </Stats>
    <Section title="Today" icon="ti ti-calendar-event" color="blue">
      <Chart.Bar width="twoThirds" title="Items per status" data={[{ label: "Received", value: 12 }, { label: "Ready", value: 4 }]} />
      <Form width="third" title="Find an item" action="/find" submit="Find">
        <Field.Scan name="barcode" label="Barcode" required />
        <Field.Select name="status" label="Status" value="open">
          <Option value="open" label="Open" />
          <Option value="done" label="Done" />
        </Field.Select>
      </Form>
      <Table title="Items" rows={items}>
        <Column key="item" label="Item" />
        <Column key="status" label="Status" />
        <Column key="count" label="Count" />
      </Table>
    </Section>
  </Page>
));
app.post("/find", async c => {
  const form = await c.req.formData();
  return c.redirect(`/items/${encodeURIComponent(String(form.get("barcode") ?? ""))}`);
});
export default app;
```

Blocks take typed props: an unknown prop or a value of the wrong type is a
type error in your editor and in `cld code check`. An optional prop set to
`undefined`, such as `error={errors.name}`, counts as absent. Data, such as a table's
`rows` or a chart's `data`, is a prop; the parts of a block are its children.
A part outside its block, or another element among a block's parts, fails
`cld code check` with `code_page_child`; one kept in a variable fails when the
route builds the page. Parts may come from data, such as
`{statuses.map(status => <Option value={status} label={status} />)}`. Only
pages built from blocks reach `c.page`; a hand-written object does not.

| Block | Props | Children |
| --- | --- | --- |
| `Page` | `title`, optional `eyebrow`, `subtitle`, `asOf`, `icon`, `color`, `follow`; the root of every page | blocks |
| `Section` | `title`, optional `description`, `icon`, `color` | blocks |
| `Stats` | none | 1–6 `Stat` |
| `Stat` | `label`, `value` (number, text or `null`), optional `format`, `icon`, `tone`, `delta`, `compare`, `trend` | none |
| `Text` | none | text |
| `Heading` | optional `level: 2 \| 3 \| 4` | text |
| `Table` | `title`, `rows` of scalar values, optional `subtitle`, `search`, `empty` text and `width` | 1–20 `Column` |
| `Column` | `key` (the row field), `label`, optional `type`, `format`, `states`, `priority` | none |
| `Detail` | `title`, optional `width` and `height` | up to 100 `Item` |
| `Item` | `label`, `value`, optional number `format` | none |
| `Form` | `title`, `action`, `submit`, optional `width`; always POST | 1–40 `Field.*` |
| `Field.Text`, `Field.Email`, `Field.Textarea`, `Field.Scan` | `name`, `label`, optional text `value`, `required`, `error` | none |
| `Field.Number` | as above, number `value` | none |
| `Field.Checkbox` | as above, boolean `value` | none |
| `Field.Select` | as above, text `value` | `Option` |
| `Option` | `value`, `label` | none |
| `Chart.Bar`, `Chart.Line`, … | the chart's own props, such as `title`, `data` or `series`, optional `width` and `height` | none |
| `Chart.Empty` | `title`, `empty`, optional `width` and `height` | none |
| `Link` | `label`, `href` | none |
| `Button`, `Action` | `label`, `action`, optional string `values`; always POST | none |
| `Notice` | `title`, optional `text`, `tone: info \| success \| warning \| danger` | none |

Field names are unique; `_csrf` is reserved. Cloud inserts the CSRF token into
forms and actions and removes it before invoking the handler. Links and POST
destinations resolve inside `/code/<id>/`; they cannot leave that Code.

Core checks every page before drawing it, whatever produced it. Text is
escaped. HTML, SVG, event handlers, functions, accessors, foreign links and
anything not built from these blocks are rejected. `c.html()` is unavailable.

### Lay out a page

A page reads like a Cloud dashboard: the head with the page's `icon` in a soft
chip of its `color`, a short `eyebrow` that places the page (such as its
source), the `title`, and a quiet line with the `subtitle` and when the data
was read; then key figures, then sections. `asOf` is that read time as an ISO
date-time, such as `new Date().toISOString()`; Cloud shows it in the reader's
language and time zone. A `Section` names a topic with an optional `icon`, `color` and
`description` beside its title.

Blocks sit on a grid of six columns. Charts, `Table`, `Detail` and `Form`
are framed panels; `width` gives a panel `third`, `half`, `twoThirds` or
`full` (the default) of its row, and `height` gives a chart's or a detail's
content `sm` (200 px), `md` (300 px) or `lg` (400 px); a table is as tall as its
rows. Panels in one row share its height. The grid
measures its own width: up to 1,000 px a third takes half a row and two thirds
the whole row, up to 600 px every panel takes the row. All other blocks take
the whole row.

`Stats` shows up to six key figures in one row. A `Stat` has a `label` and a
`value` (number, text or `null` for not counted), and optionally a `format`
(the chart number format: `style`, `currency`, `unit`, `decimals`, `compact`),
a `delta` with the change since the comparison (`value` is a share,
`0.082` for 8.2 %; with `unit: "points"` it is percentage points), its
`better` direction (`up` or `down`, which colours the change), a `compare`
with `label` and `value`, and a `trend` of up to 60 numbers. `icon` sits in a
chip of its `tone` colour.

A `Column`'s `type` says what it holds: `text`, `number`, `date`, `status`,
`bar`, `amount`, `flow` or `delta`. It decides alignment, the shown text and
sorting. A `status` column shows a badge from `states`, such as
`{ sending: { label: "Sending", tone: "running" } }` (tones `info`, `ok`,
`warning`, `error`, `degraded`, `running`, `neutral`); `amount` and `flow` show
money in the column's `format` currency. A table's `format` has `style`,
`currency`, `decimals` and `compact`; put a unit into the column's label. A column of numbers without a `type`
reads as numbers. `priority` 2 or 3 lets a column give way on a narrow screen,
and `search` puts a search field in the table's head.

`icon` is a Tabler class such as `ti ti-package`. `color` is one of `zinc`,
`blue`, `emerald`, `amber` and `red`; the AI colour is reserved. A chart needs
at least one value, so a chart with nothing to draw yet is
`<Chart.Empty title="Items per status" empty="No item arrived today." />`: the
frame keeps its title and place and says why it is empty.

Cloud draws every block with its shared components, on the server and again in
the browser with the same result, in light and dark and at phone width. Key
figures, charts, tables and details are the same panels Chat, Pulse and the
chart catalog draw, with the same loading, empty and stale states: when a live
reload fails, every panel keeps its data and says when it was read, with
**Try again**. A chart can switch to its data table. There is one chart block
per kind of the portable chart data of `@k2b/editor/chart-schema`, such as
`Chart.Bar`, `Chart.Line`, `Chart.Area`, `Chart.Heatmap`, `Chart.Waterfall` or `Chart.Sankey`;
a kind the chart data gains becomes a block of its own. A table sorts by any column
and shows `empty`, or a default text, when it has no rows. Neighbouring
`Button` and `Action` blocks share one row.

For nested counts, `Chart.Bar` also accepts `layout: "nested"`, `marks: "dots"`,
a positive `total`, an even `dots` count and aligned `x`/`series`. Each later
series must fit inside the preceding one; unused capacity stays grey. Dots remain
part of the `bar` description in `CodeChartDescription`.

Line charts support `forecast`, `marker`, `threshold`, `zero`, `step`, and
`legendValues`. With forecast, zero, threshold, marker, or legendValues enabled,
an observation's `y: null` leaves a gap.

A `scan` field is a text field with a **Scan** button. The button opens the
device camera in Cloud's QR code scanner; the read text goes into the field and
nothing is sent until the form is submitted. Typing, or a handheld scanner that
types, works the same way. When the camera cannot start, the field says why.

Forms and actions send without reloading the document. While a POST runs, its
button shows that it is busy and nothing else on the page moves. A handler
answers with a page or a redirect:

- `c.page(...)` replaces the page in place. To report invalid input, return
  the form again with the submitted values and an `error` on each field.
- `c.redirect(path)` opens that page of this Code; Back returns to the
  previous one.
- `c.json` or `c.text` count as done; Cloud then loads the current page again.

A failed form keeps its input and names the problem beside its button; a failed
action names it in a notification. When the answer is lost, the page says that
the step may have run. Cloud never repeats a POST by itself. Focus continues at
the first field with an `error`, or at the heading of a new page. Without
JavaScript, forms and actions submit as normal HTML forms.

`follow` lists up to eight event types, such as `grids.record.changed`, after
which Cloud loads the page again for its viewer through the same route. Several
events in a row lead to one load. While the viewer is typing in a form, Cloud
offers the new data in a notification instead of replacing their input. A
following page also loads again when its tab becomes visible. Delivery of
platform events to open pages arrives with the event service; until then only
the return to the tab reloads a following page.

A page is limited to 64 KiB, 256 blocks and 12 levels of nesting. A table has at most
200 rows and 20 columns; a form has at most 40 fields. Portable chart budgets
are eight series, 200 values per series and 1,600 marks. Request and response
limits still apply to the complete envelope.

### Where a page appears

A page appears inside the Cloud layout, like every Cloud page, in the app card
every app has from 768 px, without a sidebar. Signed-in people see it in their
workspace, with the icon bar and their apps. Visitors
who are not signed in, on a public route, see the signed-out header with the
Cloud logo and **Sign in**, as on the legal pages; signing in returns to the
page. Someone who opens a non-public page in a browser without a session goes
to sign-in and comes back to it.

Every Code page, with or without the layout, carries a small **Made with
feat/code** label at the bottom edge. Cloud draws it outside the page, so a page
cannot hide, move or restyle it. A press on it explains that someone built the
page with feat/code and warns never to enter passwords or recovery codes there.
While a page has a form, a quiet line beside the label says **Do not enter
passwords here.** without a press. The label does not name the owner. Fields
have no password or masked type and no credential autocomplete, so a page
cannot ask for passwords like a sign-in form.

`{ layout: "plain" }` on a route draws its pages alone, without the layout, for
a page you hand out. There is no setting for the whole Code; each route
decides. This public survey in personal Code files each answer as a Space task.
A public route has no visitor, so it checks something else, here the closing
date; it reads and writes with the Code's rights and shows only the form:

<!-- code-survey-example -->
```tsx
import { app, Field, Form, jsx, Notice, Option, Page, spaces } from "@sdk";

// Fictional Space ID; read the real one with spaces.space.list and keep it as a constant.
const SPACE_ID = "Spc001";
const space = spaces.space(SPACE_ID);
// The last day for answers (UTC).
const CLOSES = "2026-12-31";
const RATINGS = ["5", "4", "3", "2", "1"];
type Answer = { rating: string; comment: string };
const issue = (message?: string) => (message ? { error: message } : {});
const isClosed = () => new Date().toISOString().slice(0, 10) > CLOSES;

const survey = (token: string, answer: Answer, errors: Partial<Answer> = {}) => (
  <Page title="How was the workshop?" subtitle="Two questions, no sign-in needed" icon="ti ti-message-star" color="blue">
    <Form title="Your feedback" action={`/answer/${token}`} submit="Send">
      <Field.Select name="rating" label="How useful was it? (5 = very)" value={answer.rating} {...issue(errors.rating)} required>
        {RATINGS.map(rating => <Option value={rating} label={rating} />)}
      </Field.Select>
      <Field.Textarea name="comment" label="What should we change?" value={answer.comment} {...issue(errors.comment)} />
    </Form>
  </Page>
);
const closed = (
  <Page title="How was the workshop?" icon="ti ti-message-star" color="blue">
    <Notice tone="info" title="The survey has closed" text="Thank you for your interest." />
  </Page>
);

// Public, without the Cloud layout: the page stands alone, like a form you hand out.
// A public route never sees who is signed in: c.user is always null, also for signed-in visitors. A page that
// recognises its visitors leaves out public; then every signed-in person sees it and c.user names them.
app.get("/", c => c.page(isClosed() ? closed : survey(crypto.randomUUID(), { rating: "", comment: "" })), {
  public: true,
  layout: "plain",
});

app.post("/answer/:token", async c => {
  // The check: answers count only while the survey is open.
  if (isClosed()) return c.page(closed);
  // A changed address starts a new form.
  const token = /^[0-9a-f-]{36}$/.test(c.req.param("token")) ? c.req.param("token") : crypto.randomUUID();
  const form = await c.req.formData();
  const answer: Answer = { rating: String(form.get("rating") ?? ""), comment: String(form.get("comment") ?? "").trim() };
  const errors: Partial<Answer> = {};
  if (!RATINGS.includes(answer.rating)) errors.rating = "Choose a rating.";
  if (answer.comment.length > 1000) errors.comment = "Keep it under 1,000 characters.";
  if (Object.keys(errors).length) return c.page(survey(token, answer, errors));
  await space.task.create({
    title: `Workshop feedback: ${answer.rating} of 5`,
    ...(answer.comment ? { description: answer.comment } : {}),
    idempotencyKey: `survey:${token}`,
  });
  return c.page(
    <Page title="Thank you" icon="ti ti-message-star" color="blue">
      <Notice tone="success" title="Your answer arrived" text="You can close this page." />
    </Page>,
  );
}, { public: true, layout: "plain" });

export default app;
```

## Call operations on a handle

For a provider that declares a `workshop` Type and an `item.create` Action
with `target: "workshop"` and `idempotency: "required"`:

```ts
import { app, owner, work_shop } from "@sdk";

const destination = work_shop.workshop("workshop-finance");

app.schedule("0 8 * * 1", async () => {
  await destination.item.create({
    title: "Weekly review",
    idempotencyKey: "weekly-review:2026-11-02",
  });
}, { name: "weekly-review" });

export default app;
```

`work_shop` is the export for an application ID of `work-shop`. Hyphens become
underscores; reserved export names receive an underscore prefix, such as
`default` → `_default`. The generation manifest records the mapping.

A handle offers only operations whose `target` is its Type. An operation
without a target belongs directly to `work_shop`, such as
`work_shop.catalog.list({})`. Method paths preserve the
operation's local ID: `item.create` becomes `.item.create(...)`. A callable
method can also have child methods, such as `.keep(...)` and `.keep.release(...)`.
A resource factory can share a namespace with app methods: `customers.customer(id)`
returns a handle while `customers.customer.search(...)` calls an app Query.
The callable node carries both contracts. Generation rejects an app method whose
full path equals a factory and top-level `id` or `type` paths. A resource Type
named `app` keeps its typed `.app(id)` factory beside direct app methods.
The zero-argument `.app()` factory is removed.
Use string literals for element access, such as `core["ai"].generate(...)`;
computed keys are rejected. Keep app namespace aliases as inferred constants,
such as `const ai = core.ai;` then `await ai.generate(...)`. Resource handles and
factories can also use inferred `const` aliases. Pass handles as declared refs
into SDK calls. SDK values cannot be structurally erased through unions, type
annotations, casts or helper arguments; pass data to a helper and call the SDK
inside it. Methods themselves must stay attached to their namespace.
`owner` is the fixed resource or application handle supplied when generating
resource-owned Code. A handle grants no access: the dispatcher and the owning
application check permissions on every call.

All Code modes accept string IDs, including values from Query results and
dynamic templates. Literal IDs remain visible in checker review evidence;
dynamic ones retain only their Type there. The target checks the account's
current rights at execution. A handle or setting that names a target grants
no access.

## Read query results and follow cursors

Queries returning domain data resolve to `CodeQueryResult<T>`, with typed
`data` and optional `page` from the capability result envelope:

```ts
type CodeQueryResult<T> = {
  data: T;
  page?: { hasMore: true; nextCursor: string } | { hasMore: false };
};
```

Use `const { data, page } = await handle.list(input)`. This applies to all
Queries returning domain data, including reads and AI calls. Streaming reads
return their existing `FileRef`; Actions return their domain data directly.
Existing Code that reads Query fields directly must read them from `data` and
pull the current SDK before checking and publishing again.

For a paginated Query, pass `page.nextCursor` unchanged as the next input's
`cursor`. Stop when `page` is absent or `page.hasMore` is false. Choose an
explicit page or item budget for the task; each page consumes one ordinary
capability call from the existing per-run limit. Reaching that limit fails
with `code_call_limit`; pagination never resets it.

For example, this helper reads at most three pages from a fictional workshop
provider's `stock.list` Query:

<!-- code-query-pagination -->
```ts
import { work_shop } from "@sdk";

export default async function readStock() {
  const workshop = work_shop.workshop("workshop-finance");
  let cursor: string | undefined;
  const rows = [];
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const { data, page } = await workshop.stock.list({ cursor });
    rows.push(...data.rows);
    if (!page?.hasMore) return { rows, complete: true };
    cursor = page.nextCursor;
  }
  return { rows, complete: false, cursor };
}
```

`complete: false` lets the caller distinguish a deliberately capped read from
an exhausted list. The same envelope applies to built-in Queries such as
`mail.conversation.list` and `spaces.task.list`; their generated inputs and
domain data retain each provider's own schema.

## Supply additional targets and retry keys

If an Action declares `refs: { destination: "workshop" }`, pass another
workshop handle as `destination`. A plain ID or `{ type, id }` object does not
satisfy the handle type.

```ts
await owner.item.move({
  itemId: "item-in-owner",
  destination: work_shop.workshop("workshop-finance"),
});
```

The SDK removes ref fields from domain input and writes their coordinates into
`call.refs`. It similarly lifts an Action's `idempotencyKey` into
`metadata.idempotencyKey`. The key is required when the Action declares
`idempotency: "required"`. Actions with `idempotency: "none"` reject a key,
matching the dispatcher contract. Choose a stable key from
the business operation, such as a message ID and revision. Keys are trimmed,
contain 1–200 visible ASCII characters, and cannot contain spaces. Repeating a key
has the platform's existing 24-hour idempotency semantics.
Chat result delivery and chat turns scope their keys to one run, as described below;
other Actions retain their cross-run business-key deduplication.

Methods resolve the operation's domain `data`, typed from `dataSchema`.
Bridge refusals reject the promise; catch a failure only when the Code can
recover. Read streams return opaque `FileRef` values; write streams need a `file` input.
Other write streams, Actions marked `code: false`, and app-only Queries are
absent from the SDK.

## Choose the execution mode

| Mode | Handle IDs | `app` | `owner` |
| --- | --- | --- | --- |
| `resource` | Dynamic strings allowed | Available | Required fixed resource or app |
| `personal` | Dynamic strings allowed | Available | Absent |
| `code_run` | Dynamic strings allowed | Absent | Absent |

`code_run` uses the same operation signatures for one chat execution. It has
no schedule registrations, version or owner. The chat execution path still
asks for writing Actions as required by the normal approval policy.

## Schedule a recurring local time

For a recurring local time, declare the cron expression and an IANA time zone
on the first argument. Keep the declaration at module level and use constants,
including imported `as const` objects:

```ts
app.schedule({ cron: "0 9 * * 1", timeZone: "Europe/Berlin", name: "weekly-report" }, async () => {
  // Runs at 09:00 in Berlin, including after a daylight-saving change.
});
```

A string cron and an object without `timeZone` use UTC. The optional third
argument still supplies a readable `title` and may supply the stable `name`;
an inline `name` takes precedence. A local minute skipped by the spring clock
change does not run, and a repeated autumn minute runs once, at its first
occurrence. The checked manifest retains the declared `timeZone`.

## Run once at a chosen time

Pass an absolute date-time and an IANA time zone instead of a cron string:

```ts
app.schedule(
  { at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" },
  sendSummary,
  { name: "summary-once", title: "Send summary" },
);
```

Both fields must be constants. `at` includes seconds and `Z` or a numeric UTC offset and
selects the exact instant; `timeZone` controls its displayed local time. Cloud
never infers the machine's local zone. The handler registers when the module
loads and runs only when Core admits the due entrypoint. A changed date needs
a new checked version and activation. Keep the name to retain the automation's
identity. Manual starts remain available independently of its scheduled run.

Core admits a due one-time schedule on its next recovery pass, normally within
five seconds. It can recover it after downtime for seven days. Older dates do
not run automatically. The run has the same retry and approval rules as a cron tick. If its previous
run is queued or running, the one-time date stays pending until that run ends
or the recovery window expires. A consumed date does not run again after a restart or version
activation. The automation list shows its `at`, `timeZone`, and a null
`nextRunAt` once consumed or expired.

## Deliver a result to your Gustav chat

Personal Code can append a result to one of its owner's own active Assistant
chats through `core.ai.chat.deliver`. Discover the actual chat ID and generated
handle before writing the call:

```ts
import { app, core } from "@sdk";

app.schedule({ cron: "0 9 * * 1", timeZone: "Europe/Berlin", name: "weekly-report" }, async () => {
  await core.ai.chat("Chat23").ai.chat.deliver({
    text: "Your weekly report is ready.",
    idempotencyKey: "weekly-report",
  });
});
export default app;
```

`Chat23` is an example, not a destination to copy. Delivery appends an assistant
message and marks the chat unread; it does not start another AI turn. Cloud
keeps each delivery as its own answer. A result arriving during an interactive
turn enters model context on the next turn and survives the current turn's
compaction. Cloud
creates the existing Assistant response notification on its next recovery pass,
normally within one minute, subject to the owner's notification preferences.
Text must contain 1–10,000 characters after trimming. Use one stable effect key
per delivery: it is scoped to the current run, so retrying returns the original
message instead of appending another. Reusing that key for different text or a
different destination returns `IDEMPOTENCY_CONFLICT`.

Only personal Code can use this Action. Resource- and app-owned Code, ordinary
interactive callers, archived chats and another person's chats are refused.
The Action uses the `silent: "you"` policy and appears in the run's normal
capability call log. It performs no model inference and consumes no Code AI
budget.

## Start a Gustav turn in your own chat

Personal Code uses `core.ai.chat.run` when the task needs Gustav to choose and
use tools. Discover the owner's chat ID and the generated handle first:

```ts
import { app, core } from "@sdk";

app.schedule(
  { at: "2026-12-01T09:00:00+01:00", timeZone: "Europe/Berlin" },
  async () => {
    const run = await core.ai.chat("Chat23").ai.chat.run({
      prompt: "Review my open work and prepare a short plan in this chat.",
      idempotencyKey: "morning-review",
    });
    console.log(run.id, run.status);
  },
  { name: "morning-review", title: "Review open work" },
);
export default app;
```

`Chat23` is a fictional destination. Keep the routine's actual time zone.
For recurring routines, use `{ cron, timeZone }` to preserve the routine's time
zone. The Action accepts a trimmed prompt of
1–10,000 characters and optional `context` of at most 10,000 characters.
Context is source data, not additional authority or trusted instructions.

The result contains `id`, `chatId`, `status`, `reason` and `origin`. It returns
promptly with `queued`, `running`, `waiting_for_approval`, `waiting_for_input`,
`completed` or `failed`. A later
`core.ai.chat("Chat23").ai.chat.run.read({ id: run.id })` reads one current
snapshot. Finish the Code run when approval is needed; the owner decides in
the chat, and the ordinary chat worker continues the same turn. Do not poll
until the owner answers. A busy chat returns `chat_busy`; try a later schedule
or manual run after its current turn ends.

Only the personal Code owner may target their own active chat. Sharing Code
with a reader grants no chat authority. Resource- and app-owned Code cannot
start these turns. Each turn uses the owner's current model grants, tools and
approval rules, without passing the Code mandate to its tools. Billable
inference charges actual usage to the owner's normal interactive Assistant allowance,
with no flat Code attempt debit. Existing daily Code USD limits include that
actual cost; normal model step
and turn time limits still apply. The chat and run show “Started by Code
{name}” (or “Gestartet von Code {name}”). The invoking Code keeps its ordinary
capability call log.

One stable key identifies one intended turn in a Code run. Repeating it recovers
the original turn, even after its allowance is exhausted; the admission reply
may be replayed. Read `ai.chat.run.read` to get the current state.
Changing the prompt, context or destination under that key returns
`IDEMPOTENCY_CONFLICT`. A new run can use the same key for its next occurrence.
See [chat turn capability](/en/docs/platform/capabilities#start-personal-code-chat-turns)
for the daily admission cap and budget error codes.

## Name an automation

Give a schedule a stable name for manual execution and an optional readable
title in its third argument:

```ts
app.schedule("0 8 * * 1", weeklyReview, {
  name: "weekly-review",
  title: "Weekly review",
});
```

`title` is optional. It is trimmed, must contain 1–200 characters, and must be
one line of plain text without HTML markup or control/format characters.
Cloud displays it as escaped text. Declare a constant title; imported options
need literal types, for example `as const`. The title appears wherever people
see the automation; without one, Cloud shows its identifier. Changing a title
creates a new checked version with the usual review and activation rules.
Titles need not be unique; the stable name identifies the automation.

Names contain letters,
digits, dots, underscores or hyphens, start with a letter or digit, and must be
unique in the module. Keep the name across versions to identify the same task.

## React to resource events

Resource-owned Code can register a declared automation event at its own place:

```ts
import { app, owner } from "@sdk";

app.on("inventory.item.changed", async (event) => {
  // event.subject identifies the changed item; event.place is this Code's owner.
  // Read current data through the SDK before deciding what to do.
});
```

Use an event actually offered by the generated SDK. `app.on(owner, event, handler)`
is the explicit form. The event name and place must be constants at module level.
Only one handler per event is allowed. Personal Code and app-owned Code cannot
subscribe. Events without a place, events at another place, and declarations
with `automation: false` cannot start this Code.

The handler receives the typed reference envelope: `id`, `type`, `version`,
`source`, `time`, `subject`, `place`, optional `cause`, and `data`. Data stays
reference-only; the event grants no access to the referenced resource. Cloud
checks the Code account's current read permission at the place before admitting
a run. Actual SDK calls still check their current target permissions.

Checking records the exact event version and owner place in the immutable
manifest. Activation installs those subscriptions with the approved version's
execution mandate. The stable entrypoint is `event:<event-type>@<version>`.
See [Code runs](/en/docs/platform/code-runs#understand-event-deliveries) for
pause, replay, deduplication and queue behavior.

For an incoming-mail pattern, ordered helper functions, catch-up and real-message
preview, see [Mail automations with Code](/en/docs/platform/mail-code-automations).

## Serve routes

Resource-, app-owned and personal Code can register routes. Register routes at
module scope with literal paths. Core hosts the active, approved version at
`/code/<code-id>/…`:

```ts
import { app } from "@sdk";

app.get("/hello/:name", c => c.json({
  hello: c.req.param("name"),
  visitor: c.user?.id,
}));
app.get("/health", c => c.text("Ready"), { public: true });
app.post("/save", async c => {
  const input = await c.req.json();
  // Validate input and perform any authorized SDK calls here.
  return c.redirect("/hello/saved");
});
```

`get`, `post`, `put`, `delete` and `all` accept a handler and optional
`{ public: true | false, layout: "plain" }`; `layout` is described in
[Where a page appears](#where-a-page-appears). Paths contain literal segments and named parameters
such as `:id`; declarations match in order. `HEAD` uses the GET handler.
Handlers return `c.json(value, status?)`, `c.text(text, status?)` or
`c.redirect(path, status?)`. Redirects stay inside this Code's namespace;
`/next` resolves to `/code/<code-id>/next`. Code cannot return arbitrary headers,
cookies or HTML. `c.req` provides `raw`, `param(name)`, `query(name)`, `json()`,
`text()` and `formData()`. Core forwards only the request data, never browser
cookies or credentials.

Personal Code runs its routes with its owner's mandate, like its schedules. Its
non-public routes therefore open only for that owner; any other signed-in person
receives `403` with `code_owner_only`. Public routes of personal Code follow the
same rules as below and still run with the owner's mandate, so return only what
any visitor may see.

Routes require a signed-in person's session by default, including guests.
Check `c.user` in the handler when access depends on the visitor:

```ts
type CodeUser = {
  id: string;
  groups: string[];
  kind: "user" | "guest";
  provider: "local" | "ipa";
  name: string;
};
```

`id` is the Cloud user ID, `groups` contains effective group IDs, `kind` is
the account profile and `name` is the display name. `provider` is the stable
identity provider ID (`ipa` means FreeIPA), never a token, session ID or
provider configuration. Cloud currently has no OIDC sign-in provider ID.
Agents and other service accounts cannot visit private pages and are never
projected into `c.user`. `CodeWebhookContext` has no `user` field; webhook
registration remains unavailable.

Public routes never see who is signed in. To recognise visitors, leave out
`public`; then every signed-in person sees the page.

Public routes also require the `public_routes` policy classification and version-bound
administrator approval by default. Existing policy tables initially forbid this new
classification until an operator chooses its rule. Public routes require the literal `{ public: true }` in the checked
version and always receive `c.user === null`, including for signed-in visitors.
There is no platform audience or implicit access to underlying resources.
SDK calls retain the Code's execution principal and its existing grants;
the visitor's grants never become data authority.

POST, PUT and DELETE need a session-bound CSRF token. Read `X-Code-CSRF` from
a preceding GET response and send it as the same header, retaining the cookie.
URL-encoded forms may submit it as `_csrf`; Core removes that field before
dispatch. Public forms use a separate HttpOnly cookie when no session exists.
A token from another session or another Code is refused.

Requests share runner slots and Code concurrency limits. Their eight-second
budget includes queueing; busy admission returns 503 and a deadline returns
504. Mutations are never automatically retried. JSON, plain text and
URL-encoded bodies are supported, up to 8 KiB (4 KiB for public routes).
Responses are at most 128 KiB. Public requests share a 20-per-minute limit per
client network and per Code. The Code page lists route entrypoints and their
last results; request runs appear in Runs with their timing and capability
calls. Visitor input and response payloads are transient.

## Recognize later-phase APIs

`nav` and `fetch` registrations still report Phase 2; `webhook`
reports Phase 3. The runtime refuses these registrations too. Eligible event
payloads come from event schemas; events with `automation: false` are absent.

## Generate and host an SDK

Platform tools import `generateCodeSdk` from `@k2b/cloud/code`:

```ts
import { generateCodeSdk } from "@k2b/cloud/code";

const sdk = generateCodeSdk(manifests, {
  mode: "resource",
  owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "workshop-owner" } },
});
```

Supply the current validated `CapabilityManifest[]`. Write `sdk.declarations`
as `sdk.d.ts`, `sdk.runtime` as `sdk.js`, and resolve `@sdk` to that pair in
the checker and bundler. Both generated files are standalone. JSON Schema
shapes become structural TypeScript; constraints such as string lengths
remain validated by the dispatcher. Local schema references are supported;
unresolved or external references fail generation.

`GeneratedCodeSdk` contains a version-1 `CodeSdkManifest` with:

- `apps`: module export names and originating manifest hashes;
- `handles`: target Types, factory property paths and app export names;
- `operations`: qualified IDs, method paths, targets, refs, input/data schemas,
  schema hashes and idempotency policy;
- `events`, `omitted`, and `appMethods`: eligible events, excluded operations
  and the phase required by each app method;
- `mode` and optional `owner`: the execution mode and fixed owner.

The checker uses these paths with the user's source to resolve handle literals and
permissions. This generation manifest is not a checked version manifest or
an authorization grant. `codeSdkPhaseDiagnostic(method)` returns the shared
unavailable-phase diagnostic so the checker can attach a source location.

The runtime exports an internal `__codeSdk` control object for the trusted
host. Import the SDK and bind it once **before evaluating the user module**
with `__codeSdk.bind(cloud)`, where `cloud` satisfies
`CodeSdkBridge`. Each method calls `cloud.call(capability, invocation)`.
`CodeSdkInvocation` separates the canonical `NormalizedCapabilityCall` in
`call` from transport metadata in `metadata`; hash only `call` with
`capabilityCallDigest`. The bridge resolves domain data and throws on refusal,
matching the runner's `cloud.call(operation, input)` seam. It attaches run
identity and credentials outside the sandbox. The checker must reserve
`__codeSdk` for the host and reject imports of it from user code; hiding it
from declarations alone does not enforce that rule.

`__codeSdk.entries()` returns schedule and route descriptors. Schedules carry `kind`, `cron`, optional `at` and `timeZone`, and
an `entrypoint` equal to the explicit schedule name, plus `title` when declared. For unnamed schedules,
entrypoints use registration order (`schedule:0`, `schedule:1`, …); these are
version-local and change when registrations are reordered.
Registration does not execute callbacks. The checker must import Code once
to collect its registrations. Core uses those descriptors to schedule work;
the trusted bundle wrapper invokes
`__codeSdk.run(entrypoint)` for the selected callback. The one-shot host binds
the bridge and executes its Code directly instead.

`CodeSdkOptions`, `CodeSdkOwner`, `CodeSdkOperation`, `CodeSdkHandle`,
`CodeSdkInvocation`, `CodeSdkCallMetadata`, `CodeSdkBridge`, and
`CodeSdkPhaseDiagnostic` are exported with doc comments for checker, test-kit,
CLI and chat consumers. The SDK imports no database, broker, storage or
credential clients.

The [Code checker](/en/docs/platform/code-checker) consumes this generation
manifest to produce the immutable `CodeVersionManifest`, source locations,
permission changes, and the runner's ESM bundle.

## One-off chat runs

Gustav's one-off `code_run` compiler supplies the same `generateCodeSdk` output
with `mode: "code_run"` and executes it in the Code runner's isolated workerd
runtime. It binds normalized targets, refs and idempotency metadata to the
current person's Assistant turn, preserving capability access checks and
approvals. It does not create a lasting Code, version or version mandate.
The host admits only operations and target/ref Types from the authorized
catalog captured for that run. Calls outside it fail with
`code_capability_undeclared`; actual Actions still follow the turn's approval
flow. This also applies to raw `cloud.capabilities.run` calls.
SDK Queries return `{data, page?}`; read fields from `data` and follow the
returned cursor when `page.hasMore`. Streaming reads return `FileRef`, and
Actions return domain data directly. The older `cloud.capabilities.run` keeps
returning its capability envelope. This mode has no `app` or `owner`,
and accepts dynamic IDs. The host also exports its existing `cloud.sheet`
helpers as `sheet` from `@sdk`. Other package imports remain unavailable.
`http` and `secrets` use the person's existing chat HTTP approvals and secret
bindings. Secret values remain in the Assistant host. Files, views, progress,
logs, return values and script errors keep their chat result format.

Pass a streaming read's `FileRef` to the `file` argument of a file-input write
Action in the same run. The host transfers the bytes and returns the completed
Action data. A destination may choose its own upload name. Files above the
destination's declared byte limit are refused before preparation or approval.
Each reference can be used for one write attempt. The usual Action review and
approval still apply. File bytes stay outside the script bridge.
One-off runs allow 50 MiB per file and 250 MiB of
stream transfers in total, counting both the read and the upload. After an
interrupted write, inspect its status before attempting another import.

One-off runs share runner capacity and use its fixed wall-clock, memory and
bridge budgets; see [One-off chat jobs](/en/docs/platform/code-runs#one-off-chat-jobs).
Scheduled chat routines are retired. Rebuild timed work as reviewed personal
Code with `app.schedule` and `core.ai.chat.run` or `core.ai.chat.deliver`.
Routine grants do not transfer. Studio RSQL `database` grants are unavailable in
runner `code_run`. Chat accepts inline `code` and optional `inputPaths` only;
saved script `id`, published `version`, and Studio `resourceId` contexts are
rejected. App KV/files storage is also unavailable; use chat or Project files.
Use an application's permission-aware capabilities for application data.
There is no automatic replacement database or grant migration.

See [Gustav Code tools](/en/docs/platform/gustav-code-tools) for a one-call CSV
example and the lasting-Code workflow.

The existing `cloud.capabilities.run(name, input, options?)` also accepts explicit
normalized `target`, `refs` and `idempotencyKey` in its optional third argument.
A key is allowed only for an Action declaring required idempotency; retain it
for retries of the same effect. Omitting it preserves the existing per-call
key. Scripts keep the same permissions and approvals.


## Mail triage: category first

Discover `core.ai.decide` in the live SDK before using it. It is a read-only query
and returns typed answers with probabilities, plus model and usage. The checker
marks this call as **AI** (**KI**); the Cloud-Admin policy controls release.
The caller's person or service account pays from its own AI allowance.

Ask category first. Ask urgency together with category or after it, never alone.
This one-off `code_run` example returns a review flag only for confidently
classified support messages. Urgent spam stays outside that category. Thresholds depend on the cost
of mistakes; probabilities are estimates. The example changes no records.

<!-- ai1-mail-triage -->
```ts
import { core } from "@sdk";

export default async function triage() {
  // Fictional mail; in real Code, read the mail through its authorized SDK first.
  const { data: result } = await core.ai.decide({
    task: "mail.triage",
    state: { subject: "Urgent: claim your prize", text: "Act now to receive a prize." },
    questions: {
      category: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: { support: "Help with an existing order", spam: "Unsolicited advertising or deceptive messages" },
      },
      urgent: { type: "noul", instructions: "Does this message need urgent attention within its category?" },
    },
  });
  const category = result.answers.category;
  if (category?.type !== "choice" || category.choice !== "support" || category.confidence < 0.9) return false;
  const urgent = result.answers.urgent;
  return urgent?.type === "noul" && urgent.probability >= 0.9;
}
```

For lasting Code, save this function in a helper module and call it from a
schedule. Schedule callbacks return `void`; use the flag inside the callback
when deciding whether a separate authorized action is appropriate.

Optional `files: FileRef[]` and `model: { id }`, image support, quota
failures and byte limits follow
[Typed decision questions](/en/docs/ai/structured-and-background-ai#ask-typed-decision-questions).


## Generate text and extract fields

Discover `core.ai.generate` in the live SDK. It is a query classified
as **AI / KI**, using the caller's allowance and Code's execution budgets.
Use it for summaries, draft text or validated extraction. Put source data in
`input` and trusted instructions in `prompt`.

<!-- gate-1a-generation -->
```ts
import { core } from "@sdk";

export default async function summarize() {
  // Fictional source; read real mail through its authorized SDK first.
  const input = { body: "Please deliver three chairs by Friday." };
  const { data: summary } = await core.ai.generate({
    task: "mail.summary",
    prompt: "Summarize the message in one sentence.",
    input,
    model: { class: "fast" },
    output: { type: "text", maxChars: 500 },
  });
  const { data: extracted } = await core.ai.generate({
    task: "mail.extract",
    prompt: "Extract the requested item and quantity from the message.",
    input,
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          item: { type: "string", maxLength: 100 },
          quantity: { type: "integer" },
        },
        required: ["item", "quantity"],
        additionalProperties: false,
      },
    },
  });
  return { summary: summary.output, extracted: extracted.output };
}
```

The generated SDK types describe the request and JSON result. A schema supplied
at runtime cannot become a compile-time TypeScript shape; narrow `output`
before reading its fields. Cloud validates the declared schema before returning
it. For lasting Code, call this helper from a schedule; its callback returns
`void`. Summarizing or drafting does not send or save anything. A separate
application capability performs that effect under its own permissions.

See [Text and JSON capabilities](/en/docs/ai/structured-and-background-ai#generate-text-and-extract-json-through-capabilities)
for schemas, size limits, model selection and stable errors.


## Run a model loop with SDK tools and files

`core.ai.generate` accepts `tools` containing generated SDK methods. Use a
literal list such as `tools: [mail.attachment.read,
mail.mailbox("Mbx001").conversation.search]`. The first tool takes business
input from the model; the second stays bound to that mailbox. Only genuine
SDK methods work. Method aliases, wrapper functions, strings and manually
constructed descriptors are rejected. Methods requiring additional resource
handles are unavailable as tools.

The checker includes every possible tool capability and bound target in the
version's permissions and approval evidence. Each actual call follows the
normal bridge: the Code account, current grants, policy, version approval and
call log all apply. Actions with `ask` policy remain forbidden. Other declared
Actions can change domain records, so choose the tools deliberately.

Pass `files: FileRef[]` to `core.ai.generate` or `core.ai.decide` to read files
before inference. The Code decision capability no longer accepts base64
`images`. Obtain refs from ordinary read-stream operations, for example
`const file = await mail.attachment.content.read({ id: "Att001" })`. Bytes stay
outside Code and its bridge payload. Obtain a fresh ref for another AI call;
redemption is single-use and the byte cache lasts for one call only.

A generate loop automatically offers `view_image` and `read_file` once refs
appear in `files`, `input` or SDK tool results. They accept only those exact
refs. Set `fileTools: false` to disable viewer tools; initial `files` still
load. The owning app reads as the run's account and can refuse with a visible
403. Both initial files and viewers use one reader.

Models with vision receive image pixels and rendered PDF pages directly.
Text-only models use a separately charged vision description. Each PDF look
defaults to the first 20 pages, reduced to fit the model context and rendered byte budget. Explicit
selections accept at most 20 distinct one-based pages. An AI call loads at
most 16 files: images and PDFs up to 10 MiB each, other documents up to 20 MiB,
with 40 MiB source and visual byte budgets. `read_file` returns UTF-8 chunks
of at most 64 KiB. Viewer calls and source reads consume the existing Code
call budget; all model turns and fallback descriptions share the Code AI
reservation and deadline, including the ordinary 45-second capability query
window. File contents and tool results are untrusted data.

JSON output supports lists with a required `maxItems`, bounded by the
100,000-byte output limit. Items may be scalars or strict objects of scalar
fields; nested lists are rejected. A schema can therefore return invoice
lines or totals per tax rate while retaining `additionalProperties: false`
and the existing string bounds.
