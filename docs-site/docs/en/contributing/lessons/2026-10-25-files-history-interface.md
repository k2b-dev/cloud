---
title: Files history interface checks
navTitle: Files history interface checks
section: Contributing
order: 1604
description: Preserve contact intent, navigation and keyboard focus in history views.
tags: [contributing, testing]
updated: 2026-10-25
---

# Files history interface checks

## A recovered write intent replaces a new contact

- **Class:** A recovered write intent replaces a new contact.
- **What goes wrong:** Restoring an unresolved chat creation silently substitutes its recipients for the person selected in another app.
- **Guard:** Test: Chat `chat-dialogs.behavior.test.tsx` refuses a conflicting contact, retains the original key through dismissal, resumes only an exact matching intent, and permits the intended contact after the old attempt is resolved or explicitly cancelled.
- **Evidence:** The focused tests named above.

## A delayed command overrides later navigation

- **Class:** A delayed command overrides later navigation.
- **What goes wrong:** Resolving another application’s entry point outlives the view that requested it and navigates or reports an obsolete error.
- **Guard:** Test: Files `history-contact.behavior.test.tsx` delays successful and failed command responses past navigation and disposal; the request uses the workspace navigation signal and suppresses obsolete feedback.
- **Evidence:** The focused tests named above.

## Cold module compilation consumes an interaction deadline

- **Class:** Cold module compilation consumes an interaction deadline.
- **What goes wrong:** The first behavior case spends its timeout compiling a large island, then its unfinished async work overlaps the next case’s mocks and DOM.
- **Guard:** Convention: load the source graph before registering interaction cases, using the suite’s DOM harness for browser modules. Files `history-contact.behavior.test.tsx` follows the existing workspace suites and keeps every interaction at the default deadline.
- **Evidence:** The focused tests named above.

## Browser URL checked before keyboard navigation commits

- **Class:** Browser URL checked before keyboard navigation commits.
- **What goes wrong:** A link activation returns before the browser reports its new fragment, making a correct interaction fail intermittently.
- **Guard:** Test: UI `data-table-focus.browser.test.ts` waits for the expected URL after Enter before checking the destination and row handler count.
- **Evidence:** The focused tests named above.

## Clearing a text field removes the focused action

- **Class:** Clearing a text field removes the focused action.
- **What goes wrong:** The clear button disappears with the value and leaves keyboard users outside the field.
- **Guard:** Tests: UI `text-input-clear.browser.test.ts` checks focus and typing after clearing with default callbacks and custom `onClear`; Files `History.browser.test.ts` checks the real history search in English and German.
- **Evidence:** The focused tests named above.

## Replacing a disclosure drops keyboard focus

- **Class:** Replacing a disclosure drops keyboard focus.
- **What goes wrong:** Expanding or collapsing older history removes the activated control and leaves its state unannounced.
- **Guard:** Test: Files `History.browser.test.ts` uses real Tab, Enter, and Space interactions in German and English and checks focus continuity, `aria-expanded`, and the controlled list. Paging and retry tests also check focus after the last page, including the fallback to the list. Item history keeps one disclosure button mounted while older rows exist.
- **Evidence:** The focused tests named above.

## History presentation loses its scope or lifetime

- **Class:** History presentation loses its scope or lifetime.
- **What goes wrong:** Name-only grouping combines homonyms, folder details omit child changes, a late lookup overrides navigation, or elapsed hours misplace local midnight.
- **Guard:** Tests: Files `history-actions.test.ts` separates visible identities, `history-requests.test.ts` and `urls.test.ts` preserve folder scope, `history-ranges.test.ts` pins DST boundaries, and `history-workspace.behavior.test.tsx` covers child uploads and obsolete navigation results/errors. `files-ui.render.test.tsx` and the workspace behavior test keep moved notices exclusive of load errors.
- **Evidence:** The focused tests named above.

## Shared rows import the enclosing view

- **Class:** Two composed views import each other's runtime components.
- **What goes wrong:** The activity list and its search results form an import cycle by sharing row helpers through the enclosing view.
- **Guard:** Shared history rows live in `history-rows.tsx`; the `cycles --apps` repository rule rejects runtime cycles. The existing history behavior and browser suites cover both consumers.
- **Evidence:** The repository rule and focused suites named above.
