# Assistant artifacts and workspace

## Agreed scope

Keep Kit unchanged. Build an independent Assistant implementation by selectively
copying its worker, UI protocol and renderer. Generated application code stays in
a terminable worker behind an opaque-origin bridge. No generated DOM code runs in
the Assistant thread. Headless programs use the same runtime without creating UI.

Use `ui.button()` and other short namespaces instead of global `UIButton()`
constructors. No `kit` compatibility namespace. Improve list actions so authors
declare actions once and receive the current item, without allocating handles per
refresh. Preserve set/upsert/remove semantics.

The right-hand workspace supports tabs for apps and ordinary files. Use fixed
AppWorkspace peer regions, with one tab group inside the artifact region. Preserve
mounted state across tab changes and use a mobile chat/workspace switch. Closing a
tab never deletes its resource. Code execution is explicit; reopening after a full
reload does not run programs automatically.

Artifacts own immutable source revisions and permissions independently of chats.
Chat references do not cascade resource deletion. Every run targets a revision.
Keep selected input files separate from source files and authorize them through the
existing file ownership contract. Never expose host credentials to generated code.

No SQL integration, Markdown app pages, separate app administration, or additional
end-user help in this implementation. Ordinary Markdown file previews remain.
Provide a built-in developer skill with targeted API references and runnable
examples instead.

## Execution and agent loop

Reuse the existing Assistant frontend-tool transport. Add bounded run, inspect,
interact and stop operations and source operations. Isolate agent test runs from
the visible user's working run. Return structured errors and diagnostics. Track
call identity so reconnection cannot silently replay effects. Handle browser
absence, navigation, cancellation and expiration explicitly. Browser execution
requires a connected client; no background server sandbox is promised.

Reuse the existing bounded protocol and validate all messages at the host boundary.
Bundle UI updates and enforce runtime/log/output limits. Generated code must not
bypass Capability authorization or approval through a host bridge.

## Implementation sequence

1. Commit existing Assistant/audio work and its platform dependencies.
2. Establish independent artifact contracts, storage, permissions and compiler.
3. Copy and adapt worker/renderer; add ergonomic actions and headless results.
4. Integrate tabbed workspace and ordinary file previews/editing.
5. Add agent execution/interaction/diagnostic tools and developer skill.
6. Verify real browser and database boundaries, refresh services and review diff.

## Acceptance

- CSV analysis returns a file without UI; interactive analysis renders table/chart.
- Agent detects and repairs syntax/runtime/interaction errors without user relay.
- A runaway worker can be stopped while the Assistant remains usable.
- Tab switching preserves input and focus; reload restores selection, not execution.
- Independent artifact ownership, revisions and permissions hold across API paths.
- Host shell strings are localized; generated app strings remain author-owned.
- No edits to Kit or unrelated parallel work; new implementation remains uncommitted
  until requested separately.

## Progress

Existing Assistant/audio changes committed as `e08f4c64c`. Focused tests: 33 passed;
Assistant and Cloud typechecks passed. Live audio/provider acceptance was not rerun
for this checkpoint commit. Independent artifact implementation is in progress.

### Live verification checkpoint

The built-in code-mode template is generated from the Assistant Markdown skill;
its snapshot/reference tests pass. Workspace source selection is available before
execution. Chat files open in workspace tabs with editing and dirty-draft refresh
protection. Latest focused checks: Assistant typecheck, 4 worker/workspace tests
(35 assertions), and 6 skill/template tests (371 assertions) passed.

Live test chat: `9eyz7h` (Code Mode E2E Workspace). No message or run was created.
The browser displayed the workspace shell but input disappeared and subsequent
navigation intermittently returned 502. A direct artifact API read returned 200
in 479 ms; the authenticated Assistant page took 11,331 ms. Do not count this as
a completed user journey.

`dev:restart --running` stopped at Grids: `gql.context` contained a transform
that cannot be represented in JSON Schema. This is parallel work, left untouched.
Assistant and Core had restarted successfully before that failure. The capability
service subsequently logged a registry lease timeout/restart, and the live
`assistant.artifact.list` capability request returned INVALID_APP_RESPONSE.
Recheck service and registry health before repeating the full browser/agent test.
Remaining running restart services were not automatically retried.

### Offline browser and production checks

Verified the real ArtifactWorkspace/FileView components in Chrome with a local
fixture API: Source opens before any compiled/run request; both source files are
selectable; changing main.js from 42 to 99 survives switching to the app tab and
back, and the workspace still reports an unsaved draft. Evidence:
`/tmp/assistant-workspace-isolated.log` and screenshot
`/tmp/assistant-workspace-isolated.png`. This does not replace the live chat test.

Worker recovery now clears a previous action error only after a successful next
action, while retaining diagnostic logs. Real-worker browser test: 28 assertions.
The production compiler/build-extras test confirms the bundled server loads its
adjacent worker asset with NODE_ENV=production (3 compiler tests, 9 assertions).
Money and handle-update references are now included; skill/template checks pass
(7 tests, 374 assertions). Refresh the installed built-in template after the final
document changes; the first development seed predates these reference additions.

The latest live failure is JetStream system temporarily unavailable during app
startup. Assistant and capability routes return 502. No infrastructure mutation
or data reset was attempted.

### September 11: source editor and live acceptance checkpoint

The source FileView now uses the standard syntax-highlighted editor without
autocomplete, with bounded Undo/Redo and the save shortcut. The themed browser
check exposed a collapsed editor height; making each workspace tab a flex column
and allowing the source renderer to grow fixes it. The permanent
`workspace.browser.test.ts` covers draft/history preservation across tabs,
canceling a dirty close, mobile height and horizontal overflow, selection after
reload, and no automatic compilation/start (10 assertions). The test loads the
actual UI styles under the required `k2b-ui` scope. Earlier unthemed screenshots
proved behavior only, not the rendered layout.

Focused artifact checks: 17 tests / 77 assertions; workspace browser: 1 / 10;
skill/template: 7 / 374. Assistant and Cloud typechecks, dependency policy (30
workspaces), and diff whitespace checks pass. The built-in template is version
2 so normal seed reconciliation can update an unchanged development version 1;
live installation is not yet verified.

The live stack briefly served authenticated Assistant requests successfully.
Browser navigation tracing then showed repeated complete dev-client reloads,
which explains disappearing composer input. Disable dev auto-reload only in the
isolated acceptance browser (`window.__ssr_reload = true` before page load).
Subsequent attempts fail with ECONNRESET / ERR_EMPTY_RESPONSE before the page
loads. Docker health reporting ready does not prove gateway route readiness.
The live agent journey remains unverified; do not mark the goal complete.

### September 11: file-oriented Code Mode

The agent surface now uses `code_create`, `code_list`, `code_read`, `code_write`,
`code_remove`, and optional `code_history` capabilities. Writes save immediately,
including incomplete source, and return compiler diagnostics. File writes lock
and merge the latest bundle so concurrent writes to different paths survive;
the last write to the same path wins. Agent inputs do not require revisions.
The human editor retains its stale-draft protection and immutable history remains
internal. Canonical capability readers require `id`, so every app argument uses
`id` rather than introducing `appId` alongside it.

The browser advertises six separately deferred tools: `code_run`, `code_inspect`,
`code_interact`, `code_stop`, `code_open`, and `code_export`. Their arguments are
flat. The internal bridge envelope is not model-facing. Dialog answers use the
pending modal ID through `code_interact`; consecutive dialogs now return the next
pending modal instead of timing out. Source and runtime legacy names were removed.

The canonical Code Mode skill and generated version 3 template cover headless
analysis and interactive apps, immediate saves, lazy loading, isolated tests,
file delivery, and practical UI choices. References remain on demand. Opening an
app does not start it. There is no SQL or server background execution.

Verification: 49 focused tests passed, plus 6 disposable PostgreSQL tests with
32 assertions. Real Chrome tests cover source/tab UX, worker termination,
interactive list/modal actions, deduplication, and two-file CSV aggregation with
captured output and no UI/download. Consecutive-modal regression also passes.
Both Assistant and Cloud typechecks pass. Harper findings were reviewed; only
technical terms, sentence-case headings, and a multiline possessive false positive
remain. No commit was made for this slice.

Live acceptance is in progress. Restarting Core exposed its image's old copy of
Assistant islands importing the removed browser tool contract. Rebuilding Core
with current sources is required; a source-only restart cannot update that copy.

The live test chat automatically found skill revision 3 and loaded source/runtime
tools. It initially prefixed browser tools with `assistant.` and corrected that
itself; version 4 now gives exact loading examples to avoid the detour. The full
journey did not pass: the local gateway again returned 502 (no app registered),
dynamic island imports failed, and a source-action approval continuation reported
Unknown tool. The association with the unstable stack is not proof of its cause;
retest the approval continuation on a healthy stack before closing acceptance.
The isolated test browser and its unfinished test turn were stopped. Current
focused suite: 49 passing tests / 581 assertions, plus the separate six real DB
tests. Implementation is ready for review; live acceptance remains open.

## Background execution and agent ergonomics — verified 2026-09-11

- Assistant keeps its live socket when the tab is hidden. Browser suspension,
  reload and closure still limit browser-owned workers. Switching conversations
  can leave an inactive conversation waiting for its browser handler.
- Runtime claims resolve authorized public short turn IDs to internal UUIDs;
  duplicate claims cannot replay an action. The previous `Invalid UUID` failure
  was infrastructure, not a reason to rewrite valid app source.
- Code source Actions explicitly use the public no-approval policy. Authorization,
  private ownership, required idempotency and isolated test effects remain intact.
  Other Actions retain their existing approval rules.
- Apps context uses current permission-checked names, deduplicates references and
  opens named workspace tabs without auto-start. Browser work uses its own status;
  the hand remains reserved for human input or approval. Running/attention filters
  and counts use the same SQL predicate as summaries, without loading full blocks.
- Compiler errors preserve source locations. Host errors identify the failed
  execution layer. Invalid workbench arrays and returned UI handles now produce
  actionable errors instead of `.map` or structured-clone implementation errors.
- Skill template version 6 includes a short fast path, exact tool names, selective
  reference loading, global namespace rules, serializable outputs, UI array
  examples and an exact percentage calculation. Generated template and database
  version agree.

Validation: both owning package typechecks passed; focused policy, live socket,
status, source and seed tests passed; seven disposable-Postgres artifact tests
passed; conversation summary/filter/count integration passed including mixed
human/browser work. Real Chrome worker and workspace tests passed. A wider
capability-catalog test retains unrelated `transcribe_audio` expected-list drift.
Harper findings were heading-style preferences and the proper name Tabler.

Authenticated live acceptance used GLM 5 Flash and simulated hidden-document
visibility (headless Chrome keeps native tabs visible). The headless sales test
completed in 57 seconds: 400 total, 250 North, 150 South, CSV export, readback and
presentation, zero prompts, one socket and no disconnections. The fresh UI test
completed in 97 seconds: first source compiled and ran, agent corrected a list-only
`action: click` argument without intervention, verified 80 plus 10 percent equals
88, stopped its test and opened the app without starting it. These are measured
examples, not latency guarantees. Earlier exploratory UI attempts were interrupted
by test-browser WebSocket authentication and local stack reloads; they are not
counted as successful acceptance runs. Original user chats were not resumed.

The named Apps context row was also checked after browser hydration: clicking it
opened the named tab and Start screen with zero compilation requests. The
short-lived test browser session was revoked and its token files removed.

## Context and workspace navigation checkpoint

Chat context now opens apps, file previews, and content overviews in the workspace.
The global app picker and workspace entry buttons are removed. App previews are
limited to three entries; View all opens searchable cards scoped to the chat.
Source pagination is followed when building the context snapshot. Optional app
descriptions are stored separately from code and exposed by creation and readers.

Public Tabs supports pill presentation, independent close controls, and a fixed
trailing slot. Assistant uses that slot for the content dropdown. Runtime panels
stay mounted across tab changes. App titles resolve after URL restoration, and
context overview selections have stable URL identities. Confirmations remain
modal; browsing source files no longer opens a picker modal.

Verification: 35 shared action render tests, one keyboard/close behavior test,
13 chat context render tests, five workspace/state/browser tests, eight disposable
Postgres tests, and focused skill/context tests pass. Assistant, UI, and docs-site
raw typechecks pass. Chrome tests cover card filtering, duplicate opens, no
automatic launch, draft/undo preservation, closing confirmation, and narrow tab
scrolling. An existing frontend source-string contract still expects the absent
composer paste-resource action; that unrelated failure remains unchanged.
