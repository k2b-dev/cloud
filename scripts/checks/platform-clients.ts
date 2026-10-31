import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// Transitional source contents only; each package migration removes its entries.
export const baseline: Record<string, string[]> = {
  "packages/grids/scripts/diagnostics-worker.ts": [
    'import { sql } from "bun";',
    'const db = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);',
    "...(process.env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(process.env.NATS_CREDS_FILE)) } : {}),",
    "...(process.env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(process.env.NATS_CREDS_FILE)) } : {}),",
  ],
  "packages/grids/scripts/diagnostics.ts": ["const admin = new SQL(adminUrl, { connectionTimeout: 5, max: 1 });"],
  "packages/grids/scripts/load-test.ts": ['import { sql } from "bun";'],
  "packages/grids/scripts/render-document-template-previews.ts": ['import { sql } from "bun";'],
  "packages/grids/scripts/soak-100k.ts": ['import { sql } from "bun";'],
  "packages/grids/scripts/sql-boundary-smoke.ts": ['import { sql } from "bun";'],
  "packages/grids/scripts/verify.ts": [
    'import { SQL, sql } from "bun";',
    'const databaseUrl = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);',
    "const admin = new SQL(adminUrl, { connectionTimeout: 5 });",
  ],
  "packages/grids/src/api/access-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/agent-principal-parity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/controlled-destruction-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/core-resource-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/custom-app-document-preview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/custom-apps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/document-links.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/durable-history-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/evidence-exports.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/finalization-policy-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/gql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/html-template-fields.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/live-channels.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/oauth-scope.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/preservation-hold-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/resolve.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/retention-policy-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/table-admin-overview-routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/api/workflow-machine-authority.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/capabilities.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/cli/csv-import-recipe.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/custom-apps/runtime-context.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/frontend/_components/workspace/workspace-records-url.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/frontend/custom-app/page.integration.test.tsx": ['import { sql } from "bun";'],
  "packages/grids/src/integration-test-utils.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/migrate.ts": ['import { sql as defaultSql, type SQL } from "bun";'],
  "packages/grids/src/query-dsl/calculation-preparation.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/export-precision.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/group-paging.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/preview-authorization.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/preview.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/record-query-plan.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/resolver-aggregates.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/resolver-computed-fields.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/resolver-derived-columns.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/resolver-scope.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/resolver.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/scoped-formula.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-aggregate.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-aggregates.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-derived.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-fields.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-fragments.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-grouped.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-grouping.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-joins.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-joins.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-liveness.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-object-lists.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-prepared-fields.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-row.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-row.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-scope.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-source.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-summary-joins.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler-where.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler.integration-fixtures.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-compiler.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/sql-record-source.ts": ['import { sql } from "bun";'],
  "packages/grids/src/query-dsl/summary-joins.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/access-group-membership.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/access-last-manager.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/access-registry.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/access.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/aggregate-compiler.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/audit-history.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/audit.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/authorization-projections.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/base-catalog.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/base-catalog.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/base-navigation.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/bases.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/bases.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/bounded-query.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/bounded-query.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/combined-audit.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/computed-finalized.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/computed-projections.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/controlled-destruction.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/controlled-destruction.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/custom-app-article-fixture.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-background.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-document-preview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-document-preview.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-fixtures.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-metrics.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-navigation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-records-query.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-reimbursement-fixture.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-app-workflow-progress.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-apps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/custom-apps.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-browse.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-browse.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-catalog.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-core.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-core.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-export-claims.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-financial-issuance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-issuance.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/grids/src/service/document-issuance.ts": ['import { sql as defaultSql, type SQL } from "bun";'],
  "packages/grids/src/service/document-links.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-links.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-mappers.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/document-query-expression.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-record-sources.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/document-reservation-locks.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-snapshots.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-snapshots.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/document-templates.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/document-workflow-crash.integration.test.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/document-workflow-crash.worker.ts": [
    'import { sql } from "bun";',
    'const database = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);',
  ],
  "packages/grids/src/service/document-zip-crash.worker.ts": [
    'import { sql } from "bun";',
    'const database = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);',
  ],
  "packages/grids/src/service/document-zip.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/durable-history.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/durable-history.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/email-templates.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/email-templates.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/evidence-cleanup.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/evidence-exports.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/evidence-exports.ts": ['import { type SQL, type SQLQuery, sql } from "bun";'],
  "packages/grids/src/service/federated-tables.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/federated-tables.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-dependents.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-indexes.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/field-read.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-restore.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-storage.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-validation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/field-validation.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/fields-jsonb.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/fields-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/fields-local-calculations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/fields.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/files.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/files.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/filter-compiler-render.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/finalized-computed-dependencies.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/finalized-computed-values.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/finalized-field-sql.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/form-config-validation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/form-submission.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/form-submission.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/forms.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-numeric-sql.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-preview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-preview.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-sql-compiler.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-sql-expression-compiler.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-sql-functions.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-sql-parity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/formula-sql-values.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/gql-preparation-cache.ts": ["client = new RedisClient(url, { enableOfflineQueue: false });"],
  "packages/grids/src/service/gql-resolver-context.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/group-compiler.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/html-template-fields.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/keyset-compiler.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/keyset-compiler.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/local-calculation-storage.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/local-calculation-storage.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/local-calculations.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/lookup-display.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/mutation-policy.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/mutation-policy.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/named-refs.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/navigation-reference-jsonb.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/number-series.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/number-series.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/numeric-division-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/numeric-division-sql.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/numeric-median-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/numeric-median-sql.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/numeric-power-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/numeric-sqrt-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/object-list-import.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/object-list-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/object-list-sql.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/operational-health.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/parent-checks.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/permission-resolver.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/permission-resolver.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/preservation-holds.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/preservation-holds.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/public-resource-ids.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/query-validation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/query-validation.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-audit.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-change-feed.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-change-feed.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-comments.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-comments.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-event-delivery-failures.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-event-delivery-failures.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-event-outbox.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-event-outbox.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-event-runtime.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-external-identity.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-finalization.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-finalization.ts": ['import { type SQLQuery, sql } from "bun";'],
  "packages/grids/src/service/record-metadata.ts": ['import { type SQLQuery, sql } from "bun";'],
  "packages/grids/src/service/record-parent-invariants.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-read-frozen.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-read.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-scan-codes.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-unique-conflicts.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/record-write.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/records-query-parity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/records-sql-formula.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/records.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/reference-renames.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/referenced-by.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/referenced-by.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-access.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-label-calculations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-labels.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-labels.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-links.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/relation-targets.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/retention-policy.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/retention-policy.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/search.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/sort-compiler.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/table-admin-overview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/table-admin-overview.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/tables.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/templates.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/usable-custom-apps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/views.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-action-scope.ts": [
    'import { SQL, sql } from "bun";',
    "const pool = new SQL({ ...sql.options, max: 2 });",
  ],
  "packages/grids/src/service/workflow-actions.integration.test.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-atomic-records.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-authorization.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-authorization.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-capture-access.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-catalog.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-concurrency.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-definitions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-definitions.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-document-sources.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-email-deliveries.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-email-deliveries.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-email-send.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-execution-authorization.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-history.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-launcher-invocations.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-launchers.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-machine-authority.ts": ['import { SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-query-binding.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-query-data.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-query-data.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-query-store.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-query-store.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-read.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-record-events.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-run-events.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-run-stats.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-runs.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workflow-runtime.ts": ["workflowEffectDb = new SQL();"],
  "packages/grids/src/service/workflow-test-fixture.ts": ['import { type SQL, sql } from "bun";'],
  "packages/grids/src/service/workflow-values.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workspace-revision.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/service/workspace-revision.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing-custom-app-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing-journeys.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing-lines.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing-payment-entry.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing-projection.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/billing.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/custom-app-runtime.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/install-policies.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/instantiate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/template-views.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/templates/workflows.integration.test.ts": ['import { sql } from "bun";'],
  "packages/grids/src/workflows.ts": ['import { sql } from "bun";'],
  "packages/mail/scripts/browser-smoke.ts": ['import { sql } from "bun";'],
  "packages/mail/scripts/memory-load.ts": ["if (testValkey && process.env.REDIS_URL !== testValkey) {"],
  "packages/mail/scripts/memory-load/runner.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/mail/scripts/perf-baseline/ingest-worker.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
    'assertRunUrl(process.env.DATABASE_URL ?? "", input.postgresPort, "postgresql:", "cloud_perf_test");',
    'assertRunUrl(process.env.REDIS_URL ?? "", input.valkeyPort, "redis:");',
  ],
  "packages/mail/scripts/perf-baseline/runner.ts": ["explainControl = new SQL(pgUrl);", "db = new SQL(observerUrl.href);"],
  "packages/mail/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/conversation-preview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/default-sender-setup.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/draft-document-socket.integration.test.ts": ['import { type Server, sql } from "bun";'],
  "packages/mail/src/api/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/mailbox-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/oauth-scope.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/search-flags.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/search-public-ids.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/workflow-try.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/workspace-detail.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/api/workspace-list.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/cli.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/migrate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/mail/src/notifications.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/notifications.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/access.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/ai-daily-budget.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/ai-daily-budget.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/archive-role.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/assigned-access-reads.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/assigned-access-writes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/assigned-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/attachment-extraction.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/attachment-extraction.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/attachment-links.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/attachment-links.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/attachment-order.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automatic-reply-access.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automatic-reply-configuration.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automatic-reply.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automation-effect-state.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automation-log-recording.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automation-log-recording.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automation-log.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/automation-log.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/binding-rediscovery.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/bindings.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/bulk-disposition.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/calendar-invitations.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/capability-review-readers.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/capability-reviews.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/collaboration-operations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/collaboration.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/collaboration.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/collaborators.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/command-authorization.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/command-runtime.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/command-runtime.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/command-target-index.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/command-undo.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/commands-list.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/commands.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/compose-safety.ts": ['import { type SQL, sql } from "bun";'],
  "packages/mail/src/service/compose-templates.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/compose-templates.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/contact-directory.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-action-undo.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-actions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-assignments.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-assignments.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-completions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-context.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-context.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-keep-rules.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-keeps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-keeps.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-preview.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-reference.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary-ai.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary-ai.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary-jobs.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary-jobs.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary-lifecycle.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-summary.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-timeline.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversation-work-state.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/conversations.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/done-today.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-document-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-document-socket-sql.ts": ['import { type SQL, sql } from "bun";'],
  "packages/mail/src/service/draft-documents.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-leases.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-provider-projection.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-table-actions.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/draft-uploads.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/drafts.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/drafts.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/execution.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/focus-performance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/focus.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/focus.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/folder-display.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/folder-display.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/folders.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/follow-up-scope.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/group-eligibility.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/health.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/hydration-scheduling.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/imap-push-runtime.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/inbox-views.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/incoming-automation-workload.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/incoming-automations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/incoming-automations.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/kept-conversations.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/lifecycle.integration.test.ts": [
    'import { redis, SQL, sql } from "bun";',
    'import { redis, SQL, sql } from "bun";',
  ],
  "packages/mail/src/service/list-subscriptions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/list-subscriptions.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/live-frame.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/local-tags.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/local-tags.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-details.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-details.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-lifecycle.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-logos.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-preferences.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-preferences.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailbox-transport-fence.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/mailboxes.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/maintenance-runtime.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-blobs.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-blobs.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-hydration-admission.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-hydration.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/mail/src/service/message-identity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-inspector.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-inspector.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/message-lists.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/messages.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/notification-targets.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/operations.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/operator-actions.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/outbound-message-projection.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/performance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/persistence.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/presence.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/provider-connections.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/provider-lease-fairness.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/mail/src/service/provider-operation-lock.ts": ['import { redis } from "bun";'],
  "packages/mail/src/service/provider-pacer.integration.test.ts": ['import { redis } from "bun";'],
  "packages/mail/src/service/provider-pacer.ts": ['import { redis } from "bun";'],
  "packages/mail/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/recipient-suggestions-performance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/recipient-suggestions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/recipient-suggestions.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/reference-response-policy.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/reminders.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/remote-changes-fixture.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/remote-changes-teardown.child-suite.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/remote-changes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/remote-content.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/remote-content.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/resource-parents.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/runtime-history-retention.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/saved-views.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/scheduled-sends.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/search-window.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/search.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/security.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/security.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/send-login-notifications.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sender-disposition.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sender-disposition.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sender-identities.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sender-identity-transports.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sender-verification.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sent-projection.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/storage-observability.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/storage-observability.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sync-recovery.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sync-runs.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/sync-runtime.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/mail/src/service/triage.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/view-counts.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-ai.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-catalog-service.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-data.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-data.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-definition-service.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-effect-order.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-message-preconditions.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-placement-steps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-runtime-context.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-runtime-values.test.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-runtime-values.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-runtime.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-schedule-runtime.ts": ['import { sql } from "bun";'],
  "packages/mail/src/service/workflow-try.ts": ['import { sql } from "bun";'],
  "packages/mail/src/workflows/actions.ts": ['import { sql } from "bun";'],
  "packages/mail/test/fixtures/large-mailbox.integration.test.ts": ['import { sql } from "bun";'],
  "packages/mail/test/fixtures/recipient-suggestions.ts": ['import { sql } from "bun";'],
  "packages/mail/test/fixtures/send-content.ts": ['import { sql } from "bun";'],
  "packages/mail/test/integration-preload.ts": ['import { sql } from "bun";'],
};

const delivered = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "VALKEY_URL",
  "NATS_SERVERS",
  "SYNC_NAMESPACE",
  "SYNC_REPLICAS",
  "NATS_CREDS_FILE",
  "NATS_TLS_CA_FILE",
  "NATS_IGNORE_CLUSTER_UPDATES",
  "APP_SECRET",
]);
// Test targets and native mock objects intentionally need constructors and env.
// Client value imports still go through the platform in these files.
const fixtureFiles = new Set([
  "packages/cloud/scripts/platform-start.test-fixture.ts",
  "pwas/pwa-auth/test/server.ts",
  "scripts/scale-acceptance.ts",
]);
const fixture = (file: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /^(?:scripts\/fixtures\/|tests\/|packages\/[^/]+\/(?:test|bench)\/)/.test(file) ||
  fixtureFiles.has(file);
const resolver = "packages/cloud/src/runtime/resolve-connections.ts";
// These operator tools consume only HTTP or NATS; starting database/cache clients
// would add unrelated infrastructure prerequisites. No native clients are allowed.
const connectionOnlyTools = new Map([
  ["scripts/prod-upgrade-preflight.ts", new Set(["SYNC_NAMESPACE"])],
  ["packages/cloud/scripts/sync-recovery-smoke.ts", new Set(["NATS_SERVERS", "SYNC_REPLICAS"])],
]);

export const checkSource = (file: string, source: string): Finding[] => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const namespaces = new Set(["Bun"]);
  const constructors = new Set(["SQL", "RedisClient"]);
  const importedConstructors = new Set<string>();
  const sqlConstructors = new Set<string>();
  const environments = new Set(["env"]);
  const report = (node: ts.Node, message: string) =>
    findings.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, message });
  const clientMessage = "import sql/redis from @k2b/cloud (Cloud internals use runtime/clients); Bun globals bypass platform start";
  const poolMessage = "use createSql(options) / createRedis(options) from @k2b/cloud; preserve owned pool limits and lifecycle";
  const envMessage = "read delivered connection values through connections() from @k2b/cloud, not env";
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const names = clause.namedBindings;
    if (node.moduleSpecifier.text === "bun") {
      if (clause.name) namespaces.add(clause.name.text);
      if (names && ts.isNamespaceImport(names)) namespaces.add(names.name.text);
      if (names && ts.isNamedImports(names))
        for (const item of names.elements) {
          if (item.isTypeOnly) continue;
          const name = item.propertyName?.text ?? item.name.text;
          if (name === "sql" || name === "redis") report(item, clientMessage);
          if (name === "SQL" || name === "RedisClient") {
            constructors.add(item.name.text);
            importedConstructors.add(item.name.text);
            if (name === "SQL") sqlConstructors.add(item.name.text);
          }
        }
    }
    if (names && ts.isNamedImports(names))
      for (const item of names.elements) if ((item.propertyName?.text ?? item.name.text) === "env") environments.add(item.name.text);
  }
  const staticKey = (node: ts.Node): string | undefined => {
    if (ts.isComputedPropertyName(node)) return staticKey(node.expression);
    if (ts.isParenthesizedExpression(node)) return staticKey(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  };
  const bindingKey = (node: ts.BindingElement) => {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) ? key.text : staticKey(key);
  };
  const member = (node: ts.Node): { object: ts.Expression; name: string } | undefined => {
    if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node)) {
      const name = staticKey(node.argumentExpression);
      if (name !== undefined) return { object: node.expression, name };
    }
  };
  const isEnv = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return environments.has(node.text);
    const property = member(node);
    return !!property && property.name === "env" && ts.isIdentifier(property.object) && ["process", "Bun"].includes(property.object.text);
  };
  const isWrite = (node: ts.Node) =>
    ts.isDeleteExpression(node.parent) ||
    (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  const isBun = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return isBun(node.expression);
    if (ts.isIdentifier(node)) return namespaces.has(node.text);
    const property = member(node);
    if (property && property.name === "Bun" && ts.isIdentifier(property.object) && property.object.text === "globalThis") return true;
    return (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === "bun"
    );
  };
  // Only track direct module assignments; this remains a syntactic regression guard.
  const collectAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isBun(node.initializer))
      namespaces.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isBun(node.right)
    )
      namespaces.add(node.left.text);
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(ast);
  const isTypeUse = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      // A class extends expression executes; interface extends and implements do not.
      if (
        ts.isExpressionWithTypeArguments(parent) &&
        ts.isHeritageClause(parent.parent) &&
        parent.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(parent.parent.parent) || ts.isClassExpression(parent.parent.parent))
      )
        continue;
      if (ts.isTypeNode(parent)) return true;
      if (ts.isStatement(parent)) break;
    }
    return false;
  };
  const isConstructorValue = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (isTypeUse(node) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      sqlConstructors.has(node.text) &&
      parent.name.text === "PostgresError"
    )
      return false;
    if (ts.isExportSpecifier(parent))
      return node === (parent.propertyName ?? parent.name) && !parent.isTypeOnly && !parent.parent.parent.isTypeOnly;
    return ts.isShorthandPropertyAssignment(parent) || !("name" in parent && parent.name === node);
  };
  const nativeAllowed = fixture(file) || file.startsWith("packages/cloud/src/runtime/");
  const envAllowed = (key: string) => fixture(file) || file === resolver || connectionOnlyTools.get(file)?.has(key);
  const visit = (node: ts.Node) => {
    const property = member(node);
    if (property && isBun(property.object) && ["sql", "redis"].includes(property.name)) report(node, clientMessage);
    if (!nativeAllowed && property && isBun(property.object) && ["SQL", "RedisClient"].includes(property.name) && !isTypeUse(node))
      report(node, poolMessage);
    if (
      !nativeAllowed &&
      ts.isIdentifier(node) &&
      importedConstructors.has(node.text) &&
      isConstructorValue(node) &&
      !(ts.isNewExpression(node.parent) && node.parent.expression === node)
    )
      report(node, poolMessage);
    if (ts.isNewExpression(node) && !nativeAllowed) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && constructors.has(expression.text)) report(node, poolMessage);
    }
    if (property && !envAllowed(property.name) && delivered.has(property.name) && isEnv(property.object) && !isWrite(node))
      report(node, envMessage);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      if (isEnv(node.initializer))
        for (const item of node.name.elements) {
          const name = bindingKey(item);
          if (name && delivered.has(name) && !envAllowed(name)) report(item, envMessage);
        }
      if (isBun(node.initializer))
        for (const item of node.name.elements) {
          const name = bindingKey(item);
          if (name && ["sql", "redis"].includes(name)) report(item, clientMessage);
          if (!nativeAllowed && name && ["SQL", "RedisClient"].includes(name)) report(item, poolMessage);
        }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun" &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    )
      for (const item of node.exportClause.elements) {
        if (item.isTypeOnly) continue;
        const name = item.propertyName?.text ?? item.name.text;
        if (["sql", "redis"].includes(name)) report(item, clientMessage);
        if (!nativeAllowed && ["SQL", "RedisClient"].includes(name)) report(item, poolMessage);
      }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

export const rule: Rule = {
  name: "platform-clients",
  description: "database/cache clients and delivered connections belong to the platform startup snapshot",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const file of ["packages", "scripts", "tests", "pwas", "docs-site/examples"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .sort()) {
      const path = relative(workspaceRoot, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      const lines = source.split(/\r?\n/);
      const result = checkSource(path, source);
      const remaining = [...(baseline[path] ?? [])];
      const added = result.filter((finding) => {
        const index = remaining.indexOf(lines[finding.line! - 1]!.trim());
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
      });
      if (remaining.length) findings.push({ file, message: "remove resolved platform-clients baseline entries after migrating this file" });
      findings.push(...added.map((finding) => ({ ...finding, file })));
    }
    return findings;
  },
};
