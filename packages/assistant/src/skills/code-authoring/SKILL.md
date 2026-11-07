---
name: code-authoring
description: Build or edit lasting Cloud Code, including schedules and resource-owned automations. Use for code.ts, checking permissions, fictional tests, simulation and submitting an immutable version for human activation. One-off analysis or CSV exports use assistant-code-mode and code_run.
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

Studio HTML apps retain `code_create` and the existing `code_read/write/check`
inputs with `id`, revision and screenshots. Load `assistant-code-mode` for them.


## Rebuild an Assistant routine

Ask for or retain the routine's IANA time zone. Declare recurring timing at
module level as `app.schedule({ cron, timeZone, name }, handler)` with constant
values; a cron string without a zone runs in UTC. Spring-forward gaps skip the
missing local minute, and repeated autumn minutes run only once.

For a result in the person's Gustav chat, use personal Code. Discover the owned
chat and `core.ai.chat.deliver` through the live SDK. The generated call is
`core.ai.chat(chatId).ai.chat.deliver({ text, idempotencyKey: "result" })`. Keep the
effect key stable within a run; Core scopes it per run. The result text is
1–10,000 characters after trimming. Delivery appends an assistant message and
queues the existing response notification without starting an AI turn. Another
person's chat, an archived chat, or resource/app Code cannot receive this
personal delivery. Do not substitute `ai.chat.message`, which requires an
interactive AI turn. Test the delivery with fictional SDK replies before
submitting, and retain the original routine until the person accepts its rebuild.

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
