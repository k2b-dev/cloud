---
title: Audit an application against the conventions
navTitle: Audit an application
section: Conventions
order: 1281
description: Check built-in and third-party applications and report findings by root cause.
tags: [conventions, audit, review, checklist]
updated: 2026-10-15
---

# Audit an application against the conventions

Use the [Conventions for Cloud applications](/en/docs/conventions) catalog to review one
application. Follow the canonical link whenever a row needs more context.

## 1. Name the application and its surfaces

Record the app ID, the version or revision you inspect, and its public
surfaces: routes and prefixes, pages, API, CLI commands, capabilities,
Assistant Skills, and Help. Note which surfaces the application does not have.

## 2. Run the checks that apply

In the Cloud monorepo, run the named `bun scripts/check.ts <rule>` checks and
focused tests from the relevant rows. For a third-party application, use their
manual equivalents. Record failures and checks you could not run; capture the
reproduction for every finding (the check command, a grep, or a click path).

## 3. Walk the catalog

Review each applicable area against the code. Where a rule names the running
application, check it at desktop and phone width in light mode. Verify the
canonical page's expected behavior, including denied requests and retries
where relevant. Capture the reproduction for every finding (the check command,
a grep, or a click path).

## 4. Record findings

Use this format. The filled row uses demo data:

```text
ID | Location (file:line or URL) | Severity | Observed vs. expected | Reproduce | Fix
ACC-02 | src/service/items.ts:42 | blocker | Demo item is returned without checking read permission; the service must authorize the resource. | curl -i "$DEMO_APP_URL/api/items/demo-item" | Resolve the subject's permission before reading the item.
```

| Severity | Meaning |
| --- | --- |
| blocker | Security, authorization, data loss, or an irreversible action |
| major | Broken public contract or user-visible defect |
| minor | Consistency or polish |

## 5. Group findings by root cause

One root cause can violate several convention IDs. Group its findings and
propose one fix per root cause instead of separate fixes for each symptom.

## 6. Report findings

Search the tracker for open issues before filing a report. Add evidence to an
existing issue when it already describes the same problem.

In `k2b-dev/cloud`, file one GitHub issue per root cause using the **Agent
report** issue form, with labels `via-agent` and `needs-triage`. Use its four
sections exactly:

- **What is wrong**: IDs, severity, and observed vs. expected behavior.
- **How to reproduce**: the reproduction recorded for the finding.
- **Suspected cause**: the location (`file:line`) with one sentence explaining why.
- **Proposal**: the fix, or a decision needed from the maintainer.

Use demo data only. Include no personal data or screenshots with personal
content; redact secrets and machine-specific paths. A third-party application
uses its own tracker.

## Leave out inapplicable rules and duplicates

Do not report a rule that does not apply: for example, a `Built-in apps:` row
for a third-party application, or a rule about a surface the app does not have.
Do not create duplicate issues; add new evidence to the existing report.
