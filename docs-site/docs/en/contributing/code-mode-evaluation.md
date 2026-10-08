---
title: Evaluate Assistant Code Mode
navTitle: Code Mode evaluation
section: Contributing
order: 1316
description: Verify Code Mode with disposable services, real browser execution, and a real model building Studio apps.
tags: [testing, ai, assistant]
updated: 2026-10-08
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

## Measure Studio apps with a real model

The Studio evaluation lets a real model build seven apps from German user
requests, each in a fresh chat with its own disposable user:

| Case | Request |
| --- | --- |
| `todo` | personal todo list that keeps its tasks, with check, delete and filters |
| `csv-dashboard` | dashboard from an uploaded Windows-1252 order export, stored in the app |
| `travel-expenses` | travel expense report with a PDF for signing |
| `quote-pdf` | quote generator with items, VAT and a PDF |
| `contacts` | shared team contact list with search, edit and delete |
| `time-tracking` | time tracking with a weekly chart and a CSV export |
| `expense-approval` | team expense approval with a PDF list of approved expenses |

```bash
bun packages/assistant/scripts/eval-code-mode.ts --case todo --case contacts
```

Without `--case`, all seven cases run, three at a time (`--concurrency`). The
model is the configured Cloud default model, which needs that installation's
`DATABASE_URL` and `APP_SECRET`. To evaluate another model, pass one profile in
the `ai.model_profiles_json` format with `--profile` and its API key in
`ASSISTANT_EVAL_API_KEY`. Credentials stay in the parent process behind an
authenticated loopback proxy. Postgres and rsql run in disposable containers;
Valkey and Gotenberg come from `CLOUD_TEST_VALKEY_URL` and
`CLOUD_TEST_GOTENBERG_URL`. The user's existing chats are untouched.

The agent gets the Code Mode skill, the real tool descriptions and the real
`code_check`. It shows each app with `code_present`. `view_image` is answered by
the evaluated model itself, the way a vision-capable chat model works; it reads
images only, so PDFs are read as text.

Every run writes to `--out` (default `/tmp/assistant-code-mode-eval/<time>`):

- `summary.md`: one row per case and the totals;
- `<case>/result.json`: checks with errors and warnings, tool calls and time;
- `<case>/check-<n>-*.png` and downloads such as PDFs, per check;
- `<case>/app/`: the final app files, and `<case>/transcript.json`.

Two numbers matter. **First check passed** says only that the first version was
not broken. **Presented without a correction round** says that the first checked
version is the one the agent showed. Neither proves that the app looks good or
calculates correctly: look at the first and final screenshots and open the PDFs
before you report a result, and compare calculated values with the source data.
Record the model, reasoning effort and date with the numbers; runs with
different models are not a controlled comparison.

## Evaluate HTML app checks

For an HTML interface, write its main flow into `steps.json` and run
`code_check` before presenting or publishing. The gate binds files, steps and
table definitions to the checking user/conversation. Inspect all three returned
screenshots with `view_image`; a passing report does not establish visual quality.

The [HTML app check contract](/en/docs/ai/chat-interface#check-an-html-app-before-showing-it)
describes desktop/phone runs, disposable data, schema-only copies above the
budget, restricted effects and cancellation. Browser regressions use the
repository launcher and support Chromium or `TEST_BROWSER=webkit`.
