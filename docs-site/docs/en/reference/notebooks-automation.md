---
title: Notebooks automation capabilities
navTitle: Notebooks automation
section: Reference
order: 61
tags: [notebooks, capabilities, events, automation]
updated: 2026-11-07
description: React to page discussion posts and create comments or notes within a notebook's grants.
---

# Notebooks automation capabilities

`notebooks.comment.created` is a version 1 resource event with a
`notebooks.comment` subject, `notebooks.notebook` place and empty data. The
references use public IDs accepted by `comment.read` and `notebook.read`. The
post and event commit together; failure rolls both back. Editing or deleting a
post, including an unchanged edit, emits no creation event. Passage annotations
use their existing separate contract.

`comment.create` and `note.create` declare `policy: { silent: "shared" }`.
Both are closed-world, non-destructive Actions with required idempotency keys.
Their English and German reviews include the full proposed text and a
`notebook:<public-id>` scope. Templates retain their content checksum. Current
write access is checked during review and again during execution; a parent
must belong to the selected notebook. Comment creation also retains its
current user requirement. These policies grant no access and do not extend
silent execution to moving or deleting content.

In this release, clients may remember the first confirmation for the notebook
scope. Resource-owned automations still require their platform mandate and
current grants. See [Action policies](/en/docs/platform/capabilities#describe-each-call-with-policy-and-typed-slots)
and [App events](/en/docs/platform/app-events) for delivery and retry rules.
