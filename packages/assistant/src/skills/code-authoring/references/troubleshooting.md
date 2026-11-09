# Troubleshooting

Diagnostics carry a stable `code`, a message (German in this release), and a
one-based `file`, `line` and `column`. Fix the cause; never suppress type
errors (`code_type_suppression`).

## Check errors

| Code | Cause | Fix |
| --- | --- | --- |
| `TS2322` and other `TS…` codes | A wrong prop, input field or type | Read the operation or block type in `sdk.d.ts` and match it exactly |
| `code_page_child` | A part outside its block, another block among parts, or text inside a block with parts | Put `Field.*` in `Form`, `Option` in `Field.Select`, `Stat` in `Stats`, `Column` in `Table`, `Item` in `Detail` ([Pages](pages.md)) |
| `code_import_forbidden` | Import of a package, `bun`, `@k2b/cloud`, an absolute path or a dynamic import | Import only `@sdk` and relative project files |
| `code_reserved_sdk` | `import * as sdk`, re-exporting the SDK or using `__codeSdk` | Import named exports from `@sdk` |
| `code_unresolved_call` | The checker cannot see which operation a call reaches | Call SDK methods directly on a typed handle |
| `code_detached_sdk_method` | A method taken off its handle, or `.call`/`.apply`/`.bind` | Call it on the handle |
| `code_unresolved_ref` | An extra target (`refs`) is not a handle of the declared type | Pass a handle such as `spaces.space(id)` |
| `code_stream`, `code_app_only`, `code_code_false` | The operation is not available to Code | Choose another operation ([Capabilities](capabilities.md)) |
| `code_unresolved_call` | An unrecognized call, computed SDK property key, or an SDK value whose type was erased | Call the SDK directly, or use literal property keys and inferred `const` aliases; pass data to helpers and handles as declared refs into SDK calls |
| `code_no_entrypoint` | No schedule, route or event handler | Add `app.schedule`, a route or `app.on` at module level |
| `code_static_schedule`, `code_invalid_cron`, `code_duplicate_schedule` | Timing not constant, invalid cron, a repeated name | Use constants and unique names ([Schedules](schedules.md)) |
| `code_static_title` | A computed or invalid schedule title | One line of constant plain text, 1–200 characters |
| `code_static_route`, `code_duplicate_route` | A route declared inside a function, or twice | Declare each route once at module level with a literal path |
| `code_dynamic_event`, `code_event_owner`, `code_static_event`, `code_duplicate_on` | Event not constant, not at this Code's own place, not at module level, or a second handler | One `app.on` per event in the owning resource's Code ([Events](events.md)) |
| `code_http_origin_dynamic`, `code_http_origin_invalid`, `code_http_allow_literal` | A computed or invalid HTTPS origin | Use literal URLs or a literal `http.allow([...])` |
| `code_http_grant_limit` | More than 50 origins and operations together | Reduce the destinations |
| `code_import_elided` | Imports changed between analysis and bundling | Check the imports and check again |
| `code_phase_unavailable` | `app.nav`, `app.fetch` or `app.webhook` | Not available yet; say so |
| `code_check_time_limit`, `code_job_busy` | The checker was busy or slow | Check again later |

## Submit and switch-on errors

| Code | Cause | Fix |
| --- | --- | --- |
| `code_version_conflict` | Someone submitted after your base | `code_pull`, reconcile the comparison, check, submit with the new base |
| `code_unattended_forbidden` | The version calls an Action that asks a person | Remove the call; use a silent Action or leave the step to a person |
| `code_sends_not_yet` | The version sends mail or another message unattended | Create a draft instead |
| `code_policy_never` | The installation's policy forbids a used class | Remove that call or ask a Cloud administrator about the policy |
| `approval_pending` (switch-on readiness) | A Cloud administrator has not approved the version | Wait for the approval |

## Run errors

A run lists its calls in order with their results. A refused call rejects
with an error whose message is the stable code.

| Code | Meaning | What to do |
| --- | --- | --- |
| 403 or 404 from the target app | The account lacks access, or the object does not exist | Ask the resource's manager to share it with the service account; check the ID |
| `code_approval_required`, `code_approval_revoked` | The version is not approved (any more) | A Cloud administrator approves it |
| `code_admission_refused` | A schedule tick was refused by policy or approval | As above |
| `code_not_active` | A newer version became active before the run started | Nothing; the new version handles later work |
| `code_wall_clock_limit`, `code_call_limit`, `code_rate_limited` | A run budget is spent | Bound the work ([Data](data.md)) |
| `code_ai_budget_limit`, `code_ai_budget_reserved`, `code_ai_daily_budget_limit`, `code_ai_owner_daily_budget_limit` | An AI budget is spent or busy | Wait for the next day or fewer AI calls; a rerun does not reset the daily budget ([AI](ai.md)) |
| `code_http_origin_undeclared`, `code_http_redirect_limit` | An undeclared origin or more than 20 redirects | Declare the origin; use the final URL |
| `code_page_data_only`, `code_page_limit` | A page holds a function, an accessor or a hole in a list, or is too large | Pass plain data; stay within the page limits ([Pages](pages.md)) |
| `code_file_invalid`, `code_file_size_limit`, `code_file_spent` | A FileRef from another run, expired, changed, too large or already used | Read a fresh reference in this run right before the import ([FileRef](file-ref.md)) |
| `code_result_unknown` | A call's outcome is unknown after a lost attempt | Inspect the target before running again |
| `IDEMPOTENCY_CONFLICT` | The same key with different input | Derive the key from all of the effect's input |
| `chat_busy` | The Gustav chat is in another turn | Try at a later schedule |
| **Skipped, previous run is still running** | A tick overlapped the previous run | Make the run shorter or the schedule rarer |
| `previous_schedule_running` | Same as above, as a stable outcome | As above |

**Run again** re-runs a failed run with the active version and may repeat
effects; read the recorded calls first. **Retry delivery** is for an event
that never started a run.

## Test errors

| Code | Cause |
| --- | --- |
| `code_test_missing_mock` | A call has no matching mock |
| `code_test_ambiguous_mock` | Two mocks match equally |
| `code_test_mock_exhausted` | More calls than replies |
| `code_test_invalid_input`, `code_test_invalid_fixture` | Call input or reply data does not match the schema |
| `code_test_invalid_idempotency` | A key is missing where required, or given where none is allowed |
| `code_test_missing_entrypoint` | The run names an entrypoint the version does not have |
| `code_event_input` | An event run's `input` is not an envelope for this event and place |
