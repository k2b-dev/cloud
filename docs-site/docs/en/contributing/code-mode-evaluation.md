---
title: Evaluate Assistant Code Mode
navTitle: Code Mode evaluation
section: Contributing
order: 1316
description: Verify Code Mode with disposable services, real browser execution, and a real model choosing Assistant routes.
tags: [testing, ai, assistant]
updated: 2026-10-12
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

## Measure Assistant routes with a real model

Each case runs one interactive web chat turn with a fresh disposable user and
chat. Compare **route and time** before and after a prompt change: does the
Assistant choose a saved Studio app, a one-off chat app, or a view, and how long
does the turn take? Expected routes are evaluation targets, not instructions
sent to the model.

The app cases include German requests for apps with stored data and paired
German and English requests for small tools:

| Case | Language | Expected | Request |
| --- | --- | --- | --- |
| `todo` | DE | studio-app | Personal to-do list that keeps tasks, with check, delete and filters |
| `csv-dashboard` | DE | studio-app | Dashboard from an uploaded Windows-1252 order export, stored in the app |
| `travel-expenses` | DE | studio-app | Travel expense report with a PDF for signing |
| `quote-pdf` | DE | studio-app | Quote generator with items, VAT and a PDF |
| `contacts` | DE | studio-app | Shared team contact list with search, edit and delete |
| `time-tracking` | DE | studio-app | Time tracking with a weekly chart and a CSV export |
| `expense-approval` | DE | studio-app | Team expense approval with a PDF list of approved expenses |
| `calculator-de` | DE | studio-app | Bau mir eine Taschenrechner-App |
| `calculator-en` | EN | studio-app | Build me a calculator app |
| `unit-converter-de` | DE | studio-app | Ich brauche einen Einheitenumrechner für Länge, Gewicht und Temperatur |
| `unit-converter-en` | EN | studio-app | I need a unit converter for length, weight and temperature |
| `tip-calculator-de` | DE | studio-app | Bau mir einen Trinkgeldrechner, der die Rechnung auf mehrere Personen aufteilt |
| `tip-calculator-en` | EN | studio-app | Build me a tip calculator that splits the bill between several people |
| `timer-de` | DE | studio-app | Mach mir einen Timer mit Start, Pause und Zurücksetzen |
| `timer-en` | EN | studio-app | Make me a countdown timer with start, pause and reset |
| `form-de` | DE | studio-app | Erstell mir ein einfaches Formular, in das mein Team Urlaubswünsche einträgt |
| `form-en` | EN | studio-app | Create a simple form where my team enters vacation requests |

Each view case attaches the same `bestellungen.csv` export at
`/bestellungen.csv`, with 300 orders over twelve months:

| Case | Language | Expected | Request |
| --- | --- | --- | --- |
| `sales-chart-de` | DE | view | Zeig mir eine Grafik der Umsätze |
| `top-customers-de` | DE | view | Tabelle der Top 10 Kunden nach Umsatz |
| `sales-chart-en` | EN | view | Show me a chart of the revenue |
| `top-customers-en` | EN | view | Table of the top 10 customers by revenue |

```bash
bun packages/assistant/scripts/eval-code-mode.ts --case todo --case contacts
```

Without `--case`, all 21 cases run, three at a time (`--concurrency`). The
model is the configured Cloud default model, which needs that installation's
`DATABASE_URL` and `APP_SECRET`. To evaluate another model, pass one profile in
the `ai.model_profiles_json` format with `--profile` and its API key in
`ASSISTANT_EVAL_API_KEY`. Credentials stay in the parent process behind an
authenticated loopback proxy. Postgres and rsql run in disposable containers;
Valkey and Gotenberg come from `CLOUD_TEST_VALKEY_URL` and
`CLOUD_TEST_GOTENBERG_URL`, and the command stops before it starts when either
is missing. The user's existing chats are untouched.

The agent gets the real Assistant system prompt, the complete bundled Skill
catalog, the case's language and the chat's attachment manifest. Global
instructions are empty; app capabilities, Help and memory are disabled. Tools
retain their production names, descriptions, schemas and prompt hints. The
production resolver offers only non-deferred built-ins and discovery tools at
first; deferred tools become callable after `load_tools`. `load_skill` returns
the bundled instructions and mounts references for the real `read_file` tool.

Source tools use the real Assistant handlers, and code execution, checks and
presentation use the evaluation host. Other server built-ins run with the case
user and conversation. Browser behavior is answered as follows:

- `code_open` uses the server's permission and current-source check gate, then
  returns `{ opened: id, started: false }` as if the app opened beside the chat.
  It does not start an app interface.
- Display-only client views (`chart` and `card`, when offered) return
  `{ displayed: true }`, as the production executor does.
- `view_image` is answered by the evaluated model itself. PDF pages are
  rendered to images first, as in the real tool.
- `survey`, `text_editor` and `code_secret` return a tool error saying they are
  not answerable in this evaluation. Their calls remain in the report.
- Reviewed source changes, such as a file copy into an app, run as if the
  case user approved them. Other approval requests cannot be answered, and a
  case that needs one is marked as not measured.

Each case has one user, so sharing between team members is not exercised: a
wrong grant in a team app still counts as presented. Skills come from this
checkout with a fixed evaluation revision of 1; installation permissions,
attached Skill IDs and revision changes are not exercised. There is no app
capability registry. Display-only view acknowledgments emulate completion;
they do not verify that a browser rendered the view.

Every run writes to `--out` (default `/tmp/assistant-code-mode-eval/<time>`):

- `summary.md`: model, reasoning effort, commit and start time, one row per
  case and the totals;
- `<case>/result.json`: expected and observed route, whether an app was created,
  route match, wall/model/tool milliseconds, counts and a per-turn timing table;
  each turn lists its index, elapsed and model milliseconds, and tool calls with
  arguments, results, milliseconds and error flags, alongside existing checks;
- `<case>/check-<n>-*.png` and downloads such as PDFs, per check;
- `<case>/app/`: the final app files, and `<case>/transcript.json`.

Route classification considers successful calls and uses this priority:

1. **studio-app**: `code_open`, or `code_present` with an `id`.
2. **chat-app**: `code_present` with `files`.
3. **view**: `present` of a path under `/views/`, or `chart` or `card`.
4. **none**: no matching successful call, including a table written only as
   Markdown in the answer.

Creating an app alone does not determine the route. Failed calls are ignored,
including runtime results marked `failed: true`.

The summary columns are **Case**, **Expected**, **Route**, **Match**, **Minutes**,
**Model turns**, **Model s**, **Tool s**, **Tool calls**, **Checks**, **First check
passed** and **Presented without correction**. Route totals are shown overall
and separately for app and view cases. Minutes measure the agent loop, excluding
fixture setup and saving results. Model and tool totals use nessi's aggregate
timing, which includes provider wait through the evaluation proxy. Per-turn
elapsed time runs from `turn_start` to `turn_end`; because nessi ends a turn
after its tools, per-turn model time stops at the first tool execution. Tool
calls record their individual durations. Vision calls made by `view_image`
count as tool time, not additional model turns. Concurrent tool durations need
not sum to the total tool time.

Counts record Skill loads, Skill reference reads, discovery calls, `code_run`,
`code_write`, `code_check`, `view_image`, tool errors and nessi issues, including
malformed calls and repairs. The transcript retains the issue details.

For app quality, two existing metrics remain, counted over checks of the
presented app. **First check passed** says only that the first version was not
broken. **Presented without a correction round** says that the first checked
version is the one the agent showed; it differs from the first number only
when the agent changes a passing version before showing it, for example after
looking at its screenshots. A successful `code_present` or `code_open` counts
as the presentation. The metrics remain unchanged for view cases. A `code_check` call that
fails as a tool call, such as a lost host, checks no version and is listed
separately.

A case that ends before the model finishes on its own, through a provider
error, the 25-minute limit or the 60-turn limit, is marked as not measured and
left out of the totals. Neither number proves that the app looks good or
calculates correctly: look at the first and final screenshots, open the PDFs
before you report a result, and compare calculated values with the source data.
A screenshot shows the page after the last step, up to 2000 px tall, so report
a case whose requested main state it does not show as unverified. Runs with
different models, reasoning efforts or commits are not a controlled comparison;
a commit ending in `-dirty` had uncommitted changes.

## Evaluate HTML app checks

For an HTML interface, write its main flow into `steps.json` and run
`code_check` before presenting or publishing. The gate binds files, steps and
table definitions to the checking user/conversation. Inspect every path in the
report's `review.paths` with `view_image` and its `review.prompt`; a passing
report does not establish visual quality.

The [HTML app check contract](/en/docs/ai/chat-interface#check-an-html-app-before-showing-it)
describes desktop/phone runs, disposable data, schema-only copies above the
budget, restricted effects and cancellation. Browser regressions use the
repository launcher and support Chromium or `TEST_BROWSER=webkit`.
