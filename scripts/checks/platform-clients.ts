import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// Transitional source contents only; each package migration removes its entries.
export const baseline: Readonly<Record<string, readonly string[]>> = {
  "docs-site/examples/cloud-docs/data-shared-text.ts": ['import { sql } from "bun";'],
  "docs-site/examples/cloud-docs/data.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/app-devices.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/audit.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/avatar-delivery.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/group-machine-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/group-machine-management.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/group-machine-members.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/machine-key-administration.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/personal-group-exports.integration.test.ts": ['import { sql } from "bun";'],
  "packages/accounts/src/api/personal-group-retirement.integration.test.ts": ['import { sql } from "bun";'],
  "packages/assistant/scripts/eval-code-mode.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/admin.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/agent-host.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/api.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/capability-runtime.ts": ['import { type SQL, sql } from "bun";'],
  "packages/assistant/src/artifacts/chat-presentations.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/chat-reference.test.ts": ['const begin = spyOn(bun.sql, "begin").mockImplementation(async (run) => {'],
  "packages/assistant/src/artifacts/client-calls.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/code-mode.eval.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/code-tools.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/database-settings.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/assistant/src/artifacts/database.ts": [
    'import { SQL, sql } from "bun";',
    "const mutationIntents = new SQL({ max: 1, connectionTimeout: 15 });",
  ],
  "packages/assistant/src/artifacts/file-transfer.integration.test.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/html/check-service.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/http-service.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/machine-api.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/machine-execution.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/machine-management.integration.test.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/machine-service.ts": ['import { type SQL, sql } from "bun";'],
  "packages/assistant/src/artifacts/machine.integration-cases.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/migrate.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/scheduled-code.integration.test.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/service.integration.test.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/artifacts/service.ts": ['import { type SQL, sql } from "bun";'],
  "packages/assistant/src/artifacts/storage-settings.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/assistant/src/artifacts/storage-settings.ts": ['import { sql } from "bun";'],
  "packages/assistant/src/chat-context.ts": ['import { sql } from "bun";'],
  "packages/chat/scripts/browser-smoke.ts": [
    'import { sql } from "bun";',
    "if (createdChats.size && !process.env.DATABASE_URL)",
    "for (const createdId of process.env.DATABASE_URL ? createdChats : []) {",
  ],
  "packages/chat/src/api/attachments.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/conversations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/discussion-capabilities.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/for-you.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/generic-discussions.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/chat/src/api/index.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/item-events.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/live.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/message-mutations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/messages.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/messages.model.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/messages.test-fixture.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/notification-preferences.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/chat/src/api/reactions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/read-state.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/search.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/shared.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/snapshot.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/api/system-chats.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/api/threads.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/access.ts": ['import { type SQLQuery, sql } from "bun";'],
  "packages/chat/src/service/attachments.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/badge.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/channels.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/channels.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/chat/src/service/conversations.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/discussions.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/for-you.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/index.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/item-events.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/live-channels.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/live-channels.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/maintenance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/maintenance.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/mentions.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/message-mutations.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/messages.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/notification-delivery.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/chat/src/service/notification-delivery.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/service/notification-preferences.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/personal.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/reactions.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/read-state.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/resource-access.test.ts": ['import { redis } from "bun";'],
  "packages/chat/src/service/resource-access.ts": ['import { redis } from "bun";'],
  "packages/chat/src/service/search.ts": ['import { type SQLQuery, sql } from "bun";'],
  "packages/chat/src/service/shared.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/system-chats.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/system-notification-access.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/chat/src/service/thread-follows.ts": ['import { sql } from "bun";'],
  "packages/chat/src/service/threads.ts": ['import { sql } from "bun";'],
  "packages/cloud/scripts/sync-recovery-smoke.ts": [
    'const servers = env.NATS_SERVERS.length ? env.NATS_SERVERS : ["nats://127.0.0.1:4222"];',
    'const servers = env.NATS_SERVERS.length ? env.NATS_SERVERS : ["nats://127.0.0.1:4222"];',
    "const sync = createSync({ connection, namespace, application: APPLICATION, defaults: { replicas: env.SYNC_REPLICAS } });",
  ],
  "packages/cloud/src/workflows/store/actions.ts": [
    'if (error instanceof SQL.PostgresError && (error.errno === "40001" || error.errno === "40P01"))',
  ],
  "packages/contacts/src/api/access-last-manager.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/birthday.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/book-permission.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/export.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/api/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/capability-retention.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/cli.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/access.ts": ['import { type SQL, sql } from "bun";'],
  "packages/contacts/src/service/address-location.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/address-location.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/authorization.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/books.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/books.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/contact-lookup.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/contacts.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/favorites.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/imports.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/notes.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/notes.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/public-resources.test.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/contacts/src/service/tags.ts": ['import { sql } from "bun";'],
  "packages/core/bench/identity-search.ts": [
    'import { RedisClient, redis, SQL, sql } from "bun";',
    'import { RedisClient, redis, SQL, sql } from "bun";',
  ],
  "packages/core/bench/provider-fixture.ts": ['import { redis } from "bun";'],
  "packages/core/scripts/repair-jsonb-containers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/scripts/repair-jsonb-containers.ts": [
    "} else if (!process.env.DATABASE_URL) {",
    "const db = new SQL(process.env.DATABASE_URL);",
    "const db = new SQL(process.env.DATABASE_URL);",
  ],
  "packages/core/scripts/sync-dev-smoke.ts": [
    'import { sql } from "bun";',
    'const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");',
  ],
  "packages/core/src/ai-chat-task-routes.app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/ai-cost-notifications.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/ai-notifications.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/ai-notifications.ts": ['import { sql } from "bun";'],
  "packages/core/src/ai-openai-api.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/api/identity-invocation.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/api/identity-oauth-device-approval.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/api/identity-oauth-device-approval.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/api/identity-oauth-issuance.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/api/identity-oauth-issuance.ts": ['import { sql } from "bun";'],
  "packages/core/src/app-approval-runtime.ts": ['import { sql } from "bun";'],
  "packages/core/src/app-events.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/app-keys.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/core/src/app-workload.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/announcements.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/app-approval.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/app-bootstrap.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/app-events.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/app-keys.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/audit.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/auth.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/avatar-migration.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/device-trust.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/device-trust.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/events.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/extensions.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/geoip.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/jsonb-metadata.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/jsonb-metadata.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/logging-metadata.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/logging-metadata.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/logging.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/notifications.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/notifications.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/outgoing-mail.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/outgoing-mail.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/panel-context-consent.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/personal-group-history.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/personal-group-history.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/posix.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/pwa.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/pwa.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/rail-preferences.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/rail-shortcuts.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/service-account-group-managers.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/service-account-groups.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/migrate/core/settings.cache.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/core/src/migrate/core/settings.ts": ['import { sql } from "bun";'],
  "packages/core/src/migrate/core/workflows.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/notifications.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/src/outgoing-mail-bounces/poller.integration.test.ts": ['import { sql } from "bun";'],
  "packages/core/test/migrations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/dashboard/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/dashboard/src/service/settings.integration.test.ts": ['import { sql } from "bun";'],
  "packages/dashboard/src/service/settings.ts": ['import { sql } from "bun";'],
  "packages/faq/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/faq/src/service/index.integration.test.ts": ['import { sql } from "bun";'],
  "packages/faq/src/service/index.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/activity-transports.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/activity-migration.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/activity-observations-migration.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/activity-observations.ts": ['import { type SQL, sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/data/activity-reader.test.ts": ['import { type ReservedSQL, SQL, sql } from "bun";'],
  "packages/filesv2/src/data/activity-reader.ts": [
    'import { type ReservedSQL, type SQL, sql } from "bun";',
    "const control = new Bun.SQL({ ...sql.options, max: 1 });",
  ],
  "packages/filesv2/src/data/activity-recovery.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/activity.ts": ['import { type SQL, sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/data/bases.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/home-provisioning.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/machine-storage.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/marks.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/operations.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/data/references.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/share-access-migration.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/share-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/share-access.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/shares.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/shares.ts": ['import { type SQL, sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/data/sharing-migration.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/templates.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/data/trash.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/data/uploads.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/file-capabilities.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/migrate-trash.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/public-rate-limit.integration.test.ts": ['import { redis } from "bun";'],
  "packages/filesv2/src/service/activity-export.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/filesv2/src/service/activity-export.ts": [
    'import { SQL, sql } from "bun";',
    "const control = new SQL({ ...database.options, max: 1 });",
  ],
  "packages/filesv2/src/service/activity-observations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/activity-reader-filegate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/activity-reader.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/activity.ts": ['import { deepEquals, sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/service/admin-history-read.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/admin-read-activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/configuration-audit.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/filesv2/src/service/configuration.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/filesv2/src/service/configuration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/filesv2/src/service/configuration.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/service/files.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/home-provisioning.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/index.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/lifecycle-activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/lifecycle.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/machine-access.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "packages/filesv2/src/service/machine-access.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/share-activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/sharing.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/sharing.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/service/template-audit.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/templates.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/filesv2/src/service/trash-activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/src/service/version-activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/test/activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/test/filegate-lifecycle.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/test/filegate-stable-refs.integration.test.ts": ['import { sql } from "bun";'],
  "packages/filesv2/test/integration-preload.ts": ['import { sql } from "bun";'],
  "packages/filesv2/test/private-database.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/ai-live-health.integration.test.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/ai-live-health.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/grids-operational-health.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/health-webhooks.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/migrate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/observability/data/service.ts": ['import { sql } from "bun";', "const redis = Bun.redis;"],
  "packages/gateway-ops/src/observability/nats/settings.integration.test.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/observability/telemetry/service.integration.test.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/observability/telemetry/service.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/registered-apps.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/telemetry.integration.test.ts": ['import { sql } from "bun";'],
  "packages/gateway-ops/src/telemetry.ts": ['import { sql } from "bun";'],
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
  "packages/grids/src/service/workflow-machine-authority.ts": [
    'import { SQL, sql } from "bun";',
    'if (error instanceof SQL.PostgresError && error.errno === "55P03")',
  ],
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
  "packages/ipa-hosts/src/backend/provider.ts": ['import { sql } from "bun";'],
  "packages/ipa-hosts/src/backend/sync.ts": ['import { sql } from "bun";'],
  "packages/ipa-hosts/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/notebooks/scripts/snapshot-cutover-preflight.ts": [
    "const namespace = process.env.SYNC_NAMESPACE?.trim();",
    'const servers = process.env.NATS_SERVERS?.split(",")',
    "const databaseUrl = process.env.DATABASE_URL;",
    "const credsFile = process.env.NATS_CREDS_FILE;",
    "const caFile = process.env.NATS_TLS_CA_FILE;",
    'ignoreClusterUpdates: process.env.NATS_IGNORE_CLUSTER_UPDATES === "true",',
    "const database = new SQL(databaseUrl);",
  ],
  "packages/notebooks/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/image-metadata.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/live-note-edit.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/note-delete-permission.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/note-pdf.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/oauth-scope.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/api/version-restore.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/app-events.ts": ['import { type SQL, sql } from "bun";'],
  "packages/notebooks/src/capabilities.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/cli.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/frontend/[id]/graph-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/frontend/[id]/large-notebook-sidebar.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/lib/short-id.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/resource-readers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/access-managers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/access.ts": ['import { type SQL, sql } from "bun";'],
  "packages/notebooks/src/service/activity-query.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/activity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/activity.ts": ['import { type SQL, sql } from "bun";'],
  "packages/notebooks/src/service/annotation-count.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/annotations.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/notebooks/src/service/annotations.ts": [
    'import { SQL, sql, type TransactionSQL } from "bun";',
    'if (error instanceof SQL.PostgresError && error.errno === "55P03") return conflict(words(context).busy, { retryable: true });',
  ],
  "packages/notebooks/src/service/app-events.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/attachments.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/backup.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/backup.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/book-order.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/book-references.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/comments.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/favorites.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/graph-around.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/graph.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/large-notebook-fixture.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/large-notebook-query.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/large-notebook-server.integration.test.ts": ['import { type SQL, sql, type TransactionSQL } from "bun";'],
  "packages/notebooks/src/service/large-notebook.test-fixture.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/links.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/maps.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-order.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-paths.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-pdf-images.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-properties.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-properties.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-query.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-query.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-refs.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/note-titles.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/notebook-overview-stats.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/notebook-presentation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/notebooks.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/notes.ts": ['import { sql, type TransactionSQL } from "bun";'],
  "packages/notebooks/src/service/script-removal.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/notebooks/src/service/search.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/search.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/shared-text-edit.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/stable-paging.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/table-actions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/tags.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/tree-levels.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/workspace-events.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/yjs-legacy-migration.ts": ['import { sql } from "bun";'],
  "packages/notebooks/src/service/yjs-shared-log.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/notebooks/src/service/yjs-snapshot-projections.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/notebooks/src/service/yjs-snapshot.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/notebooks/test/app-events-preload.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/api/admin-oauth.integration.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/authority-review.integration.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/consent-browser.integration.test.ts": ['import { type Server, sql } from "bun";'],
  "packages/oauth/src/device-grant.integration.test.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/oauth/src/frontend/consent-action.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/lasting-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/oauth.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/clients.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/codes.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/consent.ts": ['import { redis } from "bun";'],
  "packages/oauth/src/service/device.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/oauth/src/service/personal-groups.integration.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/refresh-tokens.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/sign-in.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/tokens.test.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/service/tokens.ts": ['import { sql } from "bun";'],
  "packages/oauth/src/verification/regressions.ts": [
    'import { sql } from "bun";',
    'assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/cloud_oauth_verify_regressions");',
    'assert.equal(new URL(process.env.DATABASE_URL!).hostname, "127.0.0.1");',
  ],
  "packages/oauth/src/verification/upgrade.ts": [
    'import { sql } from "bun";',
    "assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\\/cloud_oauth_verify_[a-z0-9_]+$/);",
  ],
  "packages/oauth/test/verification/server.ts": ['import { redis, sql } from "bun";', 'import { redis, sql } from "bun";'],
  "packages/proxy-auth/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/proxy-auth/src/service/index.test.ts": ['import { sql } from "bun";'],
  "packages/proxy-auth/src/service/index.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/admin-store.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/app-access-ingest.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/api/website-traffic.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/capabilities-agent-actions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/capabilities-sql.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/capabilities.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/frontend/[baseId]/page-data.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/migrate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/access-control.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/access-control.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/alert-evaluator.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/alert-evaluator.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/alert-rules.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/alert-rules.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/alert-runtime.sync.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-access-manager.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-admin.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-admin.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-lifecycle.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/pulse/src/service/base-lifecycle.sync.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-lifecycle.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-maintenance-runtime.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-management.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-notifications.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-policy.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/base-store.test-fixture.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/ingest-controls.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/pulse/src/service/ingest-controls.test-fixture.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/ingest-identity.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/pulse/src/service/ingest-quota.ts": [
    "client ??= new RedisClient(url ?? connections().valkey.url, { enableOfflineQueue: false, connectionTimeout: 1000 });",
  ],
  "packages/pulse/src/service/ingest-writer.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/internal-targets.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/metric-cardinality.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/metric-cardinality.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/metric-rollups.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/metric-rollups.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/metrics-scraper.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/pulse/src/service/metrics-scraper.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/overview-queries.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/overview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/overview.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/owned-ingest.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/retention.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/pulse/src/service/retention.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/runtime.sync.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/runtime.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/saved-queries.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/saved-queries.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/scrape-target.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/source-counts.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/source-freshness.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/source-management.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/source-mirror.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/source-mirror.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/sql-admission.ts": [
    "client ??= new RedisClient(options.url ?? connections().valkey.url, { enableOfflineQueue: false, connectionTimeout: 1000 });",
  ],
  "packages/pulse/src/service/sql-service.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/state-transitions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/state-transitions.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/store-health.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/service/write.test-fixture.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/base-status.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/base-store.test-fixture.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/base-store.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/maintenance.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/read-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/retention.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/service.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/sql-helpers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/pulse/src/store/sql-run.integration.test.ts": ['import { sql } from "bun";'],
  "packages/quotes/src/service/index.ts": ['import { redis } from "bun";'],
  "packages/spaces/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/attachments.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/calendar-tray.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/deadlines.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/image-metadata.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/item-move.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/item-templates.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/reactions.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/virtual-columns.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/api/widgets.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/capabilities.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/cli.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/lib/short-id.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/migrate-assignees.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/pwa/routes.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/resource-readers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/access-managers.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/access.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/access.ts": ['import { type SQL, sql } from "bun";'],
  "packages/spaces/src/service/activity-query.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/activity-recording.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/activity.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/agent-assignees.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/app-events.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/assignee-presentation.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/assignees.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/calendar-invitations.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/calendar-invitations.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/calendar-source-pages.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/calendar-source.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/calendar-source.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/claim-assignment.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/columns.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/comments.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/comments.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/group-eligibility.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/ical.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-attachments.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-checklist.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-checklist.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-dependencies.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-dependencies.ts": ['import { type SQL, sql } from "bun";'],
  "packages/spaces/src/service/item-links.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-links.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-move.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-resource-references.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/item-templates.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/items-completion.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/items-filter.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/items-inactivity.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/items-update.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/items.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/link-previews.ts": ['import { redis } from "bun";'],
  "packages/spaces/src/service/live.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/overview.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/overview.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/public-resources.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/reactions.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/spaces.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/tags.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/task-work.integration.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/task-work.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/wormholes.test.ts": ['import { sql } from "bun";'],
  "packages/spaces/src/service/wormholes.ts": ['import { sql } from "bun";'],
  "packages/spaces/test/app-events-preload.ts": ['import { sql } from "bun";'],
  "packages/tools/src/migrate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/tools/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/tools/src/service/webhooks.integration.test.ts": ['import { sql } from "bun";'],
  "packages/tools/src/service/webhooks.ts": ['import { sql } from "bun";'],
  "packages/venue/src/access-manager.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/admin-setup.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/api/agent-access.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/api/app-session.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/api/image-metadata.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/api/oauth-scope.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/capabilities.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/clarity.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/lib/short-id.ts": ['import { type SQL, sql } from "bun";'],
  "packages/venue/src/migrate.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/migrate.ts": ['import { sql } from "bun";'],
  "packages/venue/src/one-off-shifts.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/public-ids.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/public-page-view.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/public-page.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/service.ts": ['import { sql } from "bun";'],
  "packages/venue/src/service/public-resources.ts": ['import { sql } from "bun";'],
  "packages/venue/src/shift-detail.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/shift-notices.integration.test.ts": ['import { sql } from "bun";'],
  "packages/venue/src/shift-notices.ts": ['import { sql } from "bun";'],
  "packages/venue/src/visibility.integration.test.ts": ['import { sql } from "bun";'],
  "packages/weather/src/api/settings.test.ts": ['import { SQL, sql } from "bun";'],
  "packages/weather/src/api/settings.ts": ['import { sql } from "bun";'],
  "pwas/notes/server/start.ts": [
    'if (!env.DATABASE_URL) throw new Error("database_url_missing");',
    "const db = new SQL(env.DATABASE_URL);",
    "const db = new SQL(env.DATABASE_URL);",
  ],
  "pwas/pwa-auth/server/push.ts": ['import { type SQL, sql } from "bun";'],
  "pwas/pwa-auth/server/start.ts": [
    'import { sql } from "bun";',
    'if (!env.DATABASE_URL) throw new Error("Push needs DATABASE_URL (Postgres).");',
    'if (env.NATS_SERVERS.length === 0) throw new Error("Push needs NATS_SERVERS (NATS JetStream).");',
    'if (!env.SYNC_NAMESPACE.trim()) throw new Error("Push needs SYNC_NAMESPACE, e.g. cloud-login.");',
    "servers: env.NATS_SERVERS,",
    "ignoreClusterUpdates: env.NATS_IGNORE_CLUSTER_UPDATES,",
    "...(env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(env.NATS_CREDS_FILE)) } : {}),",
    "...(env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(env.NATS_CREDS_FILE)) } : {}),",
    "...(env.NATS_TLS_CA_FILE ? { tls: { caFile: env.NATS_TLS_CA_FILE } } : {}),",
    "...(env.NATS_TLS_CA_FILE ? { tls: { caFile: env.NATS_TLS_CA_FILE } } : {}),",
    "namespace: env.SYNC_NAMESPACE,",
    "defaults: { replicas: env.SYNC_REPLICAS },",
  ],
  "pwas/pwa-auth/test/server.ts": ['import { sql } from "bun";'],
  "scripts/fixtures/admin-oauth.ts": ['import { sql } from "bun";'],
  "scripts/fixtures/integration-migrations.ts": ['import { sql } from "bun";'],
  "scripts/fixtures/lock-order.ts": ['import { sql } from "bun";'],
  "scripts/fixtures/no-transform.ts": ['import { redis } from "bun";'],
  "scripts/fixtures/test-infra.ts": ['import { S3Client, SQL, sql } from "bun";'],
  "scripts/prod-upgrade-preflight.ts": ["const namespace = process.env.SYNC_NAMESPACE?.trim();"],
  "scripts/scale-acceptance.ts": [
    "database = new SQL(`postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/${env.POSTGRES_DB}`, {",
  ],
  "tests/app-access-auth-protocols.integration.test.ts": ['import { sql } from "bun";'],
  "tests/app-access-issuance-pool.integration.test.ts": ['import { SQL, sql } from "bun";'],
  "tests/app-access-skills-mount.integration.test.ts": ['import { sql } from "bun";'],
  "tests/app-pwa-gateway.integration.test.ts": ['import { sql } from "bun";'],
  "tests/integration/identity/admin-credential-matrix.integration.test.ts": [
    'import { redis, sql } from "bun";',
    'import { redis, sql } from "bun";',
  ],
  "tests/integration/identity/identity-issuance-pool.integration.test.ts": [
    "await bun.sql.close({ timeout: 5 });",
    "const [waiting] = await bun.sql<{ count: number }[]>`",
  ],
  "tests/integration/identity/identity-keyring.integration.test.ts": ['import { sql } from "bun";'],
  "tests/integration/identity/mandate-capability-policy.integration.test.ts": ['import { sql } from "bun";'],
  "tests/integration/test-infra-redis-binding.integration.test.ts": ['import { RedisClient, redis } from "bun";'],
  "packages/core/src/migrate/core/known-apps.ts": ['import { type SQL, sql } from "bun";'],
  "packages/core/src/app-domains.integration.test.ts": ['import { sql as nativeSql } from "bun";'],
  "packages/gateway/src/handler.ts": ['import { redis } from "bun";'],
  "packages/gateway/src/runtime.ts": ['import { sql } from "bun";'],
  "pwas/notes/server/sync-crash.worker.ts": ["const db = new SQL(requireDatabaseUrl());"],
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
const fixtureFiles = new Set(["packages/cloud/scripts/platform-start.test-fixture.ts", "pwas/pwa-auth/test/server.ts"]);
const fixture = (file: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /^(?:scripts\/fixtures\/|tests\/|packages\/[^/]+\/(?:test|bench)\/)/.test(file) ||
  fixtureFiles.has(file);
const resolver = "packages/cloud/src/runtime/resolve-connections.ts";

export const checkSource = (file: string, source: string): Finding[] => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const namespaces = new Set(["Bun"]);
  const constructors = new Set(["SQL", "RedisClient"]);
  const importedConstructors = new Set<string>();
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
    if (ts.isExportSpecifier(parent))
      return node === (parent.propertyName ?? parent.name) && !parent.isTypeOnly && !parent.parent.parent.isTypeOnly;
    return ts.isShorthandPropertyAssignment(parent) || !("name" in parent && parent.name === node);
  };
  const nativeAllowed = fixture(file) || file.startsWith("packages/cloud/src/runtime/");
  const envAllowed = fixture(file) || file === resolver;
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
    if (!envAllowed && property && delivered.has(property.name) && isEnv(property.object) && !isWrite(node)) report(node, envMessage);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      if (isEnv(node.initializer) && !envAllowed)
        for (const item of node.name.elements) {
          const name = bindingKey(item);
          if (name && delivered.has(name)) report(item, envMessage);
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
