---
title: Evaluate Assistant Code Mode
navTitle: Code Mode evaluation
section: Contributing
order: 1316
description: Verify Code Mode with disposable services, real browser execution, and a configured model.
tags: [testing, ai, assistant]
updated: 2026-10-07
---

# Evaluate Assistant Code Mode

From the repository root, run the service tests with Docker available:

```bash
bun packages/assistant/scripts/test-artifacts.ts
bun test packages/assistant/src/cli/code-host.test.ts
bun test packages/assistant/src/artifacts/html/html-app.browser.test.ts
bun test packages/assistant/src/artifacts/chat-presentation.browser.test.ts
```

The service runner creates temporary PostgreSQL and rsql containers and removes
only those containers when it finishes. Browser tests use their own Chromium
processes. They do not require an open Assistant tab or restart the shared stack.
Install the Playwright Chrome channel before running browser tests.

For a real model evaluation, provide the three demo files `umsaetze.csv`,
`produkte.csv`, and `ziele.csv` in one directory:

```bash
bun packages/assistant/scripts/eval-code-mode.ts /absolute/path/to/demo-files
```

This command reads the configured Cloud model profile and needs its database
connection and application secret in the environment. It makes provider calls
with reasoning disabled. Credentials remain in the parent process behind an
authenticated loopback proxy. The generated chat, app, and data use disposable
services; the user's existing conversations are untouched.

The transcript, tool results, elapsed time, model name, and final app source are
written to `/tmp/assistant-code-mode-eval.json`. Copy that file before another run
if you need to compare results. Temporary app links are not usable after cleanup.

The automated acceptance check requires one saved app with an `index.html`
interface, a script run that reached `ready`, and a `code_present` card for the
app. Apps have no rendered self-check yet, so the check does not prove analytical
or visual correctness. Independently compare original CSV values and target
granularity with the saved data and raw KPI values. Open the saved app on desktop
and mobile and exercise combined filters, empty states, and reset; do not
substitute a copied calculation for testing the actual app.

Record repair attempts and model configuration alongside duration. Different
models or reasoning settings do not constitute a controlled speed comparison.
