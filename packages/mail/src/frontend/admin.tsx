import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, type DataTableColumn, Placeholder, StatCell, StatGrid, StatusBadge, type StatusTone } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../config";
import type { PlatformMailboxOperationSummary } from "../contracts";
import { type MailRequestContext, operations, storageObservability } from "../service";
import { localizeMailError } from "../service/error-messages";
import MailAdminMailboxActions from "./_components/MailAdminMailboxActions.island";
import MailAdminStorageActions from "./_components/MailAdminStorageActions.island";
import { mailPageMessages } from "./pages-messages";

const PAGE_SIZE = 50;

const healthTone = (health: PlatformMailboxOperationSummary["health"]): StatusTone => {
  if (health === "active") return "ok";
  if (health === "paused") return "neutral";
  if (health === "degraded" || health === "reconnecting" || health === "verifying" || health === "bootstrapping") return "warning";
  return "error";
};

const formatBytes = (value: number, locale: string): string => {
  const format = (number: number, maximumFractionDigits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits }).format(number);
  if (value < 1024) return `${format(value, 0)} B`;
  if (value < 1024 * 1024) return `${format(value / 1024, 1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${format(value / (1024 * 1024), 1)} MB`;
  return `${format(value / (1024 * 1024 * 1024), 2)} GB`;
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const query = (c.req.query("q") ?? "").trim();
  const cursor = c.req.query("cursor") || undefined;
  const [storageResult, operationsResult] = await Promise.all([
    storageObservability.getMailStorageSummary(context),
    operations.getPlatformMailOperations(context, {
      q: query || undefined,
      cursor,
      limit: PAGE_SIZE,
    }),
  ]);
  const storage = storageResult.ok ? storageResult.data : null;
  const logicalStorage = storage?.mailboxes.reduce((total, mailbox) => total + mailbox.logicalTotalBytes, 0) ?? null;
  const mailboxes = operationsResult.ok ? operationsResult.data.mailboxes : [];
  const loadErrors = [!operationsResult.ok ? operationsResult.error : null, !storageResult.ok ? storageResult.error : null].filter(
    (error): error is NonNullable<typeof error> => error !== null,
  );
  const accessDenied = loadErrors.some((error) => error.code === "FORBIDDEN");
  if (accessDenied) return ssr.error(c, 403);
  const loadErrorDescription = [...new Set(loadErrors.map((error) => localizeMailError(error, locale).message))].join(" ");
  const columns: DataTableColumn<PlatformMailboxOperationSummary>[] = [
    { id: "mailbox", header: t.adminMailboxes, value: (row) => row.mailboxName },
    { id: "health", header: t.health, value: (row) => row.health },
    { id: "sync", header: t.lastSync, value: (row) => row.sync.lastAt ?? "" },
    { id: "access", header: t.access, value: (row) => row.access.total },
    {
      id: "storage",
      header: t.storage,
      value: (row) => row.storage?.logicalTotalBytes ?? -1,
      headerClass: "text-right",
      cellClass: "text-right",
    },
    {
      id: "attention",
      header: t.attention,
      value: (row) => row.attentionCount,
      headerClass: "text-right",
      cellClass: "text-right",
    },
    { id: "actions", header: t.settings, headerClass: "w-px text-right", cellClass: "text-right" },
  ];

  return () => (
    <AdminLayout c={c} title="Mail">
      <div class="app-rows" data-scroll-preserve="mail-admin">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 class="text-base font-semibold text-primary">{t.adminMailboxes}</h1>
            <p class="text-xs text-dimmed">{t.adminDescription}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <ButtonLink href="/admin/mail/security" variant="secondary" size="sm">
              <i class="ti ti-shield-lock" aria-hidden="true" /> {t.security}
            </ButtonLink>
            <MailAdminStorageActions />
          </div>
        </div>

        {(
          <>
            <StatGrid columns={6}>
              <StatCell
                label={t.adminMailboxes}
                value={operationsResult.ok ? operationsResult.data.mailboxCount : t.unavailable}
                sub={t.active}
                accent={{ tone: "blue", icon: "ti ti-mail" }}
              />
              <StatCell
                label={t.needOwner}
                value={operationsResult.ok ? operationsResult.data.withoutAdministratorCount : t.unavailable}
                sub={t.noAdministrator}
                valueClass={operationsResult.ok && operationsResult.data.withoutAdministratorCount > 0 ? "text-red-500" : "text-primary"}
                accent={
                  operationsResult.ok && operationsResult.data.withoutAdministratorCount > 0
                    ? { tone: "red", icon: "ti ti-user-exclamation" }
                    : undefined
                }
              />
              <StatCell
                label={t.needAttention}
                value={operationsResult.ok ? operationsResult.data.attentionCount : t.unavailable}
                sub={t.failedCommands}
                accent={{ tone: "amber", icon: "ti ti-alert-triangle" }}
              />
              <StatCell
                label={t.logicalStorage}
                value={logicalStorage == null ? t.unavailable : formatBytes(logicalStorage, locale)}
                sub={
                  storage?.calculatedAt
                    ? t.updated({ value: dates.formatDateTimeRelative(storage.calculatedAt, dateConfig) })
                    : t.notReconciled
                }
                accent={{ tone: "zinc", icon: "ti ti-database" }}
              />
              <StatCell
                label={t.mailRelations}
                value={storage ? formatBytes(storage.physicalDatabaseBytes, locale) : t.unavailable}
                sub={t.physicalDatabase}
              />
              <StatCell
                label={t.blobBytes}
                value={storage ? formatBytes(storage.physicalBlobBytes, locale) : t.unavailable}
                sub={t.physicalContentStore}
              />
            </StatGrid>

            {operationsResult.ok ? (
              <section class="paper overflow-hidden">
                <div class="flex flex-col gap-2 px-3 py-3">
                  <div>
                    <h2 class="text-xs font-semibold text-primary">{t.activeMailboxes}</h2>
                    <p class="text-[10px] text-dimmed">
                      {t.mailboxCount({ count: mailboxes.length, total: operationsResult.data.mailboxCount })}
                    </p>
                  </div>
                  <SearchBar
                    action="/admin/mail"
                    value={query}
                    placeholder={t.searchMailboxesPlaceholder}
                    ariaLabel={t.searchMailboxesLabel}
                  />
                </div>
                <DataTable
                  rows={mailboxes}
                  columns={columns}
                  getRowId={(row) => row.mailboxId}
                  hoverRows
                  class="overflow-x-auto"
                  empty={query ? t.noMatchingMailboxes({ query }) : t.noActiveMailboxes}
                  renderCell={({ row, col }) => {
                    if (col.id === "mailbox")
                      return (
                        <div class="flex min-w-52 items-center gap-2">
                          <i class="ti ti-mail text-dimmed" aria-hidden="true" />
                          <div class="min-w-0">
                            <p class="truncate font-medium text-primary">{row.mailboxName}</p>
                            <p class="truncate font-mono text-[10px] text-dimmed">{row.mailboxId}</p>
                          </div>
                        </div>
                      );
                    if (col.id === "health")
                      return (
                        <StatusBadge
                          class="whitespace-nowrap capitalize"
                          tone={healthTone(row.health)}
                          label={
                            row.health === "active"
                              ? t.healthActive
                              : row.health === "paused"
                                ? t.healthPaused
                                : row.health === "degraded"
                                  ? t.healthDegraded
                                  : row.health === "reconnecting"
                                    ? t.healthReconnecting
                                    : row.health === "verifying"
                                      ? t.healthVerifying
                                      : row.health === "bootstrapping"
                                        ? t.healthBootstrapping
                                        : t.healthUnknown
                          }
                        />
                      );
                    if (col.id === "sync")
                      return row.sync.lastAt ? (
                        <time
                          class="whitespace-nowrap text-secondary"
                          dateTime={row.sync.lastAt}
                          title={dates.formatDateTime(row.sync.lastAt, dateConfig)}
                        >
                          {dates.formatDateTimeRelative(row.sync.lastAt, dateConfig)}
                        </time>
                      ) : (
                        <span class="text-dimmed">{t.never}</span>
                      );
                    if (col.id === "access")
                      return (
                        <span
                          class={`whitespace-nowrap text-xs ${row.access.administrators === 0 ? "font-medium text-red-500" : "text-secondary"}`}
                        >
                          {t.accessCounts({ administrators: row.access.administrators, total: row.access.total })}
                        </span>
                      );
                    if (col.id === "storage")
                      return (
                        <span class="tabular-nums text-secondary">
                          {row.storage ? formatBytes(row.storage.logicalTotalBytes, locale) : "—"}
                        </span>
                      );
                    if (col.id === "attention")
                      return (
                        <span
                          class={`tabular-nums ${row.attentionCount > 0 ? "font-medium text-amber-600 dark:text-amber-400" : "text-secondary"}`}
                        >
                          {row.attentionCount}
                        </span>
                      );
                    if (col.id === "actions") return <MailAdminMailboxActions mailboxId={row.mailboxId} mailboxName={row.mailboxName} />;
                    return "";
                  }}
                />
                {operationsResult.data.nextCursor ? (
                  <div class="flex justify-center px-3 py-3">
                    <ButtonLink
                      variant="secondary"
                      size="sm"
                      href={`/admin/mail?${new URLSearchParams({
                        ...(query ? { q: query } : {}),
                        cursor: operationsResult.data.nextCursor,
                      }).toString()}`}
                    >
                      {t.nextPage}
                    </ButtonLink>
                  </div>
                ) : null}
              </section>
            ) : null}

            {loadErrors.length > 0 ? (
              <Placeholder
                state="error"
                variant="compact"
                surface="paper"
                align="left"
                title={t.partialAdminError}
                description={loadErrorDescription}
              />
            ) : null}
          </>
        )}
      </div>
    </AdminLayout>
  );
});
