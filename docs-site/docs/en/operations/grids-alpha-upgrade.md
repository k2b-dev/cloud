---
title: Upgrade Grids across the alpha cut
navTitle: Grids alpha upgrade
section: Operations
order: 1138
description: Check an existing Grids installation before adopting the current document and workflow storage contract.
tags: [grids, migration, backup, workflows]
updated: 2026-09-12
---

# Upgrade Grids across the alpha cut

Check a restored copy before replacing the Grids application image. This cut
does not convert old document hashes, rewrite published workflow plans, or
delete data. An incompatible installation refuses to start.

Compatible documents and workflows remain usable, including archived workflows.
A missing workflow migration marker alone does not make data incompatible.
The supported formats are document/receipt/query-capture hash version **2**,
workflow plan schema **2**, query binding **3**, and recorded capture-byte budgets
for every existing run. Older workflow tables are not supported.

## Check before deploying

1. Record the current application images and configuration. Arrange a maintenance
   window with no Grids writers or workflow workers running during the cutover.
2. Back up the installation and verify restoration into an isolated environment.
   Preserve the Postgres database, document/file storage, encryption keys, and
   the workflow runtime state required by the previous deployment. A dump of
   `grids.*` alone is not sufficient: workflow plans and journals live in
   `workflows.*`, and file references are not the file bytes. Follow the
   installation's backup and recovery procedure. Do not test restores against
   production or let restored workers send emails, HTTP requests, or payments.
3. From the new Cloud checkout, run the following against the **restored copy**.
   The protected environment file must supply its `DATABASE_URL`:

   ```bash
   bun --env-file=/secure/grids-restored-copy.env packages/grids/scripts/check-alpha-upgrade.ts
   ```

   The command writes no data or schema and starts no application workers. It
   briefly locks the inspected tables; do not use it as a concurrent production
   health check. Exit `0` means the alpha guard accepted the stored contracts.
   Exit `1` reports an incompatibility or connection/check failure.
4. If accepted, rehearse the normal application upgrade on the isolated copy.
   Verify startup, retained document downloads and evidence, and a pending
   workflow's resume/confirmation flow without external effects. The guard is
   not a substitute for this rehearsal. Only then schedule the actual cutover.

## If the check rejects the installation

Keep the previous deployment and its backups. If a startup attempt failed at
this guard, it did not convert or remove Grids data. Do not insert migration
markers, change hashes, fill missing budgets with zero, or delete individual
profile rows to bypass it. These changes do not make the stored state compatible.

There is **no in-place migration for rejected alpha state**. Choose one path:

- **Retain the installation:** keep using its previous version while the
  maintainer evaluates a separate, explicitly scoped migration. Do this when
  documents, finalized records, or pending work must remain operational.
- **Start a separate installation:** retain the old installation as an archive
  and use fresh storage for the new one. Before retiring the old runtime, export
  needed workflow sources, documents, evidence, and business data through the old
  version. Verify the exports independently. Recreate definitions and review
  their bindings in the new installation; old run journals and issued document
  identities are not portable workflow definitions.

Republishing is an action in a running compatible installation, not a recovery
command for an application that cannot start. Deleting old state requires a
separate operator-approved plan covering exact records, shared kernel state,
files, retention obligations, and recovery. This guide intentionally provides
no blanket deletion command.

See [Deployment requirements](/en/docs/operations/deployment-requirements) and
[Migrations and transactions](/en/docs/data/migrations-and-transactions).
