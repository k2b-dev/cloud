import { dates } from "@k2b/stdlib";
import {
  DataTable,
  type DataTableColumn,
  MarkdownView,
  NoticeCard,
  Pagination,
  Paper,
  Placeholder,
  StatCell,
  StatGrid,
  StatusBadge,
  type StatusTone,
} from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import {
  accounts,
  accountsAppService as accountsService,
  type NotificationBatch,
  type NotificationBatchRecipient,
  type NotificationBatchRecipientStatus,
  notificationBatches,
} from "@valentinkolb/cloud/services";
import { formatNumber } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import { z } from "zod";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import NotificationBatchActions from "./NotificationBatchActions.island";
import NotificationRecipientActions from "./NotificationRecipientActions.island";
import NotificationRecipientStatusFilters from "./NotificationRecipientStatusFilters.island";

const MAX_PAGE = 10_000;
const AUDIENCE_PREVIEW_LIMIT = 50;

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1;
};

const validRecipientStatus = (value: string | undefined): NotificationBatchRecipientStatus | undefined => {
  if (value === "pending" || value === "sending" || value === "sent" || value === "skipped" || value === "error") return value;
  return undefined;
};

const statusTone = (status: NotificationBatch["status"] | NotificationBatchRecipient["status"]): StatusTone => {
  if (status === "completed" || status === "sent") return "ok";
  if (status === "completed_with_errors" || status === "failed" || status === "error") return "error";
  if (status === "running" || status === "ready" || status === "pending" || status === "sending") return "running";
  return "neutral";
};

type LegacyAudienceSelection = {
  mode?: "specific" | "rules" | string;
  rules?: string[];
  all?: boolean;
  includeGroupMembers?: boolean;
  accountManagers?: { mode?: "none" | "all" | "groups"; groupIds?: string[] };
  providers?: ("local" | "ipa")[];
  profiles?: ("user" | "guest")[];
};

const hasLegacyRuleAudience = (selection: LegacyAudienceSelection): boolean => {
  const managerMode = selection.accountManagers?.mode;
  return (
    (selection.mode !== undefined && selection.mode !== "specific") ||
    Boolean(selection.rules?.length) ||
    selection.all === true ||
    selection.includeGroupMembers === false ||
    (managerMode !== undefined && managerMode !== "none") ||
    Boolean(selection.accountManagers?.groupIds?.length) ||
    Boolean(selection.providers?.length) ||
    Boolean(selection.profiles?.length)
  );
};

const recipientBaseUrl = (batchId: string, status?: string) => {
  const query = new URLSearchParams();
  if (status) query.set("recipient_status", status);
  const search = query.toString();
  return search ? `/app/accounts/notifications/${batchId}?${search}&page=` : `/app/accounts/notifications/${batchId}?page=`;
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const statusLabel = (status: NotificationBatch["status"] | NotificationBatchRecipient["status"]) =>
    ({
      draft: t.draft,
      ready: t.ready,
      running: t.running,
      completed: t.completed,
      completed_with_errors: t.withErrors,
      failed: t.failed,
      cancelled: t.cancelled,
      pending: t.pending,
      sending: t.sending,
      sent: t.sent,
      skipped: t.skipped,
      error: t.error,
    })[status];
  const ruleLabels: Record<string, { label: string; icon: string }> = {
    account_manager: { label: t.accountManagers, icon: "ti ti-shield-check" },
    local: { label: t.localAccounts, icon: "ti ti-device-desktop" },
    ipa: { label: t.freeIpaAccounts, icon: "ti ti-server" },
    guest: { label: t.guests, icon: "ti ti-user-question" },
    user: { label: t.fullUsers, icon: "ti ti-user" },
  };
  const user = expectUserBackedActor(c);
  const batchId = c.req.param("id");
  if (!batchId || !z.uuid().safeParse(batchId).success) return ssr.error(c, 404);
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const recipientStatus = validRecipientStatus(c.req.query("recipient_status"));

  const [pendingRequestsPage, batch] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    notificationBatches.get(batchId),
  ]);

  if (!batch) {
    return ssr.error(c, 404);
  }

  const recipientsPage =
    batch.status === "draft"
      ? { items: [] as NotificationBatchRecipient[], total: 0 }
      : await notificationBatches.listRecipients({ batchId, page, perPage, status: recipientStatus });
  const totalPages = Math.max(1, Math.ceil(recipientsPage.total / perPage));
  const storedSelection = batch.selection as NotificationBatch["selection"] & LegacyAudienceSelection;
  const isLegacyRuleAudience = hasLegacyRuleAudience(storedSelection);
  const selectionUserIds = storedSelection.userIds ?? [];
  const selectionGroupIds = storedSelection.groupIds ?? [];
  const activeSelection = { userIds: selectionUserIds, groupIds: selectionGroupIds };
  const previewSelectionUserIds = selectionUserIds.slice(0, AUDIENCE_PREVIEW_LIMIT);
  const previewSelectionGroupIds = selectionGroupIds.slice(0, AUDIENCE_PREVIEW_LIMIT);
  const [selectionUsers, selectionGroups] = await Promise.all([
    previewSelectionUserIds.length > 0
      ? accounts.users
          .list({ ids: previewSelectionUserIds, perPage: Math.max(previewSelectionUserIds.length, 1) })
          .then((result) => result.users)
      : [],
    previewSelectionGroupIds.length > 0
      ? accounts.groups
          .list({ ids: previewSelectionGroupIds, perPage: Math.max(previewSelectionGroupIds.length, 1) })
          .then((result) => result.groups)
      : [],
  ]);
  const selectionRules = storedSelection.rules ?? [];
  const legacySources = [
    storedSelection.all ? { label: t.allUsers, icon: "ti ti-users" } : null,
    storedSelection.accountManagers?.mode === "all" ? { label: t.allAccountManagers, icon: "ti ti-shield-check" } : null,
    storedSelection.providers?.includes("local") ? { label: t.localAccounts, icon: "ti ti-device-desktop" } : null,
    storedSelection.providers?.includes("ipa") ? { label: t.freeIpaAccounts, icon: "ti ti-server" } : null,
    storedSelection.profiles?.includes("guest") ? { label: t.guests, icon: "ti ti-user-question" } : null,
    storedSelection.profiles?.includes("user") ? { label: t.fullUsers, icon: "ti ti-user" } : null,
  ].filter((entry): entry is { label: string; icon: string } => Boolean(entry));
  const legacyFallbackSource =
    selectionGroupIds.length > 0
      ? { label: t.allUsersInSelectedGroups, icon: "ti ti-users-group" }
      : { label: t.allAccounts, icon: "ti ti-users" };

  const columns: DataTableColumn<NotificationBatchRecipient>[] = [
    { id: "user", header: t.user, value: (entry) => entry.displayName || entry.uid, cellClass: "min-w-[14rem]" },
    { id: "recipient", header: t.email, value: (entry) => entry.recipient, cellClass: "max-w-[18rem]" },
    { id: "provider", header: t.provider, value: (entry) => entry.provider },
    { id: "profile", header: t.profile, value: (entry) => entry.profile },
    { id: "status", header: t.status, value: (entry) => entry.status },
    { id: "attempts", header: t.attempts, value: (entry) => entry.attemptCount },
    { id: "sent", header: t.sent, value: (entry) => entry.sentAt, cellClass: "whitespace-nowrap" },
    { id: "actions", header: "", value: () => "", cellClass: "w-0 whitespace-nowrap text-right" },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.notifications, href: "/app/accounts/notifications" },
        { title: batch.subject },
      ]}
    >
      <AccountsWorkspace
        active="notifications"
        isAdmin
        pendingRequests={pendingRequestsPage.total}
        scrollPreserveKey="accounts-notification-detail"
      >
        <div class="flex flex-col gap-2">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <h1 class="truncate text-base font-semibold text-primary">{batch.subject}</h1>
              <p class="mt-1 text-xs text-dimmed">{t.createdLabel({ value: dates.formatDateTime(batch.createdAt, { locale }) })}</p>
            </div>
            <NotificationBatchActions
              batchId={batch.id}
              status={batch.status}
              selection={activeSelection}
              selectionHash={batch.selectionHash}
              errorCount={batch.errorCount}
              finalizeDisabledReason={isLegacyRuleAudience && batch.status === "draft" ? t.legacyDraftBlocked : undefined}
            />
          </div>

          <StatGrid columns={5}>
            <StatCell label={t.status} value={<StatusBadge tone={statusTone(batch.status)} label={<> {statusLabel(batch.status)} </>} />} />
            <StatCell label={t.matched} value={formatNumber(batch.targetCount, { locale })} />
            <StatCell
              label={t.deliverable}
              value={formatNumber(batch.deliverableCount, { locale })}
              sub={t.skippedCount({ count: formatNumber(batch.skippedCount, { locale }) })}
            />
            <StatCell label={t.sent} value={formatNumber(batch.sentCount, { locale })} />
            <StatCell
              label={t.errors}
              value={formatNumber(batch.errorCount, { locale })}
              accent={batch.errorCount > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
            />
          </StatGrid>

          <Paper class="p-4">
            <div class="flex items-start gap-2">
              <i class={isLegacyRuleAudience ? "ti ti-filter" : "ti ti-user-plus"} />
              <div class="min-w-0 flex-1">
                <h2 class="text-sm font-semibold text-primary">{t.audience}</h2>
                <p class="mt-1 text-xs text-dimmed">{isLegacyRuleAudience ? t.legacyAudienceDescription : t.explicitAudienceDescription}</p>
                {isLegacyRuleAudience && batch.status === "draft" ? (
                  <NoticeCard tone="warning" icon={false} class="mt-2">
                    {t.legacyDraftBlocked}
                  </NoticeCard>
                ) : null}
              </div>
            </div>

            <div class="mt-2 grid gap-2 lg:grid-cols-2">
              <div>
                <p class="text-xs font-semibold text-dimmed">{isLegacyRuleAudience ? t.legacyFilters : t.users}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  {!isLegacyRuleAudience ? (
                    selectionUsers.length > 0 ? (
                      <>
                        {selectionUsers.map((user) => (
                          <span class="chip max-w-full" title={user.uid}>
                            <AccountAvatar
                              name={user.displayName || user.uid}
                              userId={user.id}
                              avatarHash={user.avatarHash}
                              size="xs"
                              class="h-5 w-5"
                            />
                            <span class="truncate">{user.displayName || user.uid}</span>
                          </span>
                        ))}
                        {selectionUserIds.length > previewSelectionUserIds.length ? (
                          <span class="chip max-w-full">
                            <i class="ti ti-dots" />
                            <span>
                              {t.moreCount({ count: formatNumber(selectionUserIds.length - previewSelectionUserIds.length, { locale }) })}
                            </span>
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span class="text-xs text-dimmed">{t.noSelectedUsers}</span>
                    )
                  ) : selectionRules.length > 0 ? (
                    selectionRules.map((rule) => {
                      const item = ruleLabels[rule] ?? { label: rule, icon: "ti ti-filter" };
                      return (
                        <span class="chip max-w-full">
                          <i class={item.icon} />
                          <span class="truncate">{item.label}</span>
                        </span>
                      );
                    })
                  ) : legacySources.length > 0 ? (
                    legacySources.map((source) => (
                      <span class="chip max-w-full">
                        <i class={source.icon} />
                        <span class="truncate">{source.label}</span>
                      </span>
                    ))
                  ) : (
                    <span class="chip max-w-full">
                      <i class={legacyFallbackSource.icon} />
                      <span class="truncate">{legacyFallbackSource.label}</span>
                    </span>
                  )}
                </div>
              </div>

              <div>
                <p class="text-xs font-semibold text-dimmed">{t.groups}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  {selectionGroups.length > 0 ? (
                    <>
                      {selectionGroups.map((group) => (
                        <span class="chip max-w-full" title={group.name}>
                          <i class="ti ti-users-group" />
                          <span class="truncate">{group.name}</span>
                        </span>
                      ))}
                      {selectionGroupIds.length > previewSelectionGroupIds.length ? (
                        <span class="chip max-w-full">
                          <i class="ti ti-dots" />
                          <span>
                            {t.moreCount({ count: formatNumber(selectionGroupIds.length - previewSelectionGroupIds.length, { locale }) })}
                          </span>
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span class="text-xs text-dimmed">{t.noSelectedGroups}</span>
                  )}
                </div>
              </div>
            </div>
          </Paper>

          <Paper class="p-4">
            <h2 class="text-sm font-semibold text-primary">{t.messagePreview}</h2>
            <div class="mt-2">
              <MarkdownView trustedHtml={batch.bodyHtml} headingScale="compact" />
            </div>
          </Paper>

          <div class="flex flex-col gap-2">
            <div class="flex items-end gap-2">
              <div class="min-w-0 flex-1">
                <h2 class="text-sm font-semibold text-primary">{t.recipients}</h2>
                <p class="mt-1 text-xs text-dimmed">
                  {batch.status === "draft"
                    ? t.recipientsSnapshotted
                    : t.recipientCount({ count: formatNumber(recipientsPage.total, { locale }) })}
                </p>
              </div>
            </div>
            {batch.status !== "draft" ? <NotificationRecipientStatusFilters batchId={batch.id} status={recipientStatus ?? ""} /> : null}

            {batch.status === "draft" ? (
              <Placeholder
                surface="paper"
                description={<>{isLegacyRuleAudience ? t.createNewNotificationBatch : t.finalizeDraftForRecipients}</>}
              />
            ) : recipientsPage.items.length === 0 ? (
              <Placeholder surface="paper" description={<>{t.noRecipients}</>} />
            ) : (
              <Paper class="overflow-hidden">
                <DataTable
                  rows={recipientsPage.items}
                  columns={columns}
                  getRowId={(entry) => entry.userId}
                  hoverRows
                  class="overflow-x-auto"
                  scrollPreserveKey="accounts-notification-recipients"
                  renderCell={({ row: entry, col }) => {
                    if (col.id === "user") {
                      return (
                        <a
                          href={`/app/accounts/users/${entry.userId}`}
                          class="flex min-w-0 items-center gap-2 text-primary hover:underline"
                        >
                          <AccountAvatar
                            name={entry.displayName || entry.uid}
                            userId={entry.userId}
                            avatarHash={entry.avatarHash}
                            size="xs"
                          />
                          <span class="min-w-0 flex-1">
                            <span class="block truncate font-medium">{entry.displayName || entry.uid}</span>
                            <span class="block truncate text-xs text-dimmed">{entry.uid}</span>
                          </span>
                        </a>
                      );
                    }
                    if (col.id === "recipient") return <span class="block truncate text-dimmed">{entry.recipient ?? "-"}</span>;
                    if (col.id === "provider") return <span class="text-dimmed">{entry.provider}</span>;
                    if (col.id === "profile") return <span class="text-dimmed">{entry.profile}</span>;
                    if (col.id === "status")
                      return <StatusBadge tone={statusTone(entry.status)} label={<> {statusLabel(entry.status)} </>} />;
                    if (col.id === "attempts") return <span class="text-dimmed">{formatNumber(entry.attemptCount, { locale })}</span>;
                    if (col.id === "sent")
                      return <span class="text-dimmed">{entry.sentAt ? dates.formatDateTime(entry.sentAt, { locale }) : "-"}</span>;
                    if (col.id === "actions")
                      return (
                        <NotificationRecipientActions batchId={batch.id} userId={entry.userId} status={entry.status} error={entry.error} />
                      );
                    return "";
                  }}
                />
              </Paper>
            )}

            {batch.status !== "draft" ? (
              <div class="pt-1">
                <Pagination currentPage={page} totalPages={totalPages} baseUrl={recipientBaseUrl(batch.id, recipientStatus)} />
              </div>
            ) : null}
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
