import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import type { Status } from "@k2b/ui/v2";
import { ssr } from "../config";
import { requestContactDirectoryConfig } from "../contact-directory-settings";
import type { PlatformMailboxOperationSummary } from "../contracts";
import { contactDirectory, operations, storageObservability } from "../service";
import { localizeMailError } from "../service/error-messages";
import MailAdminMailboxes, { type MailAdminMailboxRow } from "./_components/v2/MailAdminMailboxes.island";
import { mailAdminSections } from "./admin-sections";
import { mailPageMessages } from "./pages-messages";

const PAGE_SIZE = 50;

const formatBytes = (value: number, locale: string): string => {
  const format = (number: number, maximumFractionDigits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits }).format(number);
  if (value < 1024) return `${format(value, 0)} B`;
  if (value < 1024 * 1024) return `${format(value / 1024, 1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${format(value / (1024 * 1024), 1)} MB`;
  return `${format(value / (1024 * 1024 * 1024), 2)} GB`;
};

/** Cloud administration › Mail › Mailboxes on v2: health, access and storage of every mailbox, without message content. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const authority = auth.getAuthority(c);
  const context = {
    actor: authority.actor,
    accessSubject: authority.accessSubject,
    authority,
    requestId: c.req.header("x-request-id") ?? null,
  };
  const query = (c.req.query("q") ?? "").trim();
  const cursor = c.req.query("cursor") || undefined;
  const [storageResult, operationsResult, contactDirectoryResult] = await Promise.all([
    storageObservability.getMailStorageSummary(context),
    operations.getPlatformMailOperations(context, { q: query || undefined, cursor, limit: PAGE_SIZE }),
    contactDirectory.loadContactDirectoryAdmin(context, requestContactDirectoryConfig(c), locale),
  ]);
  const loadErrors = [
    !operationsResult.ok ? operationsResult.error : null,
    !storageResult.ok ? storageResult.error : null,
    !contactDirectoryResult.ok ? contactDirectoryResult.error : null,
  ].filter((error): error is NonNullable<typeof error> => error !== null);
  if (loadErrors.some((error) => error.code === "FORBIDDEN")) return ssr.error(c, 403);

  const storage = storageResult.ok ? storageResult.data : null;
  const logicalStorage = storage?.mailboxes.reduce((total, mailbox) => total + mailbox.logicalTotalBytes, 0) ?? null;
  const operationsData = operationsResult.ok ? operationsResult.data : null;
  const healthLabel = (health: PlatformMailboxOperationSummary["health"]): string => {
    if (health === "active") return t.healthActive;
    if (health === "paused") return t.healthPaused;
    if (health === "degraded") return t.healthDegraded;
    if (health === "reconnecting") return t.healthReconnecting;
    if (health === "verifying") return t.healthVerifying;
    if (health === "bootstrapping") return t.healthBootstrapping;
    return t.healthUnknown;
  };
  const healthStatus = (health: PlatformMailboxOperationSummary["health"]): Status | undefined => {
    // a mailbox that runs needs nothing: its state stays neutral, colour is for trouble (identity B, rule 7)
    if (health === "active") return undefined;
    if (health === "paused") return undefined;
    if (health === "degraded" || health === "reconnecting" || health === "verifying" || health === "bootstrapping") return "warn";
    return "bad";
  };
  const rows: MailAdminMailboxRow[] = (operationsData?.mailboxes ?? []).map((row) => ({
    id: row.mailboxId,
    name: row.mailboxName,
    health: { label: healthLabel(row.health), status: healthStatus(row.health) },
    sync: row.sync.lastAt
      ? {
          text: dates.formatDateTimeRelative(row.sync.lastAt, dateConfig),
          title: dates.formatDateTime(row.sync.lastAt, dateConfig),
          iso: row.sync.lastAt,
        }
      : null,
    administrators: row.access.administrators,
    people: row.access.total,
    storage: row.storage ? formatBytes(row.storage.logicalTotalBytes, locale) : null,
    attention: row.attentionCount,
  }));

  return () => (
    <AdminLayout c={c} title={t.adminMailboxes} ui="v2">
      <MailAdminMailboxes
        nav={adminNavigation(c, mailAdminSections(locale, "mailboxes"))}
        rows={rows}
        figures={{
          mailboxes: operationsData?.mailboxCount ?? null,
          withoutAdministrator: operationsData?.withoutAdministratorCount ?? null,
          attention: operationsData?.attentionCount ?? null,
          storage:
            logicalStorage === null
              ? null
              : {
                  value: formatBytes(logicalStorage, locale),
                  meta: storage?.calculatedAt
                    ? t.updated({ value: dates.formatDateTimeRelative(storage.calculatedAt, dateConfig) })
                    : t.notReconciled,
                },
        }}
        contactDirectory={contactDirectoryResult.ok ? contactDirectoryResult.data : null}
        failure={loadErrors.length ? [...new Set(loadErrors.map((error) => localizeMailError(error, locale).message))].join(" ") : null}
        query={query}
        nextCursor={operationsData?.nextCursor ?? null}
      />
    </AdminLayout>
  );
});
