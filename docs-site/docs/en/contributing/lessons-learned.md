---
title: Lessons learned
navTitle: Lessons learned
section: Contributing
order: 1305
description: Name the error class of each bug and the guard that catches that class next time, and read the incidents that taught each class.
tags: [contributing, testing, quality]
updated: 2026-10-19
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
| Navigation truncation drift | Component or app CSS reintroduces an ellipsis, or a mask clips the navigation control's focus ring. | Tests: UI `truncate-fade-contract.test.ts` rejects ellipsis and line clamps across shipped navigation families; `truncate-fade.render.test.tsx` checks inner label classes; `sidebar-row-labels.browser.test.ts` checks overflow, resizing, RTL, focus, and stable heights. |
| Browser cookie store read races a document write | WebKit stores a `document.cookie` write asynchronously, so a test reading `context.cookies()` immediately can see the previous value ([#1496](https://github.com/k2b-dev/cloud/issues/1496)). | Check: `cookie-store` requires `storedCookie(page, name)` from `packages/ui/test/browser.ts` to wait until the store agrees with the document, or a leading `// cookie-store: <reason>` for a deliberate read such as an HttpOnly cookie. |
| Rate-limit scope and budget mismatch | Multi-request uploads exhaust the public page budget; per-link keys let clients bypass the upload cap by spraying tokens. | Tests: Files `public-rate-limit.integration.test.ts` checks the per-client (IPv6 /64) upload budget, token spraying and page isolation; `public-inbox.behavior.test.tsx` checks automatic waits and the terminal rate-limit message ([#1168](https://github.com/k2b-dev/cloud/issues/1168)). |
| Remote content in mail | A sent message or its preview loads an image from a remote address, so opening it tells the sender's server who read it and when. Mail images come only from stored bytes, sent as an inline `cid:` part and previewed as a `data:` URL. | Test: Mail `outbound-mime.test.ts` (the logo is a `multipart/related` inline part whose `Content-ID` matches the HTML, no `http(s)` image source) and `compose-renderer.test.ts` (Markdown images, `<img>`, and CSS `url()` or `image-set()` stay rejected). |
| Derived theme text color without a contrast guarantee | A fixed CSS mix derives text from an app accent, so a light accent such as yellow falls below 4.5:1 on the surfaces it sits on. | Test: `packages/cloud/src/ssr/app-color.test.ts` checks the computed ink of every declared app accent and edge accents against each listed background in both themes, and pins the background constant and the `:root` defaults to `tokens.css` and `@k2b/ui` ([#1205](https://github.com/k2b-dev/cloud/issues/1205)). No check covers other text colors derived in CSS yet. |
| A pinned color base drifts from the surface an element uses | A constant pins the background a derived color is mixed over. A shell change moves the element to another token, so the fill no longer matches the contract while value-only drift tests stay green. | Test: `packages/cloud/src/ssr/app-color.test.ts` reads the `.k2b-ui .k2b-app-workspace__sidebar` background declaration from @k2b/ui and checks that the navigation fill's base equals what it resolves to in both themes. |
| App colors lost at a dialog portal | App colors live only on the page canvas, so dialogs mounted under the body inherit platform defaults. | Tests: `packages/cloud/src/ssr/dialog-app-colors.browser.test.ts` checks portalled settings, selected rows, stable category geometry, and nested accent scopes in both themes and viewport sizes; `packages/cloud/src/ssr/Layout.render.test.tsx` checks the real shell's validated accent scope ([#1458](https://github.com/k2b-dev/cloud/issues/1458)). |
| A mutation’s refresh re-creates a rendered entity’s element | Refetched objects replace retained elements, losing focus and hover and leaving box reads detached. | Tests: Spaces kanban and detail claim tests use `keptThrough()` from `packages/ui/test/browser.ts` to check element identity and height; the held-card test distinguishes a retained card from one leaving its column ([#1391](https://github.com/k2b-dev/cloud/issues/1391)). |
| A restored entity shows twice, or a test reads it page-wide | Undo or a refresh puts an item back while the leaving copy still shows, or a page-wide role locator matches two elements. `expect(promise).resolves` hides why the read failed. | Test: the Spaces tray Undo and refresh tests use `mostAtOnce()` from `packages/ui/test/browser.ts`. Convention: scope reads to the entity's row and await reads directly ([#1450](https://github.com/k2b-dev/cloud/issues/1450)). |
| Nested event loop in a Playwright test | Bun's `expect(promise).resolves`/`.rejects` runs a nested event loop. Playwright's in-process channel then delivers messages out of order, protocol validation fails, the connection closes, pending calls reject, and stale JsonPipe messages throw `Cannot find object to "message": jsonPipe@…` into the next test. | Check: `browser-test-promises` rejects `.resolves`/`.rejects` in files that drive Playwright ([#1502](https://github.com/k2b-dev/cloud/issues/1502)). |
| Session URL in a server-side export | A server-side renderer gets a URL that only a signed-in browser can load, so the content silently disappears. | Tests: Notebooks `book-renderer.test.ts` checks that print HTML for every documented image form has no app, API, or `attach://` URL; `note-pdf-images.integration.test.ts` checks embedded images with `pdfimages` and zero requests with `gotenberg-trap.ts` ([#1280](https://github.com/k2b-dev/cloud/issues/1280)). |
| Unreported export loss | A PDF replaces content with a label, source, or error notice without telling the caller. | Tests: Notebooks `book-renderer.test.ts` checks typed omissions against rendered diagnostics and content order; `pdf-omissions.test.ts` checks the header budget; API and gateway tests check delivery. |
| Release notes parsed as HTML | HTML-like placeholders swallow release sections, so release-please skips a component or mixes its notes with another release. | Check: `release-body` CI job (`scripts/check-release-pr-body.ts`) parses release PR bodies with the pinned release-please parser; the `check` job reads live PR text on PR and merge queue runs and refuses markup in titles, body commit headers, BREAKING CHANGE paragraphs, and nested-commit blocks; a self-test checks that lint against the pinned commit parser ([#1298](https://github.com/k2b-dev/cloud/issues/1298)). |
| Silent truncation by a clamped page size | A caller asks for the whole collection with a page size above the helper's maximum and exports only the first page. | Check: `page-size` rejects oversized `pagination.perPage` literals. Tests: Contacts export pagination, cancellation, stream failure, serializer bytes, and the 1,001-contact integration case ([#1241](https://github.com/k2b-dev/cloud/issues/1241)). |
| Claim and assignment diverge | A person works on a task while assignment-based lists still show it as unassigned, or a stale assignee replacement removes an active worker. | Tests: `packages/spaces/src/service/claim-assignment.integration.test.ts` checks transactional user claims, guarded assignee replacements, forced releases, completion, and idempotent backfill ([#1269](https://github.com/k2b-dev/cloud/issues/1269)). |
| Paint outside a scrollport | An outline or outset shadow, such as a status ring, reaches past its element and a scrolling ancestor flush with it cuts it off. | Test: `packages/ui/src/layout/detail-panel-sections.browser.test.ts` checks that an avatar ring flush with the detail body paints inside the scrollport and keeps the avatar size. |
| Unbounded storage growth | Durable payloads have no size bound or retention. | Tests: workflow event integration cases cover byte limits, payload retention, dedupe, and resumable runs; workflow observability integration cases cover expired payloads; Mail integration cases cover oversized messages ([#1183](https://github.com/k2b-dev/cloud/issues/1183)) and body-less message events ([#1313](https://github.com/k2b-dev/cloud/issues/1313)); `chat-tasks.integration.test.ts` covers 90-day scheduled task run retention in bounded batches. |
| Retention deletes a dedupe guard | Expiring a one-off task's current occurrence lets its scheduled time run twice after reactivation. | Test: `chat-tasks.integration.test.ts` keeps the current slot row through completion and timezone reactivation while its turn and transcript expire, rejects a duplicate slot, and removes the row after the scheduled time changes. |
| Retention blocked by a dependent check | A row's `ON DELETE SET NULL` violates its own CHECK, so every delete of the referenced row fails and an oldest-first sweep stalls for good. | Test: `chat-tasks.integration.test.ts` expires a background turn that a workflow memory learning run points at. |
| Unreadable treated as missing | Startup replaces an unreadable or invalid stored value with an environment value. | Test: `packages/cloud/src/services/settings/bootstrap.integration.test.ts` preserves ciphertext and timestamps for undecryptable and invalid rows while reads use the environment fallback ([#1295](https://github.com/k2b-dev/cloud/issues/1295)). |
| Read fallback written back | A read fallback hides an unreadable row and a later merge writes that fallback over saved data. | Guard: settings store refuses unreadable rows by default; `unreadable.integration.test.ts` and Files configuration tests cover explicit recovery ([#1303](https://github.com/k2b-dev/cloud/issues/1303)). |
| Absence from an empty provider answer | An empty or failed provider read is taken as proof that a message is gone. A command fails as missing, a delete or move is confirmed, a body is marked missing, or a reconcile window retires messages. | Test: `%s confirms an empty FETCH answer before it reports a message as gone` in `packages/mail/src/service/connectors/imap-smtp.test.ts` drives real ImapFlow against a throttling fixture for every connector read that can infer absence ([#1244](https://github.com/k2b-dev/cloud/issues/1244)). Convention: a new connector read that infers absence confirms it with the same helper. |
| Motion choice ignored | JavaScript or a separate document animates despite the person's reduced-motion choice. | Tests: `MailConversationReader.behavior.test.tsx` checks the choice at jump time; `MailMessageBody.browser.test.ts` checks initial and live propagation into the sandboxed message and rejects frame-originated motion messages ([#1230](https://github.com/k2b-dev/cloud/issues/1230)). |
| One Markdown dialect parsed differently by editor and renderer | Separate parsers disagree about documented source forms, so an image renders in one view and disappears in another. | Shared helper: Notebooks uses `parseSizedMarkdownImage` in Book and Lezer. Test: both views iterate `DOCUMENTED_IMAGE_FORMS` for attachment and HTTPS images with sizes and titles ([#1278](https://github.com/k2b-dev/cloud/issues/1278)). |
| Shared renderer configuration race | Concurrent Mermaid consumers overwrite singleton configuration before a queued render reads it. | Test: Notebooks `mermaid-render.test.ts` checks serialized configuration and rendering, call order, and recovery after rejection. Convention: all Notebooks Mermaid consumers use `renderMermaid`. |
| Screen-only layout printed as-is | Browser printing includes navigation, toolbars and detail panels, or clips content at a fixed-height scrollport. | Tests: `packages/cloud/src/ssr/print.browser.test.ts`, `packages/ui/src/layout/workspace-print.browser.test.ts`, and Notebooks `note-print-copy.browser.test.ts` emulate print and check complete content. Convention: every view supplies printable content or an export hint; see [Browser printing](/en/ui/layout/print) ([#1281](https://github.com/k2b-dev/cloud/issues/1281)). |
| Workspace-only export | A published package imports code that exists only in the workspace copy of a pinned sibling; workspace links hide the missing export. | Check: the `packed` CI job runs with `--release` on the release pull request and in the merge queue, resolving already published sibling pins from npm. Convention: [refresh the release PR after the last feature PR merges](/en/docs/contributing/release-process#let-release-please-cut-the-release). |
| Raw keys in UI text | An open action string falls through a switch and becomes an untranslated label. | Test: Notebooks `activity-messages.test.ts` checks service literals, both actor forms in English/German, and neutral unknown-action labels. Exhaustive catalog records require every typed action. |
| Internal identifiers and raw errors shown to people | A routine notification or chat line shows a short ID or a raw English error instead of the routine name and a reason sentence. | DB CHECK: `ai_chat_tasks_reason_state_check` ties state to reason code. Tests: `chat-task-reasons.test.ts`, `chat-tasks.integration.test.ts`, Core `ai-notifications.test.ts` and `ai-notifications.integration.test.ts` check names, localized reasons, stop receipts and notification deduplication. |
| Time | A test or a render depends on today's date, the time zone, or randomness, so it passes on one day and fails on another. | Check: `test-clock` rejects new unpinned clock reads in UI tests, fixtures, harnesses, and suites. Tests: the Chat browser harness pins fixtures and pages to `chatTestNow` ([#1209](https://github.com/k2b-dev/cloud/issues/1209)); the Assistant sidebar test from [#1121](https://github.com/k2b-dev/cloud/pull/1121) freezes its clock. |
| Date-only value passes through a time zone | A calendar date, such as a birthday or an all-day deadline, is stored, parsed, or exported as an instant, so it moves to another day west or east of UTC or gains a time nobody chose. | Tests: Contacts `locale-formatting.test.ts` ([#1364](https://github.com/k2b-dev/cloud/pull/1364)); `@k2b/ui` `date-picker.render.test.tsx` labels a date key in every picker and runtime zone; Spaces `presentation/deadline.test.ts`, `task-overdue.test.ts`, `service/ical.test.ts` (also with the server process in another zone) and `api/deadlines.integration.test.ts` keep a date-only deadline on its day west and east of UTC. Convention: a date-only value stays a `YYYY-MM-DD` string in storage (`DATE`, read as text), transport, and comparison. |
| Fixed wait instead of a condition | A test sleeps a fixed time and assumes the state it needs arrived. Under load, it has not arrived or has already passed. | Check: `test-waits`. Test: the live-routes slow-client test waits for the server's `1013` close before it resumes the client ([#1440](https://github.com/k2b-dev/cloud/issues/1440)). |
| State sampled before it settled | A test reads styles, geometry, or counts once, right after an action or a load, while a transition, a stylesheet, or an input is still on its way. Under load, the read lands mid-change. | Test: the OAuth `authorization-page.browser.test.ts` case holds `global.css` back until the card was styled once. Its `open()` emulates reduced motion and waits for every finite document-timeline animation to finish before any read ([#1476](https://github.com/k2b-dev/cloud/issues/1476), [#1499](https://github.com/k2b-dev/cloud/issues/1499)). |
| Settling on scroll-driven animations | A test waits for every page animation to finish, but scroll-driven animations never finish, so it hangs. | Check: `animation-settle` requires a timeline mention beside document-wide and subtree animation calls so settle waits filter to `animation.timeline === document.timeline`. |
| Loopback receive queue collapse | A browser reads a large response from a test server on `127.0.0.1` slowly while the machine is busy. On the CI runner's Linux 6.17 kernel, its socket's receive queue fills, the kernel prunes it and drops data, and the receive buffer shrinks to about 1 KB. The response never completes, so the page never fires load. | Check: the `ci-install` check makes every CI and nightly job install through `.github/actions/install`. That action sets an 8 MiB default receive buffer before any test starts, and its job fails when the setting fails ([#1367](https://github.com/k2b-dev/cloud/issues/1367)). |
| Crash in a pinned browser build | A browser process of the pinned Playwright build crashes during a test. The test sees only a vague error, such as WebKit's internal error, and the next test passes with a new process. | Check: the CI `webkit` job records every crashed process on the runner with `.github/process-crashes.sh` and lists it as a job error. Test: `packages/ui/test/browser.browser.test.ts` checks that a failed navigation names each failed request with its error and that WebKit's internal error adds the hint ([#1431](https://github.com/k2b-dev/cloud/issues/1431)). |
| Popover opened during a pointer release | A drag ends in its pointerup handler, which opens an `auto` popover. The browser then light-dismisses it at the end of the same pointerup, as the HTML popover rules ask; Chromium 156 does so. | Tests: the Spaces month view checks that a drag opens the quick create and keeps it, and the Spaces day view checks the same for a drag in free time. Convention: open a popover at the end of a drag with `afterPointerRelease()` from `packages/ui/src/content/calendar-pointer.ts` ([#1431](https://github.com/k2b-dev/cloud/issues/1431)). |
| Lease starvation under a continuous competing workload | A class of work keeps the lease while competing work retains places and retries without progress; an unindexed lookup on a growing table under the provider lease extends each turn. | Test: Mail’s `provider-lease-fairness.integration.test.ts` checks command progress during continuous folder syncs, sync progress under old command backlogs, and a total order with one first waiter ([#1268](https://github.com/k2b-dev/cloud/issues/1268)); “a folder sync waits for at most one move set's two seconds and a few slow statements while each marker and settle statement is slow” guards constant per-set costs for per-statement marker and settle slowdowns ([#1013](https://github.com/k2b-dev/cloud/issues/1013)). Test: `packages/mail/src/service/command-target-index.integration.test.ts` checks that the plans of the per-message command lookups use `commands_message_target_idx` ([#1247](https://github.com/k2b-dev/cloud/issues/1247)). |
| Shared subprocess lost after timeout | Bun kills a shared browser when one test times out, so later tests fail too. | Test: `packages/ui/test/browser.browser.test.ts` runs a child suite with one hung test and checks that three later tests still open pages ([#1254](https://github.com/k2b-dev/cloud/issues/1254)). The same test checks that the late error of the hung test names the step it waited for, not its `page.context().close()` cleanup ([#1355](https://github.com/k2b-dev/cloud/issues/1355)). |
| Browser shutdown outlives cleanup | A browser hangs on exit beyond Bun's hook timeout, leaving its shutdown to overlap the next file's launch. | Test: `packages/ui/test/browser.browser.test.ts` stops a local browser's process group, checks that bounded close kills every process within the hook budget, and opens a page in the next browser ([#1473](https://github.com/k2b-dev/cloud/issues/1473)). |
| Test work outlives its test | bun:test does not stop a timed-out test body; it keeps running into later tests and can call stand-ins or change state that a later test owns. | Test: `packages/mail/src/service/remote-changes-teardown.integration.test.ts` runs a child suite with one hung sync and checks that the next test sees no foreign connector calls or rows ([#1460](https://github.com/k2b-dev/cloud/issues/1460)). Convention: [a test ends the work it starts](/en/docs/contributing/testing#run-integration-tests). |
| Navigation stall without evidence | A test waits for a navigation's load event. The event never comes, and the timeout names only the URL. | Test: `packages/ui/test/browser.browser.test.ts` checks the diagnosis for an uncommitted and a committed stalled navigation, and for a navigation that Bun's test timeout cuts off. Convention: [open each URL state in its own page](/en/docs/contributing/testing#test-in-chromium-and-webkit) ([#1367](https://github.com/k2b-dev/cloud/issues/1367)). |
| Cleanup rewrites the reported error | A `finally` block calls Playwright after the browser closed. Playwright rejects every call on a closed connection with one shared error object and rewrites its message and stack, so the test reports the cleanup line instead of the step that hung. | Test: the child suite of `packages/ui/test/browser.browser.test.ts` hangs in a navigation until Bun's timeout and checks that the error carries the navigation diagnosis and no `removeListener` ([#1367](https://github.com/k2b-dev/cloud/issues/1367)). Convention: launcher helpers attach page listeners for the life of the page and never call Playwright in cleanup after a failure. |
| Scroll undoes a transient state | A step scrolls the page. The browser dispatches the scroll, and in WebKit a hover update for a resting pointer, after the next step. A tooltip, popover, or menu that closes on scroll or hover closes, and a wait for it never resolves. | Convention: [let a frame pass after a scrolling step, and do not mix clicks into a keyboard flow that scrolls](/en/docs/contributing/testing#test-in-chromium-and-webkit). Test: Notebooks `notebook-charts.browser.test.ts` waits a frame in `showFirst` and toggles tables by keyboard ([#1355](https://github.com/k2b-dev/cloud/issues/1355)). No automatic check finds other tests yet. |
| Hover kept after its element left | A container keeps a state, such as a paused timer or a list that stops following, from `pointerenter` until `pointerleave`, while its content changes under a resting pointer. WebKit sends no `pointerleave` when the hovered element leaves the document, so the state stays after the pointer went. | Convention: [confirm a hover state with the next `pointerover`](/en/docs/contributing/testing#test-in-chromium-and-webkit). Tests: `packages/ui/test/feedback-runtime.behavior.test.ts` releases a toast hold whose hovered control is removed ([#555](https://github.com/k2b-dev/cloud/pull/555)); Files `UploadPanel.browser.test.ts` removes a row's byte count from under the pointer, moves the pointer away, and checks that the list follows again and a finished panel leaves ([#1371](https://github.com/k2b-dev/cloud/issues/1371)). No check finds other containers yet. |
| Repeated JSX slot construction | A presence check and its content both read a JSX prop getter, constructing a discarded element without matching server DOM during hydration. | Tests: `packages/ui/src/actions/actions.render.test.tsx` checks one construction per head slot; `workspace-head-hydration.browser.test.ts` hydrates real JSX slots, checks errors, duplicates and geometry, then opens More. |
| Server render vs. mount | An island replaces the server HTML when it mounts; see [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). When the server and the browser render different markup or styles, the page moves on mount or after a reload, and WebKit can keep stale styles from before the mount. | Convention: [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). Test: the month view browser tests from [#1157](https://github.com/k2b-dev/cloud/pull/1157) check row places right after mount. The `@k2b/ui` sidebar reload test from [#1154](https://github.com/k2b-dev/cloud/issues/1154) compares the server frame, the frame right after mount, and the settled frame after a reload. No shared test does this for other islands yet. |
| Layout shift | A transient state, such as a status text, a notice, or a loader, appears in the layout flow and moves its neighbors. | Convention: [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still) ([#1143](https://github.com/k2b-dev/cloud/pull/1143)). Each change applies its browser-test pattern, which compares bounding boxes before and after each state change. Test: `chat-composer.browser.test.ts` checks pending slash searches and command status at desktop and phone widths. `PermissionEditor.behavior.test.tsx` checks control identity during saving; `PermissionEditor.browser.test.ts` compares row and control boxes at phone and desktop widths ([#1277](https://github.com/k2b-dev/cloud/issues/1277)). The mailbox logo `<img>` carries width and height (`compose-renderer.test.ts`, `outbound-mime.test.ts`), and `MailComposeSettings.browser.test.ts` / `MailComposerEditor.browser.test.ts` compare its box before and after the image loads ([#1097](https://github.com/k2b-dev/cloud/issues/1097)). No automatic check catches every flow. |
| Focus lost on refresh | A list keys an element by derived content instead of a stable identity. When its data refreshes or grows, the list re-creates the focused element and focus falls to the page body. | Tests: `packages/ui/src/content/calendar-days.browser.test.ts` — "the day view keeps the focus on a run of empty days while days join it at either end" and "the day view keeps a focused event when the clock updates its free time"; Spaces tray — "keeps keyboard focus on a task of the tray while a refresh brings the same tasks again" and "reaches the tray right after the day with the keyboard". Convention: [A11Y-16](/en/docs/conventions/frontend#accessibility-a11y), with [Keep focus while content refreshes](/en/ui/focus#keep-focus-while-content-refreshes). Check: `access-editor-mounts` rejects keyed and refreshing-gated ancestors of shared access editors; `PermissionEditor.browser.test.ts` checks that keyboard focus survives a consumer refetch ([#1283](https://github.com/k2b-dev/cloud/issues/1283)). |
| State lost on navigation or reload | Clearing, cancelling, reloading, or going Back does not return the person to where they started, or drops input that was not saved yet. | Convention: [Test URL behavior](/en/docs/frontend/testing#test-url-behavior) covers reload, Back, Forward, and opened links. Test: `reload.behavior.test.ts` keeps open dialogs through automatic reload requests and offers the reload after they close ([#1176](https://github.com/k2b-dev/cloud/issues/1176)). `chat-slash.behavior.test.ts` guards restoration of unchanged command drafts after cancellation or failure. No shared guard covers unsent local edits outside dialogs yet; Grids tests the leave warning of its public forms in `PublicFormSubmit.behavior.test.tsx`, and Notebooks tests that a sync error keeps unsent text in `sync-ended.behavior.test.tsx` and `provider.test.ts`. |
| Focus lost on refresh | A list keys an element by derived content instead of a stable identity. When its data refreshes or grows, the list re-creates the focused element and focus falls to the page body. | Tests: `packages/ui/src/content/calendar-days.browser.test.ts` — "the day view keeps the focus on a run of empty days while days join it at either end" and "the day view keeps a focused event when the clock updates its free time"; Spaces tray — "keeps keyboard focus on a task of the tray while a refresh brings the same tasks again" and "reaches the tray right after the day with the keyboard". Convention: [A11Y-16](/en/docs/conventions/frontend#accessibility-a11y), with [Keep focus while content refreshes](/en/ui/focus#keep-focus-while-content-refreshes). No automatic check yet. |
| State lost on navigation or reload | Clearing, cancelling, reloading, or going Back does not return the person to where they started, or drops input that was not saved yet. | Convention: [Test URL behavior](/en/docs/frontend/testing#test-url-behavior) covers reload, Back, Forward, and opened links. Test: `reload.behavior.test.ts` keeps open dialogs through automatic reload requests and offers the reload after they close ([#1176](https://github.com/k2b-dev/cloud/issues/1176)). `chat-slash.behavior.test.ts` guards restoration of unchanged command drafts after cancellation or failure. `dialog-history.behavior.test.ts` keeps dialog-only Back events out of application navigation listeners. No shared guard covers unsent local edits outside dialogs yet; Grids tests the leave warning of its public forms in `PublicFormSubmit.behavior.test.tsx`, and Notebooks tests that a sync error keeps unsent text in `sync-ended.behavior.test.tsx` and `provider.test.ts`. |
| Data-sized startup work | Startup runs a migration step whose work grows with stored data, so every start of a large installation waits for it. | Test: Contacts `migrate.integration.test.ts` checks required short-ID columns, format constraints, and unique indexes on fresh databases, unchanged row versions and IDs on finalized databases, and refusal before later DDL on unfinished schemas ([#1242](https://github.com/k2b-dev/cloud/issues/1242)). Convention: [DATA-05](/en/docs/conventions/access-and-data#data-and-effects-data) moves data-sized migrations into bounded, resumable batches. |
| Uncompressed dynamic response | Dynamic HTML/JSON can waste bandwidth, but compressing repeatedly writable outside text beside unreadable text, personal submissions or secrets worth guessing creates a BREACH oracle, including same-origin live refetches. | Guard: mount `middleware.noTransform()` first on the owning router. Router tests cover marked paths and compressed siblings (container names, backlink titles and display names count as chosen text beside private content; metadata alone is not an oracle); middleware tests cover failures and streaming. Gateway `proxy.test.ts` checks byte-identical no-transform pass-through, identity bodies for cross-site requests and subresource loads (Markdown images can request same-origin URLs of an attacker’s choice that a page echoes), and compression budgets for eligible bodies. |
| Data-sized work on a hot path | An interaction or refresh rebuilds data it does not change: a full mailbox snapshot per list page, a full snapshot per opened conversation, or a full snapshot per loaded page on each live event. Cost grows with mailbox and list size. | Tests: Mail `MailWorkspace.list-pages.behavior.test.tsx` checks that pages from 2 on and a live refresh with N loaded pages send one `workspace-route` and N-1 `workspace-list` requests. `workspace-list.integration.test.ts` checks that `loadMailboxListView` never reads view counts, identities, the mailbox, the scheduled count, the receiving address, the live cursor, local tags for the mailbox, or selection detail. `MailWorkspace.conversation-open.behavior.test.tsx` checks that opening conversations in the same list sends one `workspace-detail` and no `workspace-route`, keeps every loaded row and its DOM node, and that Back, Forward and close use the same path; `workspace-detail.integration.test.ts` checks parity with the snapshot's selection fields for mailbox-wide and assigned-only readers and keeps the workspace-detail and snapshot bytes of a fixture thread within a byte budget. |
| Status derived only on the success path | A state that every new message must set is derived only when the work succeeds, so a terminal failure leaves the old state. | Tests: terminal hydration cases in `conversation-work-state.integration.test.ts` and `terminally failed newer reply reopens automation Done` in `incoming-automations.integration.test.ts` ([#1258](https://github.com/k2b-dev/cloud/issues/1258)). |
| Ordering and concurrency | Work for one item runs in parallel or races another writer, so results land out of order or a later step undoes an earlier one. | Convention: the order and no-drop rules in [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) ([#1148](https://github.com/k2b-dev/cloud/pull/1148)) cover actions in the browser. Test: Chat's send queue keeps the browser posts of one conversation in order in `chat-sends.test.ts` ([#1145](https://github.com/k2b-dev/cloud/issues/1145)). `PermissionEditor.behavior.test.tsx` keeps one access change in flight per editor: it checks pending rows, blocked picks while a grant saves, duplicate picks, failure recovery, and silent cancellation. Contacts `access-last-manager.integration.test.ts` orders HTTP changes behind a held book lock to check concurrent self-demotions and stale authorization ([#1233](https://github.com/k2b-dev/cloud/issues/1233)). No shared guard covers server-side writers yet; Mail's command queue has an integration test for server-side order in `conversation-actions.integration.test.ts`, and `incoming-automations.integration.test.ts` and `conversation-work-state.integration.test.ts` check that a status decision survives the hydration of a message it covers ([#1142](https://github.com/k2b-dev/cloud/issues/1142)). The status step also works when another message was already linked but still waits for loading. The view records its snapshot and link order. Only a message that joined after the view keeps the conflict ([#1216](https://github.com/k2b-dev/cloud/issues/1216)). Files' `filegate-lifecycle.integration.test.ts` and `files.integration.test.ts` cover concurrent private commits, one shared root-lock wait budget per request, and immediate attempts without a wait ([#1165](https://github.com/k2b-dev/cloud/issues/1165)). |
| Manager invariant | A resource-bound key counts as a manager, letting the last durable manager leave. | Test: Contacts `access-last-manager.integration.test.ts` refuses removal and demotion next to a book-bound key, and covers agent managers and administrator recovery ([#1233](https://github.com/k2b-dev/cloud/issues/1233)). |
| Authorization copies | A caller re-implements the resource permission decision and its copy drifts, so one path grants what another denies. | Tests: Contacts `book-permission-paths.test.ts` rejects transport pre-checks (`requireBookAccess`/`requireBookPermissionInternal` outside `failAfterBookAccess`), `book.authorize`, hand-built user subjects in `api/`, intent `level` on `book.get`/`contact.get` outside `failAfterBookAccess`/`requireBookPermission`/`resolveContactAtLevel`, and credential scope caps outside the service; it restricts authorization and administration to their owners (ACC-02). `service/authorization.integration.test.ts` calls every book-scoped service operation with each identity kind. `book-permission.integration.test.ts` covers grants, exact resource bindings, credential scope limits, and separate administration access through API, capabilities, SSR, and live updates ([#1234](https://github.com/k2b-dev/cloud/issues/1234)). |
| Approval gate skipped on a second execution path | A review gate runs on one path to an operation while background runs or background Code Mode skip it. | Tests: `authorizeBackgroundAction` in `background-review.test.ts`, background loaded capability cases in `capabilities.test.ts`, and background runtime capability cases in `capability-runtime.test.ts`. Convention: both routine paths call the shared `authorizeBackgroundAction` before executing an Action that needs approval. |
| Deadline shorter than bounded work | A control request times out while its valid work still runs, so retrying repeats the failure. | Tests: Files `filegate-timeout.test.ts`, `upload-commit-route.test.ts`, `filegate-transfer.integration.test.ts`, `upload-retry.behavior.test.tsx`, and `cli-upload.test.ts` cover commit budgets and recovery ([#1164](https://github.com/k2b-dev/cloud/issues/1164)). |
| Transient failure amplified across queued work | One temporary failure immediately fails each subsequent queued item. | Tests: Files `upload-retry.test.ts`, `upload-retry.behavior.test.tsx`, `cli-upload.test.ts`, and `filegate-transfer.integration.test.ts` cover pause, bounded retries, cancellation, and session reuse ([#1163](https://github.com/k2b-dev/cloud/issues/1163), [#1167](https://github.com/k2b-dev/cloud/issues/1167)). |
| Silent failure | Async work fails and the person sees nothing, or a progress text stays as the last word. | Convention: [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) for single actions. Test: Assistant executor integration tests classify an empty answer after a failed step, also after worker recovery; timeline behavior and browser tests keep the failure notice at the turn's end ([#1150](https://github.com/k2b-dev/cloud/issues/1150)). Files transfer deadline tests cover stalled requests and response bodies, and CLI tests cover stalled preparation and visible errors. Files upload outcome tests retain temporary transfer progress, discard dead keys, and expose the cause ([#1166](https://github.com/k2b-dev/cloud/issues/1166)). No shared guard covers other background work yet. |
| Hidden locale default | An English fallback replaces an application-owned row label because a default parameter hides a missing locale. | Contacts draft helpers require localized row labels. Test: `ContactUpsertForm.model.test.ts` checks German and English labels through the quick-edit payload path ([#1237](https://github.com/k2b-dev/cloud/issues/1237)). |
| Empty-state meanings collapsed | One hint describes several scopes with different meanings, and translations give different instructions. | Tests: Contacts `contacts-empty-state.test.ts` checks scope, filter precedence, write access, and the creation action in English and German. `ContactsResults.render.test.tsx` checks the initial rendered states; `results-i18n.test.ts` checks both catalogs ([#1238](https://github.com/k2b-dev/cloud/issues/1238)). |
| Foreign system contracts | Cloud sends a schema or a payload that a foreign system, such as a model provider or Filegate, does not accept. | Partial test: the chart tool schema is checked for provider shape (one root object without `oneOf`, `anyOf`, or `allOf`, and no tuple `items`) in `packages/cloud/src/ai/chart-block.test.ts` and `default-tools.test.ts`. Test: `tests/capability-tool-schemas.test.ts` builds every app's capability tools the way the Assistant does and checks the same provider shape for each input schema ([#1149](https://github.com/k2b-dev/cloud/issues/1149)). No guard covers Filegate payloads yet. |
| Prompt claims drift from the tool set | A system prompt says a tool is unavailable or has limits it does not have, so the model avoids a tool it has or promises one it lacks. | Test: `packages/core/src/ai-background-prompt.test.ts` builds the scheduled tool set through `createAiTurnCodeAndClientTools()` and checks the prompt's Code Mode and interactive-limit claims ([#1366](https://github.com/k2b-dev/cloud/pull/1366)). No guard covers other prompt claims yet. |
| Server-side request forgery | A person-chosen address reaches the server’s private network or changes between validation and connection. | Check: `network-guard` lets only the platform guard resolve host names. It also rejects global `fetch()` in Pulse server code. Test: platform allowlist and resolution tests, plus Tools and Pulse refusal, redirect, and pinned-transport tests. |
| Escaped text input | An agent writes `\n` as two characters through a shell argument or double-escaped JSON, and the text is stored and shown with a literal backslash. | Test: Spaces rejects such inline CLI text and capability text inputs ([#1178](https://github.com/k2b-dev/cloud/issues/1178)). No shared guard covers inline text in other apps, such as `cld notebooks write --content`, yet ([#1193](https://github.com/k2b-dev/cloud/issues/1193)). |
| Breakpoint gap | Two neighbouring media queries end at `max-width: 1023px` and start at `min-width: 1024px`. A fractional width between them, such as a zoomed window, matches neither, and the page falls back to its base rules. | Test: `packages/cloud/src/styles/shell-modes.test.ts` pins the shell queries to `min-width` and its negation `not all and (min-width: …)` ([#1255](https://github.com/k2b-dev/cloud/issues/1255)). Range syntax such as `width < 64rem` is no guard: the build lowers it to `max-width: calc(64rem - .001px)`. No check covers other style sheets yet. |
| Responsive decisions measured different containing areas | The workspace follows its `k2b-app-area` host while app chrome or a command follows the wider window, so an app beside a panel shows desktop chrome around an overlay sidebar. | Tests: the `app-host.browser.test.ts` comparisons in Chat, Grids, and Notebooks and `app-overview-host.browser.test.ts` compare a narrowed host in a wide window with a window as wide as the host; Notebooks' full-width tests cross the host's 64 rem boundary at a fractional width without resizing the window, also for the settings switch that mounts outside the host; `panel-slot.browser.test.ts` checks shell focus beside the open panel ([#1382](https://github.com/k2b-dev/cloud/issues/1382)). Test: `packages/ui/src/layout/app-host-width.browser.test.ts` pins fractional widths, host-only resize, container-name changes, and cleanup. Check: `host-breakpoints` rejects new viewport rules for workspace chrome; known content layouts remain baselined for #1454. |
| Nested surface | A view fills its work area but draws its own rounded border, making a second card inside the app card, as in the Notebooks graph and attachments empty state. | Check: `workspace-surfaces` detects full-area framed elements, filling `Paper` elements, and paper panel placeholders. Convention: [UI-22](/en/docs/conventions/frontend#visual-ui-ui) and [Workspace surface hierarchy](/en/ui/layout/workspace) keep full-area views on Main's surface. |
| Theme in print | The screen theme reaches paper: dark-theme text and surfaces print on white paper, or print rules show what the screen hides on purpose. | Test: the Mail printing browser test in `MailConversationList.browser.test.ts` prints a dark and a light conversation through Print conversation in Chromium and WebKit. It checks contrast against the printed surface, the sender rows, and the single quote label ([#1175](https://github.com/k2b-dev/cloud/issues/1175)). No shared guard yet: native printing still prints the dark theme on every other page ([#1274](https://github.com/k2b-dev/cloud/issues/1274)). |
| Preference change escapes its audit transaction | A remembered approval changes without audit evidence, or global SQL inside a transaction callback commits the change despite an audit failure. | Test: `packages/cloud/src/ai/approvals.integration.test.ts` checks exact event metadata, no-op revocations, and rollback of remember, replacement, revoke, forget, and system changes when audit insertion fails. |
| Inert server-rendered interaction | Interactive markup is rendered without an island, or browser inspection receives drawing labels instead of display labels. | Tests: Grids `page.render.test.tsx` checks display-only chart islands and SVG parity; `chart-tooltip.test.ts` checks named, formatted tooltips; `chart-tooltips.browser.test.ts` checks inspection and layout across mounting. Check: `chart-rendering` fails on raw stdlib chart renderers outside the allow-list and on charts outside islands. |

## Lessons

### A throttled Mail provider looked like a missing message

- **What happened:** Empty reads could fail commands as missing, confirm deletes or moves, mark bodies missing, or retire local messages ([#1244](https://github.com/k2b-dev/cloud/issues/1244)).
- **Root cause:** ImapFlow ends FETCH without rows when its throttle retries run out. SEARCH returns false on command failure. Mail treated these answers as absence.
- **Error class:** Absence from an empty provider answer.
- **Guard:** `%s confirms an empty FETCH answer before it reports a message as gone` in `packages/mail/src/service/connectors/imap-smtp.test.ts` drives real ImapFlow against a throttling server for every affected read. New reads that infer absence use the same confirmation helper. A source the provider lists but never delivers still uses the missing-source budget (`downloadSourceBatch skips a source the provider lists but never delivers and streams the rest`).

### Server-rendered charts need an island for inspection

- **What happened:** Grids Custom App charts displayed their plots but offered no hover, keyboard, or tap inspection on published pages. The builder preview also lost category names in tooltips.
- **Root cause:** The page rendered the chart outside an island. The plot deliberately suppressed category labels inside SVG, so default tooltips could not recover those names or the block's value format.
- **Error class:** Inert server-rendered interaction.
- **Guard:** Grids `chart-tooltip.test.ts` checks category and aggregation labels and value formatting. `page.render.test.tsx` checks the chart island, SVG parity, and display-only serialized props for signed-in and anonymous pages. `chart-tooltips.browser.test.ts` covers real island mounting, hover, keyboard, tap, and server/browser layout parity at desktop and phone widths.

### release-please skipped the Cloud release 0.44.0

- **What happened:** Merging release PR #1248 created the npm releases but no `cloud-v0.44.0`; images and CLI assets needed a manual recovery ([#1298](https://github.com/k2b-dev/cloud/issues/1298)).
- **Root cause:** A BREAKING CHANGE footer contained `<dir>`-style text. release-please parses the release PR body as HTML, so the unclosed tag swallowed the Cloud section.
- **Error class:** Release notes parsed as HTML.
- **Guard:** The `release-body` CI job parses each release PR body with the pinned release-please parser, on the PR and in the merge queue. Its self-test fails on the #1248 body as merged. The `check` job refuses such markup in PR titles and release text in PR bodies. [Release process](/en/docs/contributing/release-process#recover-a-release-that-release-please-skipped) records the recovery.

### Contacts exports stopped at 1,000 contacts

- **What happened:** CSV and vCard book exports silently omitted contacts after the first 1,000 ([#1241](https://github.com/k2b-dev/cloud/issues/1241)).
- **Root cause:** The export requested `perPage: 100_000`, which `paginate()` silently clamped to 1,000.
- **Error class:** Silent truncation by a clamped page size.
- **Guard:** `page-size` rejects oversized pagination literals. Contacts unit tests cover keyset cursors, cancellation, serializer bytes, and failed streams; `export.integration.test.ts` checks both downloads with 1,001 contacts.

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
- **Root cause:** Consumers keyed the whole editor by refetched data or hid it during refresh. Contacts also replaced its pickers with read-only badges while reloading. Keeping the editors mounted exposed two refresh races: mutation success could overwrite a caller's newer permission list after loading cleared, and key creation could insert a credential already supplied by the caller.
- **Error class:** List re-keyed on refresh drops focus.
- **Guard:** Check: `access-editor-mounts` rejects keyed, `refreshing()`-gated, or resource `loading`-gated `Show` and `Match` ancestors. Tests: `PermissionEditor.browser.test.ts` preserves the focused chip after a keyboard change and consumer refetch at phone and desktop widths; behavior tests cover merging by id, stale refetches after a save, deferred updates, caller copies, and Contacts and Venue reloads. `PermissionEditor.behavior.test.tsx` checks that caller refreshes win after update and revoke callbacks finish; `ResourceApiKeys.behavior.test.tsx` checks that creation replaces a refetched credential in place without duplicating it.

### Accepted iPhone photos failed in a closed settings panel

- **What happened:** Tools accepted HEIC files, but browsers without native HEIC support showed no image or visible failure ([#1284](https://github.com/k2b-dev/cloud/issues/1284)).
- **Root cause:** Image loading depended on native browser decoding. Load errors appeared only in a detail panel that was closed for an empty batch or on phones.
- **Error class:** Accepted input that the pipeline cannot process fails silently.
- **Guard:** Every accepted file becomes an image or a visible per-file failure with a recovery hint in the main area. `image-intake/intake.test.ts` checks every accepted type and English and German recovery messages. Converter render and browser tests keep failures in the main area and preserve card order and position. `heif-decoder.test.ts` checks that a decoder that fails to load or crashes ends each waiting file in a visible failure. `image-processor-crop.behavior.test.tsx` checks that drops during a load or a crop are queued or listed, never only reported in the closed side panel.

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

### App chrome followed the window beside a panel

- **What happened:** With Cloud's panel column open, an app's workspace switched to the overlay sidebar while Chat, Grids, Notebooks, Mail, Venue, Tools, the overview columns, and shell focus still showed desktop chrome; shell focus hid the overlay navigation with no way back, and Notebooks offered full width where it had no effect ([#1382](https://github.com/k2b-dev/cloud/issues/1382)).
- **Root cause:** App and shell styles used viewport breakpoints at 64 rem, and Notebooks' full-width script used `matchMedia` and a rounded `clientWidth`, while the workspace measures its nearest `k2b-app-area` host. A dialog mounts outside that host, so a container query there still measures the window.
- **Error class:** Responsive decisions measured different containing areas.
- **Guard:** The `host-breakpoints` check rejects new viewport decisions for workspace chrome. The shared `app-host-width.browser.test.ts` checks fractional widths, host-only resize, container-name changes, and cleanup. The app-host comparisons, overview host test, Notebooks' full-width behavior test, and shell focus test cover the consuming surfaces.

### One hung browser test failed the rest of its file

- **What happened:** One timeout in the bare dialog suite caused 20 later browser tests to fail ([#1254](https://github.com/k2b-dev/cloud/issues/1254)).
- **Root cause:** Bun's timeout cleanup sends SIGTERM to every subprocess the test process started, including the shared browser. A browser still shutting down can report itself connected while page creation fails with a protocol error.
- **Error class:** Shared subprocess lost after timeout.
- **Guard:** `packages/ui/test/browser.browser.test.ts` checks that only the hung test fails and three later tests pass. For local launches, it also checks that Bun killed the browser. The launcher replaces a disconnected browser or retries a failed page or context creation once. Pages and contexts must be opened per test.

### A timed-out Mail sync kept running in the next test

- **What happened:** The 650-message first-sync test without CONDSTORE timed out under load, then reported its envelope-count failure during the next test ([#1460](https://github.com/k2b-dev/cloud/issues/1460)).
- **Root cause:** Full message ingestion took about 23 database round trips per message, about 15,000 for 650 messages. Lease and pacer work stayed constant per batch; CONDSTORE did not cause the cost ([#1487](https://github.com/k2b-dev/cloud/issues/1487) tracks the per-message cost). bun:test kept the timed-out body running while teardown restored its shared connector spies and the next test installed new ones. Later batches called the next test's spies.
- **Error class:** Test work outlives its test.
- **Guard:** `remote-changes-teardown.integration.test.ts` holds a sync's envelope fetch through a timeout and checks that only the hung test fails, its late rejection stays with it, and the next test sees only its own connector calls and rows. The suite fixture rejects ended accounts and cancels and awaits tracked work before restoring spies. The first-sync regression needs only 201 messages to cover two batches and reconciliation in the last batch. Other Mail suites still restore per-test connector spies in the test body ([#1488](https://github.com/k2b-dev/cloud/issues/1488)).

### A chart test waited for a tooltip that a late scroll closed

- **What happened:** The Notebooks case "repeated enhancement mounts once and cleanup restores the server figures" timed out in merge-queue run 39012318049, blocking #1340 and the release PR ([#1355](https://github.com/k2b-dev/cloud/issues/1355)).
- **Root cause:** Focusing a chart below the fold scrolls it into view, but the browser dispatches the scroll on the next frame, before animation-frame callbacks. Under CI load, that scroll could arrive after Home opened the tooltip. Chart inspection closes on scroll, so the tooltip closed and `waitFor` never resolved. A second race showed up in WebKit: the mouse rested on the table button that the test had clicked in the previous chart. When focus scrolled the next chart under it, WebKit sent a `pointermove` without mouse movement up to about 100 ms later, and inspection closed because no value was near the pointer. That a focus scroll closes keyboard inspection is a product issue of its own ([#1356](https://github.com/k2b-dev/cloud/issues/1356)), and so is the WebKit hover update. Bun then killed the shared browser on timeout, and `BrowserContext.close()` in the test's `finally` threw. Its error replaced the one of the hung `waitFor`, so the log did not show which step hung.
- **Error class:** Scroll undoes a transient state; shared subprocess lost after timeout.
- **Guard:** `showFirst` waits one frame after focus before pressing Home, and the case toggles each table by keyboard. Closing a context of a disconnected browser succeeds in the launcher. The extended `packages/ui/test/browser.browser.test.ts` guard hangs on a page wait, closes its context in `finally`, and checks that the reported error names the wait and that three later tests still pass.

### A graph test waited for load without evidence of what stalled

- **What happened:** The Notebooks case "notebooks without links and filters that leave nothing show their way out" timed out in two of 22 WebKit CI runs, merge-queue runs 39020901320 and 39021599417. Both stalled at the in-place `goto` to `free01` with `links=linked` on the loaded no-links page ([#1367](https://github.com/k2b-dev/cloud/issues/1367)).
- **Root cause:** Unknown at the time; later found to be a collapsed loopback receive queue, see [Graph pages never fired load in WebKit CI](#graph-pages-never-fired-load-in-webkit-ci). About 450 local WebKit runs did not reproduce the stall, including isolated runs, the whole suite, a CPU-throttled container, and navigation right after load. Before the second `goto`, all requests had finished and fonts had loaded. There were no animations, long-lived connections, or `beforeunload` handler. The `pagehide` handler only wrote the URL and sessionStorage synchronously, and the page did not enter the back-forward cache. These checks found no product work that kept load pending. Whether the stalled navigation committed is unknown: the error carried only the URL and said it was waiting for load. First navigations of fresh pages never stalled.
- **Error class:** Navigation stall without evidence.
- **Guard:** Each initial URL state in the graph tests opens in its own page. Launcher pages append document, response, load-event, open-request, and main-thread evidence to navigation timeouts. `packages/ui/test/browser.browser.test.ts` checks an uncommitted navigation with an open document request and a committed navigation with an open image request. It also checks that a successful navigation still returns its response.

### A Back stall was reported as a cleanup error

- **What happened:** In merge-queue run 39044132477, the WebKit case "Circle display and filters survive reload, opening a note and Back" ran out of Bun's 30-second budget in `page.goBack()` ([#1367](https://github.com/k2b-dev/cloud/issues/1367)). The error read `removeListener: removeListener: removeListener: removeListener: goBack: Target page, context or browser has been closed` and pointed at the cleanup in the launcher's navigation diagnosis.
- **Root cause of the report:** Bun's timeout closed the browser before Playwright's own navigation timeout, so `goBack` failed with the connection's closed error, not a timeout, and got no diagnosis. Playwright rejects every call on a closed connection with the same error object and prefixes its message with the name of each failing call. The four `page.off()` calls in the diagnosis cleanup each sent a subscription update and rewrote the `goBack` error that the test then reported.
- **Root cause of the stall:** Unknown at the time; later found to be a collapsed loopback receive queue, see [Graph pages never fired load in WebKit CI](#graph-pages-never-fired-load-in-webkit-ci). Back here is a full document navigation: opening a note calls `location.assign`, the graph page comes back as a new document, and the back-forward cache does not restore it. 80 isolated runs of the case and 30 runs of the whole file in WebKit, 10 of them with the browser and the test pinned to four busy CPUs, all passed and restored the display and filters.
- **Error class:** Cleanup rewrites the reported error; navigation stall without evidence.
- **Guard:** Launcher pages keep one set of navigation listeners for their whole life, so no cleanup runs after a failure. Every failed `goto`, `reload`, `goBack`, or `goForward` carries the diagnosis, also when Bun's timeout closed the browser; that case gets a new error with the original as its cause. The diagnosis adds the wait time, the URL before and at failure, and the last responses. The child suite in `packages/ui/test/browser.browser.test.ts` hangs in a navigation until Bun's timeout and fails against the old launcher. Its first CI run found one more cleanup that masked the error: a Chromium that Bun was killing answered `context.close()` with `Failed to find context` before it reported itself disconnected. Closing a context that the browser no longer knows now succeeds too.

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

### Chat sidebar test failed at midnight

- **What happened:** The merge queue failed around 22:00 UTC, or 00:00 Europe/Berlin, on 2026-10-15 and 2026-10-17. The sidebar geometry test saw a time label shrink from 45 to 27 pixels ([#1209](https://github.com/k2b-dev/cloud/issues/1209)). [#1404](https://github.com/k2b-dev/cloud/pull/1404) left the queue.
- **Root cause:** Fixtures, initial props, and page code read the real clock separately. Around Berlin midnight, `listTime` compared different calendar days and changed the label width.
- **Error class:** Time.
- **Guard:** The Chat harness stamps fixtures from a flowing clock anchored at `chatTestNow`. Each page gets a `Date` that starts at that clock, and behavior tests pin the process clock. The `test-clock` check rejects new clock reads across UI tests and their fixtures, harnesses, and suites. Durations use `performance.now()`.

### Graph pages never fired load in WebKit CI

- **What happened:** Reloads, Back, and second `goto` calls in the Notebooks graph browser tests waited for load until the 30-second budget ran out in at least eight WebKit CI runs, among them release pull request #1375 ([#1367](https://github.com/k2b-dev/cloud/issues/1367)). Local runs never stalled.
- **Root cause:** A response from the test server never reached the browser in full, so its document never fired load. The server had written the whole response, and its socket waited on a 2 KB receive window with the rest still queued. The browser's socket held no unread data, but its receive buffer had shrunk to about 1 KB after 33 drops. With each stall, the kernel counted pruned receive queues and dropped segments (`PruneCalled`, `TCPRcvQDrop`, `BeyondWindow` in `/proc/net/netstat`). The runner runs Linux 6.17. On a development machine with Linux 6.8, 2,600 in-place navigations under heavy load never stalled. In one CI run, 4,099 navigations with the kernel's defaults stalled 13 times. With an 8 MiB default receive buffer, 4,200 navigations had no stall, and the kernel pruned no queue. The whole graph test file failed in 11 of 40 CI runs with the defaults, three times with a Back that WebKit ended as an internal error, and passed all 40 runs with the setting.
- **Error class:** Loopback receive queue collapse.
- **Guard:** `.github/actions/install` sets the default receive buffer to 8 MiB for every socket opened after it, and the `ci-install` check makes every CI and nightly job use that action. [Testing](/en/docs/contributing/testing#when-a-page-never-fires-load) explains how to read the socket evidence and how to apply the setting locally.

### WebKit's network process crashed during a Back in CI

- **What happened:** After the receive buffer fix of [#1367](https://github.com/k2b-dev/cloud/issues/1367), Notebooks graph tests in WebKit CI still failed now and then in a Back from a note page with `goBack: WebKit encountered an internal error`, also in the merge queue ([#1431](https://github.com/k2b-dev/cloud/issues/1431)). No document committed. The Back and a font request of the note page failed together, and the next test passed.
- **Root cause:** WebKit's network process crashed. A diagnostic workflow kept WebKit's process log and the core dumps of the CI runners. Each failed Back came with a `WPENetworkProcess` core from the same second and the log line `NetworkProcessProxy::didClose (Network Process crash)`. The process aborted on a corrupted heap after it used a GObject that was already released: in seven of eight cores in `g_object_ref` under `soup_session_send_async`, in one in `g_object_unref`. Playwright 1.63.0 bundles libsoup 3.6.5, which releases a request's objects twice when a cancelled request finishes twice ([microsoft/playwright#42803](https://github.com/microsoft/playwright/issues/42803)). Here the Back cancelled the note page's font load. With Playwright 1.63.0, the graph file failed in 7 of 49 CI runs, each time with a network process crash. With Playwright 1.64.1, which bundles libsoup 3.6.6, it passed 49 of 49 runs on the same runners without a crash. The product, the test, and the kernel setting were not involved.
- **Error class:** Crash in a pinned browser build.
- **Side effect of the update:** Playwright 1.64.1 brings Chromium 156, which light-dismisses an `auto` popover that opens while it dispatches a pointerup. The Spaces month view opened its quick create in the pointerup that ends a drag, so the quick create closed at once, and the day and week views did the same for a drag in free time. Both now open it after the release (error class: Popover opened during a pointer release).
- **Guard:** Playwright is 1.64.1. The webkit job lists every process that crashed on the runner, so the next browser crash names its process and signal instead of a vague error. The navigation diagnosis names each failed request with its error and explains WebKit's internal error. [Testing](/en/docs/contributing/testing#when-webkit-reports-an-internal-error) shows how to get a backtrace.

### Assistant sidebar test broke every gate

- **What happened:** From 2026-10-14, the Assistant sidebar behavior test failed on every gate run, also on `main`, and blocked the merge queue ([#1121](https://github.com/k2b-dev/cloud/pull/1121)).
- **Root cause:** The sidebar switches from the server's render time to the browser clock in `onMount`. The fixture chat had a fixed date, so 30 days later it moved from "this month" to "older".
- **Error class:** Time.
- **Guard:** The test sets the system time to the render time before each test. The `test-clock` check rejects new unpinned clock reads in UI tests and their fixtures, harnesses, and suites.

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

### Unloadable incoming mail left a conversation Done

- **What happened:** A new incoming message that Mail could never load left its conversation Done or Waiting, or hidden under Later ([#1258](https://github.com/k2b-dev/cloud/issues/1258)).
- **Root cause:** Only successful loading derived the conversation's work state. Terminal failures recorded the error without applying the message envelope's transition.
- **Error class:** Status derived only on the success path.
- **Guard:** `conversation-work-state.integration.test.ts` covers oversized messages, exhausted missing-source attempts, expired claims, stream failures, ordering, covered decisions, unchanged revisions, and loading after repair. `reopening counts a terminally failed reply to restore Needs action` checks that reopening counts the terminal failure too. `terminally failed newer reply reopens automation Done` in `incoming-automations.integration.test.ts` checks a real automation decision. Failure and transition commit together. They lock the mailbox before its conversations, as keeps and merges do, and conversations in ID order; `terminal failure locks the mailbox before the conversation` checks that a keep cannot deadlock the transition away.

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
- **Follow-up:** The placement turn checked for a moved message before checking that the run is an incoming automation, so a hand-written workflow's move step skipped silently ([#1246](https://github.com/k2b-dev/cloud/issues/1246)). Error class: role check after the outcome it gates. Guard: `workflow-placement-steps.integration.test.ts` covers move, archive, trash, and junk of a hand-written workflow on a moved message and on a message another command is moving.

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

### Contacts authorization differed between callers

- **What happened:** Cloud administrators could read books without grants through the Contacts API, capabilities, and live updates, while the Contacts pages answered 403 ([#1234](https://github.com/k2b-dev/cloud/issues/1234)).
- **Root cause:** API, capability, and service callers held separate copies of the book permission decision, including administrator bypasses.
- **Error class:** Authorization copies.
- **Guard:** Contacts `book-permission-paths.test.ts` rejects transport pre-checks (`requireBookAccess`/`requireBookPermissionInternal` outside `failAfterBookAccess`), `book.authorize`, hand-built user subjects in `api/`, intent `level` on `book.get`/`contact.get` outside `failAfterBookAccess`/`requireBookPermission`/`resolveContactAtLevel`, and credential scope caps outside the service; it restricts authorization and administration to their owners (ACC-02). `service/authorization.integration.test.ts` calls every book-scoped service operation with each identity kind. `book-permission.integration.test.ts` covers grants, exact resource bindings, credential scope limits, and separate administration access through API, capabilities, SSR, and live updates.

### Background routine paths skipped the app's approval decision

- **What happened:** Routine tools executed Actions after checking a mandate without calling the app's review. Background Code Mode reviewed before an explicit mandate check and then ran even when the review supplied no scope.
- **Root cause:** The interactive approval path owned the review gate, while the two background paths treated mandate authorization as sufficient for execution.
- **Error class:** Approval gate skipped on a second execution path.
- **Guard:** `background-review.test.ts` checks mandate-first ordering and refusal on missing scope, missing review, errors, and cancellation. `capabilities.test.ts` and `capability-runtime.test.ts` assert that refused calls never execute or invoke the app. Both paths call one shared `authorizeBackgroundAction`; task and notification integration tests preserve `needs_approval` and the action name even after a completed model reply.

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

### Closing a sheet triggered application navigation

- **What happened:** Closing a dialog or the phone composer command sheet could reload the page, lose its draft, or reopen a message anchor or artifact.
- **Root cause:** Same-URL dialog history traversals reached application `popstate` listeners, including the synthetic Back after dismissal and Forward onto an entry a closed sheet left behind. A submit handler that navigated before the sheet's entry had left could leave that entry behind.
- **Error class:** State lost on navigation or reload.
- **Guard:** The dialog core suppresses same-URL traversals involving its entries only when the Navigation API or its own synthetic Back establishes the departure. `dialog-history.behavior.test.ts` runs with and without the Navigation API and covers retired markers, foreign pushes, replaced addresses, and several cores. `chat-slash.behavior.test.ts` checks that touch-only submission waits for pending or in-flight Back while desktop submission stays synchronous. `chat-composer.browser.test.ts` covers phone sheet history in Chromium and WebKit, with the application's listener added before the first sheet opens: Chromium runs a window's `popstate` listeners in the order they were added, capture or not, so the shared dialog core listens from the moment it is created.

### Workflow event payloads grew without bounds

- **What happened:** Workflow events kept payloads and deliveries indefinitely and accepted arbitrarily large JSON ([#1183](https://github.com/k2b-dev/cloud/issues/1183)).
- **Root cause:** Emission had no byte limit, and finished events had no payload retention.
- **Error class:** Unbounded storage growth.
- **Guard:** Event integration cases cover UTF-8 size limits before SQL, retained dedupe rows, dispatch age, resumable runs, repeated retention batches, and concurrently built retention indexes. Observability integration cases distinguish expired payloads from missing events. Mail integration cases emit an oversized message without its body through sync and backfill, and retry failed runs after event expiry while excluding succeeded runs. Convention: emitters keep large content out of events and let runs read it by reference; history queries use retained run context when event context and deliveries expire.

### Public inbox uploads exhaust the page request budget

- **What happened:** A 15-file inbox upload hit rate limits after only a few files ([#1168](https://github.com/k2b-dev/cloud/issues/1168)).
- **Root cause:** Upload control requests shared the public page limit of 10 requests per minute per IP. The initial per-link upload key let one client bypass the cap by spraying tokens.
- **Error class:** Rate-limit scope and budget mismatch.
- **Guard:** `public-rate-limit.integration.test.ts` checks the separate 120-request per-client (IPv6 /64) upload budget, token spraying, mounted routes, similar paths, page isolation and secret-free Valkey keys. `public-upload-rate-limit.test.ts` checks address bucketing without Valkey. `public-inbox.behavior.test.tsx` checks automatic waits during a 15-file batch and the terminal rate-limit message.

### Activity keys leaked into note labels

- **What happened:** The note detail panel displayed “note created” instead of a translated sentence.
- **Root cause:** Separate switches mapped open action strings and rendered unknown keys by replacing dots with spaces.
- **Error class:** An open string enum mapped to UI text through a raw-key fallback.
- **Guard:** Notebooks uses a typed action union, an exhaustive English/German activity catalog, and neutral unknown-action labels. `activity-messages.test.ts` scans service activity literals and checks both actor forms and fallbacks; `activity.integration.test.ts` checks filtered paging past unknown stored actions.

### A panel command had no owner

- **What happened:** Duplicate in the Notebooks panel emitted an event without starting the copy flow.
- **Root cause:** The prompt, copy request, and navigation belonged to the note tree, while the panel had only an event name.
- **Error class:** A browser event without a mounted consumer.
- **Guard:** `duplicate-note.behavior.test.tsx` exercises the panel with no tree and with two trees, plus cancellation, errors, permissions, and listener cleanup. Both entry points use the same copy flow; only the panel handles its event.

### Note PDFs did not report omitted content

- **What happened:** Note PDFs replaced images, diagrams, and invalid blocks with labels, source, or notices without reporting the loss to the caller.
- **Root cause:** The renderer returned HTML and parser diagnostics but no report of rendering fallbacks.
- **Error class:** Unreported export loss.
- **Guard:** Notebooks renderer tests cover each fallback, omission order, and one block omission per diagnostic in English and German. Header tests check Unicode labels and the maximal prefix within 2048 bytes; service, API, and gateway tests check delivery.

### A claim replaced every kanban column and card

- **What happened:** Claiming a card detached it during the refresh, losing focus and hover and leaving a WebKit box read empty ([#1391](https://github.com/k2b-dev/cloud/issues/1391)).
- **Root cause:** Solid's `<For>` keyed columns and cards by refetched object references.
- **Error class:** A mutation’s refresh re-creates a rendered entity’s element.
- **Guard:** `keptThrough()` checks element identity and height in the kanban and detail claim tests. The held-card test checks that refresh keeps a press until its card leaves the column. Convention: [Keep focus while content refreshes](/en/ui/focus#keep-focus-while-content-refreshes).

### The upload list stopped following after the pointer left

- **What happened:** The WebKit test for the upload list failed in the merge queue: after the pointer left the list, the list stayed on the old row instead of following the file in flight ([#1371](https://github.com/k2b-dev/cloud/issues/1371)).
- **Root cause:** The pointer rested on the byte count of the file in flight. When the file finished, its row dropped that line. WebKit sends no `pointerleave` when the hovered element leaves the document, unless a later hover update finds a new element under the pointer first. Without the leave, the list kept waiting for the pointer, and a finished panel did not leave after five seconds. The same happens in Safari during a real upload. The follow itself is immediate with reduced motion, so a longer wait in the test would not have helped.
- **Error class:** Hover kept after its element left.
- **Guard:** The panel confirms both hover states with the next `pointerover` on the document. `UploadPanel.browser.test.ts` moves the pointer away right after the byte count leaves, which failed 10 of 10 runs in WebKit without the fix, and checks both the follow and the five-second leave.

### Light app accents made identity text unreadable

- **What happened:** The yellow Notebooks accent produced text below 4.5:1 contrast on light surfaces.
- **Root cause:** Fixed CSS mixes adjusted every accent by the same amount without checking background contrast.
- **Error class:** Derived theme text color without a contrast guarantee.
- **Guard:** `app-color.test.ts` checks every declared app accent and edge colors against theme and selection surfaces, pins surface and default token values, and verifies the mildest passing clamp step. SSR and compiled stylesheet tests pin emission and scoped theme mappings.

### The selected navigation row stayed grey on the white sidebar

- **What happened:** After the workspace became one white surface ([#1468](https://github.com/k2b-dev/cloud/pull/1468)), the selected sidebar row and the selected stacked chip still looked grey.
- **Root cause:** The sidebar moved to `--k2b-surface`, but `app-color.ts` still mixed the navigation fill over the old muted background. The drift test checked the muted token's value, not the background the sidebar declares. The dark shell also borrowed the navigation fill for the open app, so moving the fill to the darker surface would have made that item disappear into the dark bar.
- **Error class:** A pinned color base drifts from the surface an element uses.
- **Guard:** `packages/cloud/src/ssr/app-color.test.ts` reads the sidebar's background declaration from @k2b/ui and checks its resolved base and hover in both themes. The shell's dark open item has its own fill, `shellSelected`, which `shell-gradient-contrast.test.ts` pins to its CSS declaration.

### Read fallback written back

- **What happened:** Settings reads returned a fallback for undecryptable or invalid rows. Files token retention, VAPID bootstrap, and the AI credential split could then write over data that another process could still read ([#1303](https://github.com/k2b-dev/cloud/issues/1303)).
- **Root cause:** A fallback value carried no stored-state information, and writes trusted it as a readable value.
- **Error class:** Read fallback written back.
- **Guard:** The settings store locks and checks the existing row in the write transaction and refuses unreadable rows with `setting_unreadable` unless replacement is explicit. `packages/cloud/src/services/settings/unreadable.integration.test.ts` preserves ciphertext and timestamps, checks read/list state even with shared plaintext cache entries, checks secret redaction, and covers replacement and reset. Stored-state reads bypass the shared cache because decryption depends on each process's `APP_SECRET`. Files configuration unit and integration tests refuse token retention over unreadable data and verify recovery.
- **Concurrent inserts:** A missing-row lock does not prevent another writer from inserting; `write-key.test.ts` covers the insert-conflict recheck before any update, including unreadable winners and explicit replacement.
- **Lock order and startup:** The store takes its row lock with an `UPDATE`, so it waits behind a table-level `SHARE` lock instead of deadlocking with it (`unreadable.integration.test.ts`). Core startup leaves Web Push off instead of failing when its key rows cannot be read (`browser-settings.test.ts`).

### Note PDFs printed attached images as labels

- **What happened:** A note's PDF showed attached images only as "Image: <alt>" ([#1280](https://github.com/k2b-dev/cloud/issues/1280)).
- **Root cause:** Book writes attachment images as session-authenticated app URLs, which Gotenberg cannot load, so print mode replaced them with labels.
- **Error class:** Session URL in a server-side export.
- **Guard:** `book-renderer.test.ts` checks that every documented image form prints without an app, API, or `attach://` URL; `note-pdf-images.integration.test.ts` checks the embedded images with `pdfimages` and zero Gotenberg requests with the request trap.

### Task deadline dates became times

- **What happened:** Choosing a task deadline date silently assigned 17:00. While all-day deadlines were built, the iCal export wrote the day before when the server process ran west of UTC, and the `@k2b/ui` date pickers labelled a date key one day late in a zone far east of the runtime's, such as Pacific/Kiritimati.
- **Root cause:** Task storage and inputs represented every deadline as a timestamp; ical-generator writes a `VALUE=DATE` from the process's local date getters, so a UTC-midnight `Date` moved back a day; the pickers formatted a date key as a zone-less local noon in the picker's zone.
- **Error class:** Date-only value passes through a time zone, the class of the Contacts birthday fix in [#1364](https://github.com/k2b-dev/cloud/pull/1364).
- **Guard:** Spaces stores calendar dates in `DATE`, reads them as text, and tests input validation, formatting, overdue boundaries west and east of UTC, API switching, query grouping, and iCal dates with the process in several zones.

### Workspace head slots were constructed twice during hydration

- **What happened:** Hydrating a workspace head with JSX view tabs failed with a hydration mismatch.
- **Root cause:** Presence checks and content read the same JSX prop getter separately, constructing elements twice.
- **Error class:** Repeated JSX slot construction.
- **Guard:** The head resolves each JSX slot with Solid's `children()`. Render tests count constructions; `workspace-head-hydration.browser.test.ts` checks real SSR hydration, stable geometry, unique head parts and an interactive More menu.

### The OAuth card was read before its styles arrived

- **What happened:** The OAuth authorization page browser test read `expired light at 1440 px` as unframed once in CI ([#1499](https://github.com/k2b-dev/cloud/issues/1499)), and once in a local Chromium run under load it found `span.k2b-button__label: 1.24` for `confirm light at 1440 px` ([#1476](https://github.com/k2b-dev/cloud/issues/1476)). Re-runs passed.
- **Root cause:** The test removes every script from the page, also the inline theme script in `<head>`. That script stops the parser until the stylesheets before it have loaded; without it, the body is parsed while `global.css` is still on its way, and the browser can style the card with the other stylesheets only. When `global.css` then applies, the 150 ms color transitions of `.k2b-paper` and `.k2b-button` start from a transparent card and browser-default buttons. The test read the colors once after load and `document.fonts.ready`, which can land inside those 150 ms. Holding `global.css` back until the parsed card was styled once reproduces the transparent card in light and dark every time, with the transitions running at the read; when the contrast read lands early in them, button labels fall below 4.5:1 too. Which browser step styles the card that early without a test read is not confirmed: holding the stylesheet back for one to five seconds without a read reproduced it once in 32 page loads.
- **Error class:** State sampled before it settled.
- **Guard:** `open()` in the test emulates reduced motion, so every @k2b/ui transition is instant, then waits for every finite animation on the document timeline to finish and for two frames before any read. A case holds `global.css` back in light and dark and fails without that wait. The failure contexts name the card's border, shadow, and background, the body background, and the animations that still run.

### App colors lost at a dialog portal

- **What happened:** Settings, file chooser, resource picker, and other app dialogs showed the platform blue instead of the app's colors ([#1458](https://github.com/k2b-dev/cloud/issues/1458)).
- **Root cause:** App color properties were set only on `.cloud-app-canvas`, while UI dialogs mount in a portal under the page shell's body, outside that canvas.
- **Error class:** App colors lost at a dialog portal.
- **Guard:** The page shell carries the current app's validated accent scope. `packages/cloud/src/ssr/Layout.render.test.tsx` checks exact body markup, invalid and absent accents, app Help, focus and admin pages, and unchanged minimal pages. `packages/cloud/src/ssr/dialog-app-colors.browser.test.ts` checks inherited settings and row colors, stable category geometry, and local accent overrides in light and dark mode at desktop and phone sizes.

## Add a lesson

A fix pull request answers "How do we prevent this next time?" and adds its
entry here in four lines: what happened, root cause, error class, and guard.
When neither the code on `main` nor a test confirms the root cause, start it
with "Suspected:"; the fix pull request replaces it with the confirmed cause.
When the guard does not exist yet, write "Pending in #n" with the issue that
tracks it, or "None, because …". A pull request that adds a guard for a class
updates that class's row in the table.
