---
title: FAQ
navTitle: FAQ
section: Everyday
order: 220
description: Short audience-aware answers for visitors, guests, and signed-in users.
tags: [faq, help, audiences, markdown]
updated: 2026-08-30
---

# FAQ

FAQ publishes short answers to questions that apply across Cloud rather than
to one application's workflow. Each visitor sees only the entries selected for
their audience, while administrators maintain the complete list.

## Use FAQ

- Scan the public FAQ for a question that matches the current task or problem.
- Open one answer at a time and follow links to longer app-specific Help when
  needed.
- Write one direct question and Markdown answer in English, then add a German
  translation when the topic should be available in German.
- Choose whether an entry is visible to anonymous visitors, guests, users, or
  more than one audience.
- Update or remove entries when the owning product behavior changes.

Audience filtering controls visibility; it is not a safe place for secrets or
private operational data.

## Understand the FAQ model

| Resource or surface | Responsibility |
| --- | --- |
| Entry | One logical question with localized Markdown answers, shared audiences, and one list position |
| Audience | Anonymous visitor, guest account, full user, or a combination |
| Public FAQ | Shows the ordered entries that match the current visitor, resolved to their request locale |
| Admin page | Lets administrators maintain English and optional German content, then reorder or delete entries |

FAQ is for compact cross-cutting answers. Detailed product procedures stay in
the Help surface owned by the relevant application.

English is the complete base content. Locale resolution uses an exact locale,
then its language ancestor, then English for each entry. For example, `de-CH`
uses `de` when present and otherwise falls back to `en`.

## How FAQ fits Cloud

FAQ owns entries, audience selection, ordering, and the public and admin
surfaces. Cloud supplies visitor identity, admin authorization, Postgres,
Markdown rendering, legal-link placement, OpenAPI publication, and the shared
Help shell.

## Find detailed product help

Open **Help** on the FAQ page for audience behavior and finding answers. The
admin page has guidance for writing and maintaining entries. Developers can
read [Authentication](/en/docs/identity/authentication),
[Route policies](/en/docs/identity/route-policies), and
[Public API surface](/en/docs/reference/api-surface) for the shared boundaries
FAQ uses.

## Inspect FAQ from the terminal

FAQ does not register a dedicated CLI module. Its generated API contract is
available through API Docs for administrators and integrations:

```bash
cld api-docs operations faq --json
cld api-docs spec faq > faq.openapi.json
```

Run `cld api-docs help` for schema search and operation details. FAQ API
operations require an administrator; the public FAQ page performs its own
audience filtering.
