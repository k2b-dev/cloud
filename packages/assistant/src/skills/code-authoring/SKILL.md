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
   stable names. Required action idempotency keys describe the intended effect
   so retries use the same key. `code_write({project,path,content})` returns
   a complete replacement project. Retain it for the next write. These drafts
   stay in the chat until submit; pull retrieves the last submitted version.
4. Send `{codeId,files,entry}` to `code_check`. Read diagnostics and permissions,
   including file/line, target, new/existing, own and needsTargetAdmin. Explain
   the consequences. Fix errors before continuing. Resource Code uses literal
   target IDs, not dynamic IDs or computed handles.
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
