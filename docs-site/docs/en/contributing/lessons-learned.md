---
title: Lessons learned
navTitle: Lessons learned
section: Contributing
order: 1305
description: Name the error class of each bug and the guard that catches that class next time, and read the incidents that taught each class.
tags: [contributing, testing, quality]
updated: 2026-10-17
---

# Lessons learned

A bug that is fixed once can come back in another place. To stop that, every
fix names the error class of its bug, then adds or names the guard that
catches that class next time. A guard is a repository check under
`scripts/checks/`, a test that fails on the bug, or a named convention that
reviews apply. Checks and tests fail on their own. A convention works only
while reviews apply it, and a rule that nothing checks decays. The table marks
each guard as a check, a test, or a convention, so a class that has only a
convention still needs a check or a test.

## Error classes

| Class | What goes wrong | Current guard |
| --- | --- | --- |
| Claim and assignment diverge | A person works on a task while assignment-based lists still show it as unassigned, or a stale assignee replacement removes an active worker. | Tests: `packages/spaces/src/service/claim-assignment.integration.test.ts` checks transactional user claims, guarded assignee replacements, forced releases, completion, and idempotent backfill ([#1269](https://github.com/k2b-dev/cloud/issues/1269)). |
| Paint outside a scrollport | An outline or outset shadow, such as a status ring, reaches past its element and a scrolling ancestor flush with it cuts it off. | Test: `packages/ui/src/layout/detail-panel-sections.browser.test.ts` checks that an avatar ring flush with the detail body paints inside the scrollport and keeps the avatar size. |
| Unbounded storage growth | Durable payloads have no size bound or retention. | Tests: workflow event integration cases cover byte limits, payload retention, dedupe, and resumable runs; workflow observability integration cases cover expired payloads; Mail integration cases cover oversized messages ([#1183](https://github.com/k2b-dev/cloud/issues/1183)). |
| Unreadable treated as missing | Startup replaces an unreadable or invalid stored value with an environment value. | Test: `packages/cloud/src/services/settings/bootstrap.integration.test.ts` preserves ciphertext and timestamps for undecryptable and invalid rows while reads use the environment fallback ([#1295](https://github.com/k2b-dev/cloud/issues/1295)). |
| Motion choice ignored | JavaScript or a separate document animates despite the person's reduced-motion choice. | Tests: `MailConversationReader.behavior.test.tsx` checks the choice at jump time; `MailMessageBody.browser.test.ts` checks initial and live propagation into the sandboxed message and rejects frame-originated motion messages ([#1230](https://github.com/k2b-dev/cloud/issues/1230)). |
| One Markdown dialect parsed differently by editor and renderer | Separate parsers disagree about documented source forms, so an image renders in one view and disappears in another. | Shared helper: Notebooks uses `parseSizedMarkdownImage` in Book and Lezer. Test: both views iterate `DOCUMENTED_IMAGE_FORMS` for attachment and HTTPS images with sizes and titles ([#1278](https://github.com/k2b-dev/cloud/issues/1278)). |
| Shared renderer configuration race | Concurrent Mermaid consumers overwrite singleton configuration before a queued render reads it. | Test: Notebooks `mermaid-render.test.ts` checks serialized configuration and rendering, call order, and recovery after rejection. Convention: all Notebooks Mermaid consumers use `renderMermaid`. |
| Screen-only layout printed as-is | Browser printing includes navigation, toolbars and detail panels, or clips content at a fixed-height scrollport. | Tests: `packages/cloud/src/ssr/print.browser.test.ts`, `packages/ui/src/layout/workspace-print.browser.test.ts`, and Notebooks `note-print-copy.browser.test.ts` emulate print and check complete content. Convention: every view supplies printable content or an export hint; see [Browser printing](/en/ui/layout/print) ([#1281](https://github.com/k2b-dev/cloud/issues/1281)). |
| Workspace-only export | A published package imports code that exists only in the workspace copy of a pinned sibling; workspace links hide the missing export. | Check: the `packed` CI job runs with `--release` on the release pull request and in the merge queue, resolving already published sibling pins from npm. Convention: [refresh the release PR after the last feature PR merges](/en/docs/contributing/release-process#let-release-please-cut-the-release). |
| Time | A test or a render depends on today's date, the time zone, or randomness, so it passes on one day and fails on another. | Test: the Assistant sidebar test from [#1121](https://github.com/k2b-dev/cloud/pull/1121) freezes its clock. No repository check finds other tests that compare fixed dates with the real clock yet. |
| Lease starvation under a continuous competing workload | A class of work keeps the lease while competing work retains places and retries without progress. | Test: Mail’s `provider-lease-fairness.integration.test.ts` checks command progress during continuous folder syncs, sync progress under old command backlogs, and a total order with one first waiter ([#1268](https://github.com/k2b-dev/cloud/issues/1268)); “a folder sync waits for at most one move set's two seconds and a few slow statements while each marker and settle statement is slow” guards constant per-set costs for per-statement marker and settle slowdowns ([#1013](https://github.com/k2b-dev/cloud/issues/1013)). |
| Shared subprocess lost after timeout | Bun kills a shared browser when one test times out, so later tests fail too. | Test: `packages/ui/test/browser.browser.test.ts` runs a child suite with one hung test and checks that three later tests still open pages ([#1254](https://github.com/k2b-dev/cloud/issues/1254)). |
| Server render vs. mount | An island replaces the server HTML when it mounts; see [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). When the server and the browser render different markup or styles, the page moves on mount or after a reload, and WebKit can keep stale styles from before the mount. | Convention: [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). Test: the month view browser tests from [#1157](https://github.com/k2b-dev/cloud/pull/1157) check row places right after mount. The `@k2b/ui` sidebar reload test from [#1154](https://github.com/k2b-dev/cloud/issues/1154) compares the server frame, the frame right after mount, and the settled frame after a reload. No shared test does this for other islands yet. |
| Layout shift | A transient state, such as a status text, a notice, or a loader, appears in the layout flow and moves its neighbors. | Convention: [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still) ([#1143](https://github.com/k2b-dev/cloud/pull/1143)). Each change applies its browser-test pattern, which compares bounding boxes before and after each state change. Test: `chat-composer.browser.test.ts` checks pending slash searches and command status at desktop and phone widths. `PermissionEditor.behavior.test.tsx` checks control identity during saving; `PermissionEditor.browser.test.ts` compares row and control boxes at phone and desktop widths ([#1277](https://github.com/k2b-dev/cloud/issues/1277)). No automatic check catches every flow. |
| Focus lost on refresh | A list keys an element by derived content instead of a stable identity. When its data refreshes or grows, the list re-creates the focused element and focus falls to the page body. | Tests: `packages/ui/src/content/calendar-days.browser.test.ts` — "the day view keeps the focus on a run of empty days while days join it at either end" and "the day view keeps a focused event when the clock updates its free time"; Spaces tray — "keeps keyboard focus on a task of the tray while a refresh brings the same tasks again" and "reaches the tray right after the day with the keyboard". Convention: [A11Y-16](/en/docs/conventions/frontend#accessibility-a11y), with [Keep focus while content refreshes](/en/ui/focus#keep-focus-while-content-refreshes). Check: `access-editor-mounts` rejects keyed and refreshing-gated ancestors of shared access editors; `PermissionEditor.browser.test.ts` checks that keyboard focus survives a consumer refetch ([#1283](https://github.com/k2b-dev/cloud/issues/1283)). |
| State lost on navigation or reload | Clearing, cancelling, reloading, or going Back does not return the person to where they started, or drops input that was not saved yet. | Convention: [Test URL behavior](/en/docs/frontend/testing#test-url-behavior) covers reload, Back, Forward, and opened links. Test: `reload.behavior.test.ts` keeps open dialogs through automatic reload requests and offers the reload after they close ([#1176](https://github.com/k2b-dev/cloud/issues/1176)). `chat-slash.behavior.test.ts` guards restoration of unchanged command drafts after cancellation or failure. No shared guard covers unsent local edits outside dialogs yet; Grids tests the leave warning of its public forms in `PublicFormSubmit.behavior.test.tsx`, and Notebooks tests that a sync error keeps unsent text in `sync-ended.behavior.test.tsx` and `provider.test.ts`. |
| Ordering and concurrency | Work for one item runs in parallel or races another writer, so results land out of order or a later step undoes an earlier one. | Convention: the order and no-drop rules in [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) ([#1148](https://github.com/k2b-dev/cloud/pull/1148)) cover actions in the browser. Test: Chat's send queue keeps the browser posts of one conversation in order in `chat-sends.test.ts` ([#1145](https://github.com/k2b-dev/cloud/issues/1145)). `PermissionEditor.behavior.test.tsx` keeps one access change in flight per editor: it checks pending rows, blocked picks while a grant saves, duplicate picks, failure recovery, and silent cancellation. Contacts `access-last-manager.integration.test.ts` orders HTTP changes behind a held book lock to check concurrent self-demotions and stale authorization ([#1233](https://github.com/k2b-dev/cloud/issues/1233)). No shared guard covers server-side writers yet; Mail's command queue has an integration test for server-side order in `conversation-actions.integration.test.ts`, and `incoming-automations.integration.test.ts` and `conversation-work-state.integration.test.ts` check that a status decision survives the hydration of a message it covers ([#1142](https://github.com/k2b-dev/cloud/issues/1142)). The status step also works when another message was already linked but still waits for loading. The view records its snapshot and link order. Only a message that joined after the view keeps the conflict ([#1216](https://github.com/k2b-dev/cloud/issues/1216)). Files' `filegate-lifecycle.integration.test.ts` and `files.integration.test.ts` cover concurrent private commits, one shared root-lock wait budget per request, and immediate attempts without a wait ([#1165](https://github.com/k2b-dev/cloud/issues/1165)). |
| Manager invariant | A resource-bound key counts as a manager, letting the last durable manager leave. | Test: Contacts `access-last-manager.integration.test.ts` refuses removal and demotion next to a book-bound key, and covers agent managers and administrator recovery ([#1233](https://github.com/k2b-dev/cloud/issues/1233)). |
| Deadline shorter than bounded work | A control request times out while its valid work still runs, so retrying repeats the failure. | Tests: Files `filegate-timeout.test.ts`, `upload-commit-route.test.ts`, `filegate-transfer.integration.test.ts`, `upload-retry.behavior.test.tsx`, and `cli-upload.test.ts` cover commit budgets and recovery ([#1164](https://github.com/k2b-dev/cloud/issues/1164)). |
| Transient failure amplified across queued work | One temporary failure immediately fails each subsequent queued item. | Tests: Files `upload-retry.test.ts`, `upload-retry.behavior.test.tsx`, `cli-upload.test.ts`, and `filegate-transfer.integration.test.ts` cover pause, bounded retries, cancellation, and session reuse ([#1163](https://github.com/k2b-dev/cloud/issues/1163), [#1167](https://github.com/k2b-dev/cloud/issues/1167)). |
| Silent failure | Async work fails and the person sees nothing, or a progress text stays as the last word. | Convention: [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) for single actions. Test: Assistant executor integration tests classify an empty answer after a failed step, also after worker recovery; timeline behavior and browser tests keep the failure notice at the turn's end ([#1150](https://github.com/k2b-dev/cloud/issues/1150)). Files transfer deadline tests cover stalled requests and response bodies, and CLI tests cover stalled preparation and visible errors. Files upload outcome tests retain temporary transfer progress, discard dead keys, and expose the cause ([#1166](https://github.com/k2b-dev/cloud/issues/1166)). No shared guard covers other background work yet. |
| Foreign system contracts | Cloud sends a schema or a payload that a foreign system, such as a model provider or Filegate, does not accept. | Partial test: the chart tool schema is checked for provider shape (one root object without `oneOf`, `anyOf`, or `allOf`, and no tuple `items`) in `packages/cloud/src/ai/chart-block.test.ts` and `default-tools.test.ts`. Test: `tests/capability-tool-schemas.test.ts` builds every app's capability tools the way the Assistant does and checks the same provider shape for each input schema ([#1149](https://github.com/k2b-dev/cloud/issues/1149)). No guard covers Filegate payloads yet. |
| Server-side request forgery | A person-chosen address reaches the server’s private network or changes between validation and connection. | Check: `network-guard` lets only the platform guard resolve host names. It also rejects global `fetch()` in Pulse server code. Test: platform allowlist and resolution tests, plus Tools and Pulse refusal, redirect, and pinned-transport tests. |
| Escaped text input | An agent writes `\n` as two characters through a shell argument or double-escaped JSON, and the text is stored and shown with a literal backslash. | Test: Spaces rejects such inline CLI text and capability text inputs ([#1178](https://github.com/k2b-dev/cloud/issues/1178)). No shared guard covers inline text in other apps, such as `cld notebooks write --content`, yet ([#1193](https://github.com/k2b-dev/cloud/issues/1193)). |
| Breakpoint gap | Two neighbouring media queries end at `max-width: 1023px` and start at `min-width: 1024px`. A fractional width between them, such as a zoomed window, matches neither, and the page falls back to its base rules. | Test: `packages/cloud/src/styles/shell-modes.test.ts` pins the shell queries to `min-width` and its negation `not all and (min-width: …)` ([#1255](https://github.com/k2b-dev/cloud/issues/1255)). Range syntax such as `width < 64rem` is no guard: the build lowers it to `max-width: calc(64rem - .001px)`. No check covers other style sheets yet. |
| Nested surface | A view fills its work area but draws its own rounded border, making a second card inside the app card, as in the Notebooks graph and attachments empty state. | Check: `workspace-surfaces` detects full-area framed elements, filling `Paper` elements, and paper panel placeholders. Convention: [UI-22](/en/docs/conventions/frontend#visual-ui-ui) and [Workspace surface hierarchy](/en/ui/layout/workspace) keep full-area views on Main's surface. |
| Theme in print | The screen theme reaches paper: dark-theme text and surfaces print on white paper, or print rules show what the screen hides on purpose. | Test: the Mail printing browser test in `MailConversationList.browser.test.ts` prints a dark and a light conversation through Print conversation in Chromium and WebKit. It checks contrast against the printed surface, the sender rows, and the single quote label ([#1175](https://github.com/k2b-dev/cloud/issues/1175)). No shared guard yet: native printing still prints the dark theme on every other page ([#1274](https://github.com/k2b-dev/cloud/issues/1274)). |

## Lessons

### A claimed Spaces task still appeared unassigned

- **What happened:** A person could claim a task without becoming an assignee, so assignment filters missed work already in progress ([#1269](https://github.com/k2b-dev/cloud/issues/1269)).
- **Root cause:** Claim writes and assignee replacements treated working state and responsibility as independent data.
- **Error class:** Claim and assignment diverge.
- **Guard:** `claim-assignment.integration.test.ts` checks that user claims assign once, holder removal is guarded before any write, forced release removes the previous holder, and startup backfill repairs old user claims. The existing item row lock serializes claim writes and assignee replacements.

### Concurrent upload commits rejected each other

- **What happened:** Two tabs uploading small files into the same storage root lost commits to retryable busy errors ([#1165](https://github.com/k2b-dev/cloud/issues/1165)).
- **Root cause:** Private commits shared a broker root lease configured for a single acquisition attempt, so even brief contention rejected publication immediately.
- **Error class:** Ordering and concurrency.
- **Guard:** `filegate-lifecycle.integration.test.ts` pairs forty real uploads at their commit boundary. `files.integration.test.ts` checks publication after a short lock, busy after the five-second wait, one shared wait budget for a multi-entry move, immediate root-lock attempts without a wait or after its budget expires, and immediate capability-upload rejection without consuming its body. Publications and trash mutations opt into a wait per request; listings and administrative lifecycle operations retain a single attempt.

### Access refetches drop keyboard focus and close member lists

- **What happened:** Saving an access change dropped focus to the page body and closed expanded group members in several applications ([#1283](https://github.com/k2b-dev/cloud/issues/1283)).
- **Root cause:** Consumers keyed the whole editor by refetched data or hid it during refresh. Contacts also replaced its pickers with read-only badges while reloading.
- **Error class:** List re-keyed on refresh drops focus.
- **Guard:** Check: `access-editor-mounts` rejects keyed or refreshing-gated `Show` and `Match` ancestors. Tests: `PermissionEditor.browser.test.ts` preserves the focused chip after a keyboard change and consumer refetch at phone and desktop widths; behavior tests cover merging by id, deferred updates, caller copies, and Contacts and Venue reloads.

### A scrolling panel clipped an avatar's status ring

- **What happened:** The ring around the person working on a Spaces task was cut off at the detail panel's left edge.
- **Root cause:** An outline extended beyond an avatar placed flush with the body's scrollport.
- **Error class:** Paint outside a scrollport.
- **Guard:** `packages/ui/src/layout/detail-panel-sections.browser.test.ts` checks the painted ring bounds, including outside outlines and shadows, and unchanged avatar dimensions in both themes and viewport sizes. The ring and its transparent gap now fit inside the avatar's border box.

### Large uploads timed out after all bytes arrived

- **What happened:** Files could not finish uploads above about 1.3 GiB; every retry reached the same commit timeout ([#1164](https://github.com/k2b-dev/cloud/issues/1164)).
- **Root cause:** The Filegate wrapper gave commits the ordinary 10 s API deadline. App requests and clients also had shorter budgets than a large commit needs.
- **Error class:** Deadline shorter than bounded work.
- **Guard:** `filegate-timeout.test.ts` checks the production classifier and SDK URL; `upload-commit-route.test.ts` checks both routes restore socket timeouts. `api-error.test.ts` keeps a storage deadline retryable (`unavailable`, 503) instead of `internal`. The delayed real commit in `filegate-transfer.integration.test.ts` detects a short wrapper deadline. Browser and CLI retry tests retain the same upload identity after ambiguous commit answers.

### Settings startup overwrote a value encrypted with another key

- **What happened:** Starting an application with a different `APP_SECRET` replaced a saved setting with its environment value ([#1295](https://github.com/k2b-dev/cloud/issues/1295)).
- **Root cause:** Normalization skipped the unreadable row, then bootstrap treated its key as missing and upserted the environment value.
- **Error class:** Unreadable treated as missing.
- **Guard:** `bootstrap.integration.test.ts` checks that unreadable and invalid rows keep their ciphertext and fixed timestamp. Bootstrap only inserts missing rows; normalization updates only the ciphertext it read.

### Mail ignored the person's reduced-motion choice

- **What happened:** Jumping to newest and the HTML message's quoted-text toggle still animated with Reduce motion enabled ([#1230](https://github.com/k2b-dev/cloud/issues/1230)).
- **Root cause:** The jump always requested smooth scrolling, and the sandboxed message only checked the OS setting rather than receiving the host's attribute.
- **Error class:** Motion choice ignored.
- **Guard:** The reader behavior test changes the choice before clicking. The message browser tests cover the initial choice, live changes in both directions, restored transitions, and rejection of frame-originated motion messages.

### One network drop failed the rest of an upload batch

- **What happened:** After the connection dropped during a large upload, each remaining file failed immediately instead of waiting ([#1167](https://github.com/k2b-dev/cloud/issues/1167)). Stalled and busy transfers also required a manual retry ([#1163](https://github.com/k2b-dev/cloud/issues/1163)).
- **Root cause:** The queue treated temporary transfer failures as final row outcomes. Request deadlines detected stalls, but no attempt-level policy resumed the retained session.
- **Error class:** Transient failure amplified across queued work.
- **Guard:** `upload-retry.test.ts` checks one shared, bounded retry policy. `upload-retry.behavior.test.tsx` checks a 30-file network drop, deadline exhaustion, Retry-After, cancellation, and stale attempts through the real upload adapters and panel. CLI tests and `filegate-transfer.integration.test.ts` check bounded retries and resume with the same key and session.

### Mail printed a dark conversation as light text on white paper

- **What happened:** In dark mode, Print conversation printed the subject and plain-text bodies in near-white text on white paper. Both labels of the quoted-text toggle printed on top of each other, and the sender rows were missing in both themes ([#1175](https://github.com/k2b-dev/cloud/issues/1175)).
- **Root cause:** The print rules made only the reader root white and black, so its content kept the dark theme's text colors. They forced `visibility: visible` on every element in the reader, which also showed the hidden toggle label. They also hid every button, and the message header with the sender and date is a button. Cloud has no light theme scope that also covers the Tailwind `dark` variant and the `@k2b/ui` component rules.
- **Error class:** Theme in print.
- **Guard:** Mail hides only what lies outside the reader, keeps the message header on paper, and prints a dark reader as black ink without dark surfaces. The Mail printing browser test runs the real Print action in Chromium and WebKit. [#1274](https://github.com/k2b-dev/cloud/issues/1274) proposes a light print theme for every page.

### Published Cloud imports an export missing from its pinned UI

- **What happened:** Standalone apps using `@k2b/cloud` 0.35.0 from `cloud-v0.42.0` failed typechecking and bundling because `@k2b/ui` 0.25.0 lacked `prefersReducedMotion` ([#1221](https://github.com/k2b-dev/cloud/issues/1221)).
- **Root cause:** The release PR was not refreshed after #1208 merged, so it left UI unbumped. Cloud imported the new export but pinned the already published UI version. Workspace links and the packed check's unconditional workspace tarball overrides hid the mismatch.
- **Error class:** Workspace-only export.
- **Guard:** Check: `packed` runs with `--release` on the release PR and in the merge queue, using npm for already published sibling pins and failing when npm is unreachable. Test: `packed-consumer-pins.test.ts` checks published pins, unpublished release versions, invalid pins, and registry failures. Convention: refresh the release PR after the last feature PR merges and verify its parent against `origin/main` before merging.

### Folder syncs starve Mail commands on busy mailboxes

- **What happened:** Moves, folder creation, and sends stayed queued for minutes while hundreds of folders kept syncing ([#1268](https://github.com/k2b-dev/cloud/issues/1268)).
- **Root cause:** Head starts ordered individual waiters, so every older folder sync went before a command. Retained places and continuous syncs made that wait grow with the folder count.
- **Error class:** Lease starvation under a continuous competing workload.
- **Guard:** Commands and other provider work alternate in the lease line. `provider-lease-fairness.integration.test.ts` checks continuous syncs of many folders through the command worker, both directional turn bounds, and a seeded mixed sequence with exactly one first waiter. Existing continuation, body-batch, and bulk-move tests preserve sync progress.

### Signed-in shell fell between its two modes

- **What happened:** While the card moved from 1536 px to 1024 px, review found that a width between 1023 and 1024 CSS pixels, such as a 1126 px window at 110 % zoom, matched neither the flush mode nor the card. The rail then moved 8 px to the right and the card took the base spacing. The phone mode had the same gap at 767 and 768 px ([#1255](https://github.com/k2b-dev/cloud/issues/1255)).
- **Root cause:** The flush mode ended at `max-width: 1023px` and the card started at `min-width: 1024px`. Playwright snaps viewports and frames to whole pixels, so no browser test reached the gap.
- **Error class:** Breakpoint gap.
- **Guard:** Each shell query in `global.css` states only `min-width`, negated with `not all and` for the range below. `shell-modes.test.ts` pins these queries.

### One hung browser test failed the rest of its file

- **What happened:** One timeout in the bare dialog suite caused 20 later browser tests to fail ([#1254](https://github.com/k2b-dev/cloud/issues/1254)).
- **Root cause:** Bun's timeout cleanup sends SIGTERM to every subprocess the test process started, including the shared browser. A browser still shutting down can report itself connected while page creation fails with a protocol error.
- **Error class:** Shared subprocess lost after timeout.
- **Guard:** `packages/ui/test/browser.browser.test.ts` checks that only the hung test fails and three later tests pass. For local launches, it also checks that Bun killed the browser. The launcher replaces a disconnected browser or retries a failed page or context creation once. Pages and contexts must be opened per test.

### Workspace pane widths change after reload

- **What happened:** A pane with limits outside 240–640 px could not restore its saved width. Resize separators also announced the default width before hydration, even when SSR restored another width.
- **Root cause:** Persistence used the default pane limits as its storage envelope, and separator markup ignored the initial layout state.
- **Error class:** State lost on navigation or reload; server render vs. mount.
- **Guard:** `advanced-layout.render.test.tsx` checks the 160–960 px storage envelope. `workspace-levels.render.test.tsx` checks restored separator values. `workspace-levels.browser.test.ts` compares pane, head, and separator geometry before and after hydration with a saved cookie.

### Calendar day view dropped the focus when later days loaded

- **What happened:** Focusing the last "Nothing planned" button loaded later days. Focus fell to the page body, and Tab missed the Spaces task tray ([#1225](https://github.com/k2b-dev/cloud/issues/1225)).
- **Root cause:** A run of empty days used its joined day keys as its list key. When loaded days joined it, the key changed and the view replaced the focused button. A run now keeps the identity of a previous run that shares a day with it.
- **Error class:** Focus lost on refresh.
- **Guard:** The `@k2b/ui` day view browser test keeps the same focused button as days join a run at either end. The Spaces tray keyboard test waits for the later days before it checks focus and presses Tab. Convention [A11Y-16](/en/docs/conventions/frontend#accessibility-a11y) applies the same rule to other lists.

### A file server that never answered froze the upload batch

- **What happened:** A transfer request that the file server never answered left the upload row working with no message, and the rest of the batch waited ([#1163](https://github.com/k2b-dev/cloud/issues/1163)).
- **Root cause:** The Filegate SDK sets no request deadline ([k2b-dev/filegate#5](https://github.com/k2b-dev/filegate/issues/5)), and Cloud passed none. A plain per-request timeout is not enough: the SDK retries a thrown fetch error unless its upload signal is aborted, so each deadline would run three times.
- **Error class:** Silent failure.
- **Guard:** `upload-transfer.test.ts` checks one attempt per expired deadline, stalled response bodies, caller cancellation, and completed-request listener cleanup. CLI tests cover preparation deadlines and localized errors; `filegate-transfer.integration.test.ts` checks retained acknowledged bytes after a stalled second segment.

### Spaces showed a literal backslash-n on a card

- **What happened:** A Kanban card preview showed `Caption:\nText` instead of a line break ([#1178](https://github.com/k2b-dev/cloud/issues/1178)).
- **Root cause:** The stored description held a backslash and an `n`. A shell keeps `\n` inside quotes as two characters, and a model can double-escape JSON; the Spaces CLI and capability inputs stored that text unchanged. The preview only showed what was stored.
- **Error class:** Escaped text input.
- **Guard:** Tests in Spaces: inline CLI text and capability text inputs reject `\n` outside inline code when the text has no real line break. Stored text and the browser editor stay unchanged, because `\n` can be real content, such as a Windows path.

### Assistant sidebar test broke every gate

- **What happened:** From 2026-10-14, the Assistant sidebar behavior test failed on every gate run, also on `main`, and blocked the merge queue ([#1121](https://github.com/k2b-dev/cloud/pull/1121)).
- **Root cause:** The sidebar switches from the server's render time to the browser clock in `onMount`. The fixture chat had a fixed date, so 30 days later it moved from "this month" to "older".
- **Error class:** Time.
- **Guard:** The test sets the system time to the render time before each test. No check finds the same mistake in other tests yet.

### Month rows keep a stale place in WebKit

- **What happened:** In WebKit, the continuous month view sometimes kept its server-rendered week rows at an old place and height for up to a second after mount, and the WebKit gate flaked on it ([#1132](https://github.com/k2b-dev/cloud/issues/1132)).
- **Root cause:** Row place and height depended on container query units of a size container. WebKit did not always resolve the container units again after mount, so the server-rendered rows kept their old place and height until a later restyle.
- **Error class:** Server render vs. mount.
- **Guard:** Since [#1157](https://github.com/k2b-dev/cloud/pull/1157), rows take their size from the scroller, and browser tests in `@k2b/ui` and Spaces check each row's place right after mount.

### App sidebar overlaps its header after a reload

- **What happened:** After a person scrolled the app sidebar and reloaded the page, the sticky header drew on top of the scrolled list until the first interaction. It was seen in Mail on iPad Safari ([#1154](https://github.com/k2b-dev/cloud/issues/1154)).
- **Root cause:** The sidebar restored its offset only in an inline script for the server HTML. When an island mounted, it replaced that HTML with a new list at offset 0, so the list jumped right after the first paint, and its scroll fade came late. Chromium and Playwright WebKit show this jump; the overlap itself was seen only on iPad Safari. The inline restore could also run before the final layout, and the scroll listener stored those cut values, so the offset shrank on every reload. The memory key used the first path segment, which is `app` for every Cloud app, so apps restored each other's offsets.
- **Error class:** Server render vs. mount.
- **Guard:** `SidebarBody` runs one restore inline and again on mount, and stores the offset only when the page is left. `sidebar-reload.browser.test.ts` in `@k2b/ui` reloads a scrolled island sidebar in Chromium and WebKit, at desktop and iPad sizes, flat and framed, and checks that the server frame, the mount frame, and the settled frame are the same and that header and list do not overlap.

### Assistant reconnect notice moves the page

- **What happened:** When the live connection dropped for a moment, the Assistant's reconnect notice moved the title, the composer, and the starters on the new-chat page ([#1159](https://github.com/k2b-dev/cloud/issues/1159)).
- **Root cause:** The notice above the composer is mounted only while it shows, so it takes a new line in the layout flow.
- **Error class:** Layout shift.
- **Guard:** Pending in [#1159](https://github.com/k2b-dev/cloud/issues/1159): the notice gets a place that the page reserves, and a browser test compares the places of the title, the composer, and the starters before and during a reconnect. The class rule is [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still).

### Studio Save moves when the editor becomes dirty

- **What happened:** In the Studio manual editor, the first edit inserted "Unsaved changes" before Save, and Save jumped sideways ([#1146](https://github.com/k2b-dev/cloud/issues/1146)).
- **Root cause:** The status text is mounted only while the editor is dirty, inside the same flex row as Save.
- **Error class:** Layout shift.
- **Guard:** Pending in [#1146](https://github.com/k2b-dev/cloud/issues/1146). The class rule is [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still).

### Clearing a Mail search lands in All mail

- **What happened:** A person started a search from a Focus view or a folder and then cleared it. Mail showed All mail instead of the view the search started from ([#1156](https://github.com/k2b-dev/cloud/issues/1156)).
- **Root cause:** Starting a search dropped the previous view from the URL state. Restoring its scroll alone also lost the position beyond page one, because changing the query source reloads only the first page.
- **Error class:** State lost on navigation or reload.
- **Guard:** `mail-navigation.test.ts` and `MailWorkspace.search-return.behavior.test.tsx` cover the starting view across clearing, reload, and Back. The behavior tests also require previously loaded pages to reload before the final scroll restore, and check that leaving during that load preserves the other view and its scroll.

### Notebooks lose unsent text on a sync error

- **What happened:** When the note editor hit a fatal sync error, such as an expired session, it showed an alert and then reloaded the page. Edits that were not sent yet were lost ([#1144](https://github.com/k2b-dev/cloud/issues/1144)).
- **Root cause:** The fatal-error handler always reloads after the alert, also while unsent changes exist. The provider also did not track which sent edits the server had stored, so it could not tell whether a reload loses text.
- **Error class:** State lost on navigation or reload.
- **Guard:** The provider keeps each sent edit until the server echoes it, and a sync error never reloads by itself: the note stays on screen read-only with one recovery action, and Reload or leaving asks first while edits are unsent. `provider.test.ts` covers the pending state, and `sync-ended.behavior.test.tsx` checks every error code with and without unsent edits.

### Chat stores quick messages out of order

- **What happened:** Two Chat messages sent right after each other could be stored and shown in a different order than they were typed ([#1145](https://github.com/k2b-dev/cloud/issues/1145)).
- **Root cause:** Chat posts each message as soon as it is sent, so the posts of one conversation run in parallel, and the server numbers them in the order they arrive.
- **Error class:** Ordering and concurrency.
- **Guard:** Test: Chat posts the sends of one conversation one at a time in submit order; a send that was not sent holds back the later ones until it is retried or discarded. `chat-sends.test.ts` fails when posts of one conversation overlap or change order, and `ChatWorkspace.behavior.test.tsx` covers retry and discard in the chat.

### Automation Done is reverted by reconciliation

- **What happened:** An incoming Mail automation set a conversation to Done, and a few minutes later the system set it back to Needs action ([#1142](https://github.com/k2b-dev/cloud/issues/1142)).
- **Root cause:** Automations run when Mail links the message envelope, before Mail loads its content. When the content arrived, Mail derived the status for that message again and set Needs action. It did not know that a decision had already covered the message. When the content arrived first, the automation's step failed on the changed revision instead. Another message that was already linked but still waited for loading also caused this conflict ([#1216](https://github.com/k2b-dev/cloud/issues/1216)).
- **Error class:** Ordering and concurrency.
- **Guard:** Each message link records whether the latest status decision covers it. Loading the content keeps a covered status. The status step also works when another message was already linked but still waits for loading. The view records its snapshot and link order. Only a message that joined after the view keeps the conflict. Integration tests in `incoming-automations.integration.test.ts` and `conversation-work-state.integration.test.ts` run each decision path in both orders. They check that later mail still reopens the conversation. They also check pending and failed loading, and links that commit after the view.

### Assistant turn fails without telling the person

- **What happened:** When the model provider rejected a request in the middle of a turn, the chat showed the last progress sentence and then nothing ([#1150](https://github.com/k2b-dev/cloud/issues/1150)).
- **Root cause:** Suspected: the failed-turn notice from [#712](https://github.com/k2b-dev/cloud/pull/712) does not show on this path. The turn outcome records the provider error, but the chat ends on the last progress sentence; the exact path is open in [#1150](https://github.com/k2b-dev/cloud/issues/1150).
- **Error class:** Silent failure.
- **Guard:** Pending in [#1150](https://github.com/k2b-dev/cloud/issues/1150): a failed turn always ends with one line that says what failed and offers a retry.

### Provider rejects a tuple tool schema

- **What happened:** OpenAI-compatible providers rejected the whole tool list with HTTP 400, which ended the turn ([#1149](https://github.com/k2b-dev/cloud/issues/1149)).
- **Root cause:** The Notebooks `note.edit` input uses a tuple. The AI schema reducer kept its `prefixItems` and `items: false`, Zod rebuilt the tuple, and Nessi sent it to the provider as a list of item schemas (`items: [...]` with `additionalItems: false`), which the provider does not accept.
- **Error class:** Foreign system contracts.
- **Guard:** The reducer rewrites every tuple as a bounded array of its item schemas, and `tests/capability-tool-schemas.test.ts` checks the provider shape of every app's capability tools.

### Webhook testing bypasses outbound address policy

- **What happened:** The Webhook Tester could send requests to addresses inside the server's own network.
- **Root cause:** Tools kept its own address classifier, which missed some IPv6 notations. A failed DNS lookup let the request through, and `fetch()` resolved the name again after the check.
- **Error class:** Server-side request forgery.
- **Guard:** Tools, Mail, Grids, and the Assistant web tools use the one platform guard (`resolvePublicNetworkAddresses` and `pinnedNetworkLookup`) instead of their own classifiers. The `network-guard` check fails when application code imports `node:dns` (other than SRV, MX, or TXT record lookups) or Bun's `dns`, calls `fetch()` in a file that checks hosts with the guard, or sends a `node:http` request with a pinned lookup but without `agent: false`, which an environment proxy could otherwise take over. Platform tests cover every IP literal form and failed, empty, or mixed DNS answers; Tools tests verify refusal, the pinned connection, and that redirects are not followed.

### Sharing closes the settings dialog

- **What happened:** Adding a person in Space settings reloaded the page and discarded the open dialog ([#1176](https://github.com/k2b-dev/cloud/issues/1176)).
- **Root cause:** The grant's live event called `reloadOnce`, which reloaded immediately. Pending grants also disabled the picker input, so its focus restoration failed.
- **Error class:** State lost on navigation or reload; ordering and concurrency.
- **Guard:** `reload.behavior.test.ts` checks that an automatic reload never happens under a modal dialog and that, after the dialog closes, the page offers the reload instead of cancelling work confirmed in the dialog. `PermissionEditor.behavior.test.tsx` checks pending rows, focus in the read-only picker, blocked picks while saving, disabled row controls, duplicate picks, failure recovery, silent cancellation, and errors of grants that fail after the dialog closed. `space-settings.browser.test.ts` covers the live event, the kept dialog and focus, and the offered reload on desktop and phone.

### Pulse metrics bypass the outbound address policy

- **What happened:** Pulse metrics sources could reach internal endpoints without an operator exception.
- **Root cause:** The metrics scraper called `fetch()` on the source endpoint without the platform guard.
- **Error class:** Server-side request forgery.
- **Guard:** Pulse validates and pins each request and redirect through `resolveAllowedNetworkAddresses` and `pinnedNetworkLookup`. Only the operator env registry can allow internal targets. Administrator-chosen health webhooks, Geo, Assistant rsql, outgoing SMTP and bounce IMAP are guarded too. Their HTTP paths use `createAllowedNetworkFetch`, which never follows redirects. SMTP connects to checked IP literals; IMAP uses a pinned lookup containing every checked address. Both preserve the original TLS `servername`. The `network-guard` check rejects global `fetch()` in guarded server roots and endpoint files, reports missing covered paths, and requires mail constructors to import the guard or outgoing-mail resolver. Loopback and injected-lookup tests cover blocked and operator-allowed targets, DNS rebinding, cancellation and streaming. SDK clients that resolve their own hosts cannot be pinned: use them only to sign locally, then send through a pinned transport. Platform and Pulse tests cover allowlist parsing, all DNS answers, blocked targets, redirect credentials, byte limits, and the total deadline.

### Incoming Mail automations invalidate each other's commands

- **What happened:** Matching incoming automations could fail when one marked a message read and another moved it ([#1036](https://github.com/k2b-dev/cloud/issues/1036)).
- **Root cause:** Flag and keyword steps did not check another run's move, and provider preconditions projected only the current run's writes.
- **Error class:** Ordering and concurrency.
- **Guard:** `incoming-automations.integration.test.ts` covers both read/move orders, already moved messages, moves that land while a read command is created, queued reads that find the message gone, and sibling keywords. Another client's move that sync has not seen yet still fails the read. Only writes that other incoming automations confirmed after the run captured the message extend expected state; external drift still fails. `workflow-message-preconditions.test.ts` checks transition order and modseq retention without writes.

### An empty answer after a failed step looked finished

- **What happened:** A tool call failed, and the model's next response stopped without text and without a tool call ([#1150](https://github.com/k2b-dev/cloud/issues/1150)). The turn finished as completed, so the chat showed the last progress sentence as the final answer and gave no hint that the work had stopped.
- **Root cause:** The executor treated every `stop` from the model loop as a completed turn and did not check whether the final response answered at all. Failure tracking also survived a later text answer and missed malformed calls saved before their error results.
- **Error class:** Silent failure.
- **Guard:** Such a turn now fails with `tool_failed`. Executor integration tests cover the empty answer, also after worker recovery with a malformed call missing its result, and the cases that stay completed (a text answer after the failure, a later successful round, a rejected approval). An executor unit test covers a text answer followed by late steering and an empty response. Timeline behavior and browser tests keep the failure notice at the turn's end, live and after reload.

### Composer slash suggestions lose selection and consume cancelled commands

- **What happened:** Typing emptied server suggestions, result updates reset arrow selection, and cancelled actions consumed their slash token. Unavailable rows had no explanation.
- **Root cause:** Search cleared rows before each request, selection and option ids used array positions, and only rejections restored the draft.
- **Error class:** Layout shift; state lost on navigation or reload.
- **Guard:** `chat-slash.behavior.test.ts` covers retained results, stable keyed selection, reasons, keyboard modifiers, Escape, guarded restoration, and status outcomes, including that a command failure stays visible until the next edit, command, or draft switch and reaches `onError` after an unmount. `chat-composer.browser.test.ts` checks list and status layout at desktop and phone widths.

### Upload failures discarded progress or reused dead sessions

- **What happened:** Temporary Files upload failures discarded acknowledged segments; final publication conflicts and unknown receipts reused dead upload IDs ([#1166](https://github.com/k2b-dev/cloud/issues/1166)).
- **Root cause:** Adapters treated transfer failures alike, kept every commit key, and started browser uploads outside cleanup. The CLI ignored failed abort responses.
- **Error class:** Ordering and concurrency; silent failure.
- **Guard:** Shared status-classification tests, browser and CLI adapter tests, retention-boundary tests, and queue behavior tests cover transient preservation, confirmed aborts, fresh conflict/receipt retries, and expired keys. Filegate integration tests cover CLI resume after a network failure and managed-root publication conflicts.

### Contacts could lose its last manager or accept a stale manager's change

- **What happened:** A book-bound API key counted as a manager, and a person lowered while waiting could still change another grant ([#1233](https://github.com/k2b-dev/cloud/issues/1233)).
- **Root cause:** Contacts counted every admin grant and authorized before locking its ACL rows.
- **Error class:** Manager invariant; ordering and concurrency.
- **Guard:** `access-last-manager.integration.test.ts` exercises the HTTP routes, localized `LAST_MANAGER` errors, concurrent self-demotions, stale authorization, agent managers, administration recovery, and outbox writes. Contacts locks the book before reading grants and rechecking the actor in the same transaction.

### Saving a permission shifts every row

- **What happened:** Changing one permission replaced every row's picker with a shorter badge until saving finished ([#1277](https://github.com/k2b-dev/cloud/issues/1277)).
- **Root cause:** The editor used pending state to choose between a control and a badge.
- **Error class:** A control swaps to a different element during a pending state and shifts layout.
- **Guard:** Permission editor behavior tests retain picker identity during grants, updates, and revokes and check failure recovery; Chromium tests compare row and control boxes before, during, and after an update at phone and desktop widths and check that keyboard focus returns to the changed picker. Convention: [Pending states keep the control](/en/ui/getting-started#pending-states-keep-the-control).

### Sized notebook images disappear in the editor

- **What happened:** Documented image size suffixes rendered in Book but produced no editor image, and Book did not accept a title after the size ([#1278](https://github.com/k2b-dev/cloud/issues/1278)).
- **Root cause:** CommonMark parsed only the image label when the destination contained a size suffix; Book and editor decorations also used separate size patterns.
- **Error class:** One Markdown dialect parsed differently by editor and renderer.
- **Guard:** Book and the editor's Lezer extension use `parseSizedMarkdownImage`. Their tests iterate the same `DOCUMENTED_IMAGE_FORMS` matrix for attachment and HTTPS images, dimensions, and titles; parser tests reject invalid forms and verify offsets.

### Workflow event payloads grew without bounds

- **What happened:** Workflow events kept payloads and deliveries indefinitely and accepted arbitrarily large JSON ([#1183](https://github.com/k2b-dev/cloud/issues/1183)).
- **Root cause:** Emission had no byte limit, and finished events had no payload retention.
- **Error class:** Unbounded storage growth.
- **Guard:** Event integration cases cover UTF-8 size limits before SQL, retained dedupe rows, dispatch age, resumable runs, repeated retention batches, and concurrently built retention indexes. Observability integration cases distinguish expired payloads from missing events. Mail integration cases emit an oversized message without its body through sync and backfill, and retry failed runs after event expiry while excluding succeeded runs. Convention: emitters keep large content out of events and let runs read it by reference; history queries use retained run context when event context and deliveries expire.

## Add a lesson

A fix pull request answers "How do we prevent this next time?" and adds its
entry here in four lines: what happened, root cause, error class, and guard.
When neither the code on `main` nor a test confirms the root cause, start it
with "Suspected:"; the fix pull request replaces it with the confirmed cause.
When the guard does not exist yet, write "Pending in #n" with the issue that
tracks it, or "None, because …". A pull request that adds a guard for a class
updates that class's row in the table.
