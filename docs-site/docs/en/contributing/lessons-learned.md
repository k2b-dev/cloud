---
title: Lessons learned
navTitle: Lessons learned
section: Contributing
order: 1305
description: Name the error class of each bug and the guard that catches that class next time, and read the incidents that taught each class.
tags: [contributing, testing, quality]
updated: 2026-10-15
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
| Time | A test or a render depends on today's date, the time zone, or randomness, so it passes on one day and fails on another. | Test: the Assistant sidebar test from [#1121](https://github.com/k2b-dev/cloud/pull/1121) freezes its clock. No repository check finds other tests that compare fixed dates with the real clock yet. |
| Server render vs. mount | An island replaces the server HTML when it mounts; see [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). When the server and the browser render different markup or styles, the page moves on mount or after a reload, and WebKit can keep stale styles from before the mount. | Convention: [Know how an island mounts](/en/docs/frontend/islands-and-hydration#know-how-an-island-mounts). Test: the month view browser tests from [#1157](https://github.com/k2b-dev/cloud/pull/1157) check row places right after mount. The `@k2b/ui` sidebar reload test from [#1154](https://github.com/k2b-dev/cloud/issues/1154) compares the server frame, the frame right after mount, and the settled frame after a reload. No shared test does this for other islands yet. |
| Layout shift | A transient state, such as a status text, a notice, or a loader, appears in the layout flow and moves its neighbors. | Convention: [Keep the layout still](/en/docs/frontend/styling-and-accessibility#keep-the-layout-still) ([#1143](https://github.com/k2b-dev/cloud/pull/1143)). Each change applies its browser-test pattern, which compares bounding boxes before and after each state change. No automatic check yet. |
| State lost on navigation or reload | Clearing, cancelling, reloading, or going Back does not return the person to where they started, or drops input that was not saved yet. | Convention: [Test URL behavior](/en/docs/frontend/testing#test-url-behavior) covers reload, Back, Forward, and opened links. No shared guard covers unsent local edits yet; Grids tests the leave warning of its public forms in `PublicFormSubmit.behavior.test.tsx`, and Notebooks tests that a sync error keeps unsent text in `sync-ended.behavior.test.tsx` and `provider.test.ts`. |
| Ordering and concurrency | Work for one item runs in parallel or races another writer, so results land out of order or a later step undoes an earlier one. | Convention: the order and no-drop rules in [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) ([#1148](https://github.com/k2b-dev/cloud/pull/1148)) cover actions in the browser. Test: Chat's send queue keeps the browser posts of one conversation in order in `chat-sends.test.ts` ([#1145](https://github.com/k2b-dev/cloud/issues/1145)). No shared guard covers server-side writers yet; Mail's command queue has an integration test for server-side order in `conversation-actions.integration.test.ts`, and nothing covers automation versus reconciliation ([#1142](https://github.com/k2b-dev/cloud/issues/1142)). |
| Silent failure | Async work fails and the person sees nothing, or a progress text stays as the last word. | Convention: [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state) for single actions. No shared guard covers background work yet. |
| Foreign system contracts | Cloud sends a schema or a payload that a foreign system, such as a model provider or Filegate, does not accept. | Partial test: the chart tool schema is checked for provider shape (one root object without `oneOf`, `anyOf`, or `allOf`, and no tuple `items`) in `packages/cloud/src/ai/chart-block.test.ts` and `default-tools.test.ts`. Test: `tests/capability-tool-schemas.test.ts` builds every app's capability tools the way the Assistant does and checks the same provider shape for each input schema ([#1149](https://github.com/k2b-dev/cloud/issues/1149)). No guard covers Filegate payloads yet. |
| Server-side request forgery | A person-chosen address reaches the server’s private network or changes between validation and connection. | Check: `network-guard` lets only the platform guard resolve host names. Test: platform address and resolution tests, plus Tools refusal and pinned-transport tests. |
| Escaped text input | An agent writes `\n` as two characters through a shell argument or double-escaped JSON, and the text is stored and shown with a literal backslash. | Test: Spaces rejects such inline CLI text and capability text inputs ([#1178](https://github.com/k2b-dev/cloud/issues/1178)). No shared guard covers inline text in other apps, such as `cld notebooks write --content`, yet ([#1193](https://github.com/k2b-dev/cloud/issues/1193)). |

## Lessons

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
- **Root cause:** Suspected: the reconciliation that derives Needs action from incoming mail runs after the automation and treats the same message as new incoming mail.
- **Error class:** Ordering and concurrency.
- **Guard:** Pending in [#1142](https://github.com/k2b-dev/cloud/issues/1142).

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

## Add a lesson

A fix pull request answers "How do we prevent this next time?" and adds its
entry here in four lines: what happened, root cause, error class, and guard.
When neither the code on `main` nor a test confirms the root cause, start it
with "Suspected:"; the fix pull request replaces it with the confirmed cause.
When the guard does not exist yet, write "Pending in #n" with the issue that
tracks it, or "None, because …". A pull request that adds a guard for a class
updates that class's row in the table.
