---
title: stdlib service error compatibility
navTitle: stdlib service errors
section: Operations
order: 1201
description: Upgrade application libraries together with the expanded stdlib service error contract.
tags: [upgrade, capabilities, errors]
updated: 2026-11-20
---

# stdlib service error compatibility

Cloud Core 0.83 uses `@k2b/stdlib` 0.36.0. Independently deployed applications
on `@k2b/cloud` 0.75 or later may use stdlib 0.35 or later. Upgrade the Cloud
library in an application before returning the expanded stdlib statuses;
older libraries can reject these errors as `INVALID_APP_RESPONSE` and hide the
application's recovery message.

Capabilities preserve every stdlib 0.36 `ServiceError.status`, including
validation errors such as 413 and 422 and temporary failures such as 429 and
503. Cloud also keeps cancellation status 499. The same rule applies to
returned and thrown service errors. See [App capabilities](/en/docs/platform/capabilities)
for the complete list. Applications still own their stable codes and localized
messages; other statuses remain invalid provider responses.

Mail document reads return `DRAFT_DOCUMENT_READ_UNAVAILABLE` with 503 for an
unexpected loading failure. Clients that handle this code specifically should
accept 503 in place of 500, preserve the local text and offer a retry. The same
code and status can occur while preparing a shared draft for sending, before
a send command is created; nothing is queued in that case. History
and content conflicts keep their existing 409 responses. No data migration is
required for these error changes.

## Dependency type changes

stdlib 0.35 expands `ServiceError.status` and adds `err.unavailable()` and
`err.tooManyRequests()`. Application authors with exhaustive status or code
mappings must handle the expanded unions. `isServiceError()` keeps its numeric
shape check; the capability boundary applies its explicit supported list.

stdlib 0.36 adds optional DATEV document links and file-only `documentImage`
documents. Code consuming `DatevXmlFileDocument` must check
`document.dataFile !== undefined` before reading ledger metadata. Existing
ledger documents retain their output. Cloud's current consumers do not use the
expanded DATEV XML document types. Grids stamps newly issued financial artifacts
with stdlib 0.36.0 as the renderer and validator version; existing artifact
provenance remains unchanged.
