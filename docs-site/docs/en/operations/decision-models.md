---
title: Configure decision models
navTitle: Decision models
section: Operations
order: 1226
description: Configure a System One decision model and coordinate upgrades with older AI readers.
tags: [operations, ai, models, migration]
updated: 2026-11-04
---

# Configure decision models

Decision models answer typed questions with probabilities. Applications use
[`runAiDecision`](/en/docs/ai/structured-and-background-ai#ask-typed-decision-questions)
for routing, triage and scoring. They have their own **Decision** slot under
**Administration → AI → Classes** and do not appear in chat model choices.

## Upgrade all AI readers together

This release adds `decision` to the catalog’s model kinds and assignment
slots. The migration inserts an empty `decision` assignment. The parsers in
`cloud-v0.64.0` reject that slot even before a decision model is configured;
a decision model row also makes their model-list parser fail. Older
applications that read AI settings can therefore lose all AI functionality
while sharing this catalog.

Before migrating Core, stop older AI readers and prepare compatible versions
of every application using the shared AI catalog, including third-party apps.
Upgrade those applications together with Core. A rolling deployment mixing
old and new AI readers against the migrated database is unsupported. There is
no new setting or environment variable to enable the catalog extension.

## Add a cortecs decision model

1. Under **Administration → AI → Models**, create or reuse an
   **OpenAI-compatible** provider with base URL `https://api.cortecs.ai/v1`.
   Store its cortecs key using the existing provider credential field. Choose
   the data boundary according to your provider agreement.
2. Choose **Add models**, then enter the provider model identifier manually.
   Select **Decision** and enter the model’s documented context window.
   cortecs serves Cloudflare Clef and Clef Flash through `POST /v1/systemone`;
   the verified identifier for Clef Flash is `clef-flash`. Its models endpoint
   defaults to chat models: query `/v1/models?tag=Decision` to find decision
   models. Use the model’s documented context limit.
3. Open the model to configure its token prices. Enable image support only
   when that decision model accepts images. Decision models support their
   standard variant, without chat parameters or reasoning overrides.
4. Under **Classes → Decision**, select that model. Leave the slot empty to
   disable default decision calls. No chat class acts as a fallback.
5. Run one authorized application decision and check the AI usage report for
   its task name, model and usage. Test model grants for person-facing calls.

For providers without a data-protection commitment (`restricted`), the model
cannot be assigned to a slot. Only application server code naming its exact
ID can use it; person-facing calls reject it.

The existing background cost stop and personal Assistant allowances apply.
Models can have individual budget rules and token prices. A missing usage
measurement is booked as an estimate. System One has no output-token cap, so
Cloud reserves the configured context bound and rejects an allowance that
would require reducing it. For images it also reserves the full input context.

## Roll back before starting old processes

Keep the new Core running while preparing a rollback:

1. Stop AI callers and clear **Classes → Decision**.
2. Delete every decision model through the existing model deletion flow,
   including any models on restricted providers. Remove their fixed references
   from application configuration first.
3. With the callers stopped, remove the empty assignment from the database:

   ```sql
   DELETE FROM ai.model_assignments WHERE slot = 'decision' AND variant_id IS NULL;
   ```

4. Verify that no `ai.models` row has `kind = 'decision'` and no
   `ai.model_assignments` row has `slot = 'decision'`. Then stop the new Core
   and start the previous release.

Without this cleanup, old readers reject the catalog and the previous Core
migration fails when restoring its narrower database CHECK constraints. Do
not restart the new Core between cleanup and rollback: it recreates the empty
assignment. Existing inference history can remain; its task and model metadata
do not use the new catalog enums.
