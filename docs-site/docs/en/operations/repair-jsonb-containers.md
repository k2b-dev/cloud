---
title: Repair encoded JSON metadata
navTitle: Repair JSON metadata
section: Operations
order: 1115
tags: [database, maintenance, json]
updated: 2026-09-15
description: Inspect and repair JSON objects and arrays stored as JSON strings.
---

# Repair encoded JSON metadata

Older writers could store an object or array as a JSON string inside a JSONB
column. JSON filters then failed to find its fields. Updated writers pass JSON
text through an explicit SQL text cast before converting it to JSONB.

Use the checkout's maintenance script to inspect one supported table:

```sh
bun --no-env-file scripts/repair-jsonb-containers.ts --table audit.events
```

Supply `DATABASE_URL` through your normal secret environment for the intended
database. The command prints counts, never metadata contents or credentials.
It does not write unless you add `--apply`.

Before applying a repair, confirm the target database and its backup and recovery
procedure, and deploy the corrected writers. Then run the same command with
`--apply`. Work is committed in batches of at most 500 rows. A failed run can be
repeated; already corrected rows are skipped. Rows changed concurrently are not
overwritten.

Only columns explicitly listed in the script are eligible. The repair decodes
one layer when it contains the column's expected object or array. Malformed
values, scalar values, unexpected container types, and strings containing NUL
characters or unpaired Unicode surrogates remain unchanged and are
counted as preserved. Decoding takes place in PostgreSQL so large JSON numbers
retain their precision. PostgreSQL validation errors stop the current batch;
earlier batches remain committed. The CLI reports a generic error with a nonzero
exit status and suppresses database error details that could contain metadata.

This is not a database-wide JSON conversion. Workflow results and other fields
that permit scalar JSON are excluded. AI message `loop_aggregate` is also
excluded: updating it invokes accounting triggers and needs a separate repair
that respects the latest aggregate. Pending AI action arguments and outcomes
likewise need their own type-aware review. The tool does not cover Grids or
perform repairs automatically during application startup.

## Verify the repair tool

The database integration test is manual and is not part of CI. Use a disposable,
freshly migrated fixture database with an empty `audit.events` table; the test
inserts explicit fixture IDs and must not run against an existing installation.
With that fixture's connection supplied through `DATABASE_URL`, run:

```sh
CLOUD_JSONB_REPAIR_TEST=1 bun --no-env-file test --timeout 20000 scripts/repair-jsonb-containers.integration.test.ts
```

The test checks numeric cursor ordering, exact JSON number preservation,
repeatability, unsupported Unicode preservation, and the CLI dry-run behavior.
