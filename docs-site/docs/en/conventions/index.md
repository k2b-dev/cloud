---
title: Conventions for Cloud applications
navTitle: Overview
section: Conventions
order: 1280
description: Review an application with a checklist index of Cloud's public rules.
tags: [conventions, audit, checklist, review]
updated: 2026-10-16
---

# Conventions for Cloud applications

This catalog is a checklist index of the public rules every Cloud application
follows. Each row links to the canonical page that owns the rule. That page
stays authoritative: when a row disagrees with it, the canonical page wins and
the row is the bug.

Use [Audit an application](/en/docs/conventions/audit) to check a built-in or
third-party application and record findings.

## Read a row

| Column | Meaning |
| --- | --- |
| ID | Stable reference for a finding or review |
| Rule | One sentence naming the required behavior |
| Why | The consequence the rule prevents or the behavior it preserves |
| How to check | An automated check when available, followed by a manual equivalent |
| Canonical | The one public page that owns the rule |

IDs use `PREFIX-NN`, with two digits starting at `01` in each area. Never
renumber or reuse an ID. A dropped rule keeps its row: its Rule cell reads
`Retired. Replaced by SRV-13.`, for example, and its Canonical cell keeps one
link to the replacement rule's canonical page.

Rows apply to all applications unless the Rule cell starts with
`Built-in apps:`. Those rows describe monorepo workflow rules that third-party
applications do not follow. Check only rules relevant to the application's
surfaces.

## Choose an area

| Prefix | Area | Page |
| --- | --- | --- |
| CODE | Code structure | [Code and server](/en/docs/conventions/code-and-server#code-code) |
| SRV | Server and HTTP | [Code and server](/en/docs/conventions/code-and-server#server-and-http-srv) |
| ACC | Identity and access | [Access and data](/en/docs/conventions/access-and-data#identity-and-access-acc) |
| DATA | Data and effects | [Access and data](/en/docs/conventions/access-and-data#data-and-effects-data) |
| UI | Visual UI | [Frontend](/en/docs/conventions/frontend#visual-ui-ui) |
| IX | Interaction and feedback | [Frontend](/en/docs/conventions/frontend#interaction-and-feedback-ix) |
| A11Y | Accessibility | [Frontend](/en/docs/conventions/frontend#accessibility-a11y) |
| I18N | Internationalization | [Text and Help](/en/docs/conventions/text-and-help#internationalization-i18n) |
| DOC | Product text and Help | [Text and Help](/en/docs/conventions/text-and-help#product-text-and-help-doc) |
| CLI | CLI and Assistant Skills | [CLI, tests, and release](/en/docs/conventions/cli-tests-release#cli-and-assistant-skills-cli) |
| TEST | Testing | [CLI, tests, and release](/en/docs/conventions/cli-tests-release#testing-test) |
| REL | Release and deployment | [CLI, tests, and release](/en/docs/conventions/cli-tests-release#release-and-deployment-rel) |

## Use the checks

“How to check” names the monorepo check when one exists, such as
`bun scripts/check.ts <rule>` or a focused test file. Each automated check is
followed by a manual equivalent: a search pattern, a code-reading step, or an
action in the running application. Third-party applications use those manual
steps because they cannot run the monorepo checks.

A passing machine check covers only what it inspects. Follow the manual step
to verify the rule against the application's actual behavior.

## Keep the catalog current

Maintainers change the canonical page first, then its catalog row. Never
renumber IDs; retire dropped rules instead of deleting their rows.
`bun run --cwd docs-site check:docs` enforces ID format, uniqueness, no gaps,
exactly five cells, and exactly one canonical link per row; it also requires
every prefix to have at least one row and every prefix-table row to link to the
conventions page that holds that prefix's rows. Escape literal pipes as `\|`,
including inside code spans.
