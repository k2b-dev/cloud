---
name: code-authoring
description: Build or edit lasting Cloud Code, including schedules, pages and resource-owned automations. Use for code.ts and code.tsx pages, checking permissions, fictional tests, simulation and submitting an immutable version for human activation. One-off analysis or CSV exports use assistant-code-mode and code_run.
load-tools: [code_init, code_pull, code_sdk, code_write, code_check, code_test, code_simulate, code_submit, code_diff]
---
# Build lasting Code

Load these tools through `load_tools` if they are unavailable. Keep each tool's
versioned JSON result intact; these are the same contracts as `cld code`.

1. For existing Code, `code_pull({codeId})` returns the complete project.
   For new Code, `code_init({title, owner?})` returns an initial project;
   omit owner for personal Code. Creating Code at an owner requires its admin.
2. `code_sdk({codeId})` returns the live generated `@sdk` contract. Discover
   the requested operations; use their actual handle, input and result types.
   No guessed operations or resource IDs. A Space task can omit `columnId`;
   it goes into the first open column.
3. Write `app.schedule` in `code.ts`, default-exporting `app`. Give schedules
   stable names and a short human title next to the name, for example
   `{ name: "weekly-review", title: "Weekly review" }` in the declaration options.
   Required action idempotency keys describe the intended effect
   so retries use the same key. `code_write({project,path,content})` returns
   a complete replacement project. Retain it for the next write. These drafts
   stay in the chat until submit; pull retrieves the last submitted version.
4. Send `{codeId,files,entry}` to `code_check`. Read diagnostics and permissions,
   including file/line, target, new/existing and own. Explain the consequences.
   These rows are non-binding review evidence; dynamic IDs are allowed. Target
   apps check current account rights on each call. Fix check errors before continuing.
5. Add declarative `test/NAME.json` fixtures with a fixed `now` (Unix ms),
   integer `seed`, explicit fake replies in `mocks`, and named `runs`.
   Send fixtures separately as `tests` to `code_test`; they are never real
   actions. `code_simulate` accepts one fixture with exactly one run.
6. Submit `{codeId,files,entry,baseVersionId}` using the unchanged base from
   pull/init. `code_submit` saves a checked immutable version. Use `code_diff`
   with its version ID to inspect changes. Say that the version is submitted
   and the person must review and activate it in the UI or CLI.

Never activate Code or change its access. All authoring tools require current
Code editor rights, including reads of resource-owned Code. They are for an
interactive chat, not a background task. On a version conflict, pull, reconcile
the complete comparison and recheck; never replace the base just to force a
submit. After an uncertain write, pull before trying again. A failed runner
job is a visible failure; do not claim the source passed.

## Pages

Resource-owned Code starts with `code.tsx`, a page built from SDK blocks
(`code_init` returns one). Compose blocks as TSX; never write the page as an
object. Data, such as `rows` or chart `data`, is a prop; a block's parts are its
children: `Field.*` in `Form`, `Option` in `Field.Select`, `Stat` in `Stats`,
`Column` in `Table`, `Item` in `Detail`. Charts are `Chart.Bar`, `Chart.Line`
and the other kinds with their data as props; `Chart.Empty` holds a chart's
place without data. `code_check` reports a wrong prop as a type error and a
misplaced part as `code_page_child`. Forms and buttons POST to an own route
(`app.post`), which answers with `c.page(...)` or `c.redirect(path)`.

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

Studio HTML apps retain `code_create` and the existing `code_read/write/check`
inputs with `id`, revision and screenshots. Load `assistant-code-mode` for them.


## Mail triage: category first

Discover `core.ai.decide` with `code_sdk` and use its generated handle. It is a
query, with no dedicated tool or binding. It charges the calling person or Code
service account's AI allowance. The checker marks it as KI/AI; the Cloud-Admin
policy decides version approval. Images depend on both provider and model and
must fit the capability byte limit.

Ask category first. Ask urgency together with category or after it, never alone.
Check category before interpreting urgency: urgent wording in spam does not make
it urgent support. Use fictional fixtures for tests, including urgent spam and
urgent support. Choose thresholds for the cost of mistakes. This example reads
only and returns a review flag; any later effect is a separate authorized call.
The module below can run once through `code_run` (load `assistant-code-mode`).
For lasting Code, save it as a helper and call it from a schedule. Schedule
callbacks return `void`; use the flag inside the callback to decide any later action.

<!-- ai1-mail-triage -->
```ts
import { core } from "@sdk";

export default async function triage() {
  // Fictional mail; in real Code, read the mail through its authorized SDK first.
  const result = await core.app().ai.decide({
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
