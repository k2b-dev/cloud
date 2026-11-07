---
title: AI providers without a data-protection commitment
navTitle: Restricted AI providers
section: Operations
order: 949
description: Upgrade notes for the third AI provider data boundary, restricted.
tags: [ai, providers, upgrades]
updated: 2026-11-04
---

# AI providers without a data-protection commitment

AI providers can use a third data boundary, `restricted`, next to `private`
and `hosted`. Its models serve only application server code that names a
model ID; people never use them. See
[Choose the data boundary](/en/docs/ai/models-and-providers#choose-the-data-boundary).

Existing providers are not migrated: they keep `hosted` or `private`, and their
models, grants and assignments stay unchanged. The AI migration only widens the
`ai.providers.data_boundary` check to accept `restricted`. No new service or
environment variable is required.

Choose the boundary when you create the provider. A provider never changes to
or from `restricted` afterwards; create a new provider instead. Such a
provider accepts only chat models, gives them no chat access and cannot fill
a class, the image tool, the audio tool or live dictation.

Clients that read providers or the AI overview must accept the new
`dataBoundary` value.
