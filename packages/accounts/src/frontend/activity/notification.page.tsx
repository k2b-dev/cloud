import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import {
  accounts,
  accountsAppService as accountsService,
  type NotificationBatch,
  type NotificationBatchRecipient,
  notificationBatches,
} from "@k2b/cloud/services";
import { formatNumber, groupDisplayName, isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { z } from "zod";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { accountsMessages } from "../messages";
import NotificationScreen from "../notifications/NotificationScreen.island";
import { batchHref, parseListAddress, RECIPIENTS_PER_PAGE, recipientsQuery } from "../notifications/query";

const AUDIENCE_PREVIEW_LIMIT = 50;

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

/** A notification batch's record on v2, beside the activity page (`/app/accounts/activity/notifications/:id`): its recipients with their status in the address, its numbers, audience and message. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = accountsMessages.resolve([locale]);
  // only administrators send notifications, as before; the route says so too, the page does not rely on it
  if (!isAdminUser(expectUserBackedActor(c))) return ssr.error(c, 403);
  const batchId = c.req.param("id");
  if (!batchId || !z.uuid().safeParse(batchId).success) return ssr.error(c, 404);
  const url = new URL(c.req.url);
  const query = recipientsQuery(locale);
  const address = parseListAddress(query, url.searchParams);

  const [pendingRequests, batch] = await Promise.all([accountsService.accountRequest.countPending(), notificationBatches.get(batchId)]);
  if (!batch) return ssr.error(c, 404);

  const recipientsPage =
    batch.status === "draft"
      ? { items: [] as NotificationBatchRecipient[], total: 0 }
      : await notificationBatches
          .listRecipients({ batchId, page: address.page, perPage: RECIPIENTS_PER_PAGE, status: address.state.filters.status })
          .catch(() => null);
  const pages = Math.max(1, Math.ceil((recipientsPage?.total ?? 0) / RECIPIENTS_PER_PAGE));
  if (recipientsPage && address.page > pages) return c.redirect(batchHref(query, batchId, address.state, pages));

  const stored = batch.selection as NotificationBatch["selection"] & LegacyAudienceSelection;
  const legacy = hasLegacyRuleAudience(stored);
  const userIds = stored.userIds ?? [];
  const groupIds = stored.groupIds ?? [];
  const previewUserIds = userIds.slice(0, AUDIENCE_PREVIEW_LIMIT);
  const previewGroupIds = groupIds.slice(0, AUDIENCE_PREVIEW_LIMIT);
  const [users, groups] = await Promise.all([
    previewUserIds.length > 0
      ? accounts.users.list({ ids: previewUserIds, perPage: previewUserIds.length }).then((result) => result.users)
      : [],
    previewGroupIds.length > 0
      ? accounts.groups.list({ ids: previewGroupIds, perPage: previewGroupIds.length }).then((result) => result.groups)
      : [],
  ]);
  const number = (value: number) => formatNumber(value, { locale });
  const ruleLabels: Record<string, { label: string; icon: string }> = {
    account_manager: { label: t.accountManagers, icon: "shield-check" },
    local: { label: t.localAccounts, icon: "device-desktop" },
    ipa: { label: t.freeIpaAccounts, icon: "server" },
    guest: { label: t.guests, icon: "user-question" },
    user: { label: t.fullUsers, icon: "user" },
  };
  const legacySources = [
    stored.all ? { label: t.allUsers, icon: "users" } : null,
    stored.accountManagers?.mode === "all" ? { label: t.allAccountManagers, icon: "shield-check" } : null,
    stored.providers?.includes("local") ? ruleLabels.local! : null,
    stored.providers?.includes("ipa") ? ruleLabels.ipa! : null,
    stored.profiles?.includes("guest") ? ruleLabels.guest! : null,
    stored.profiles?.includes("user") ? ruleLabels.user! : null,
  ].filter((entry): entry is { label: string; icon: string } => Boolean(entry));
  const rules = stored.rules?.length
    ? stored.rules.map((rule) => ruleLabels[rule] ?? { label: rule, icon: "filter" })
    : legacySources.length > 0
      ? legacySources
      : [groupIds.length > 0 ? { label: t.allUsersInSelectedGroups, icon: "users-group" } : { label: t.allAccounts, icon: "users" }];
  // Recipients count bounced mail as sent; the mail's own state keeps that difference visible.
  const mailLabel = (status: NonNullable<NotificationBatchRecipient["outgoingMailStatus"]>) =>
    ({ queued: t.queued, sending: t.sending, sent: t.sent, failed: t.failed, bounced: t.bounced, cancelled: t.cancelled })[status];

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.notifications, href: "/app/accounts/notifications" },
        { title: batch.subject },
      ]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "notifications", pendingRequests, isAdmin: true })} />
      <NotificationScreen
        batch={{
          id: batch.id,
          subject: batch.subject,
          status: batch.status,
          created: dates.formatDateTime(batch.createdAt, { locale, timeZone }),
          matched: number(batch.targetCount),
          deliverable: number(batch.deliverableCount),
          skipped: number(batch.skippedCount),
          sent: number(batch.sentCount),
          errors: number(batch.errorCount),
          errorCount: batch.errorCount,
          selection: { userIds, groupIds },
          selectionHash: batch.selectionHash,
          bodyMarkdown: batch.bodyMarkdown,
        }}
        audience={{
          legacy,
          users: users.map((user) => ({
            id: user.id,
            name: user.displayName || user.uid,
            uid: user.uid,
            image: user.avatarHash
              ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
              : undefined,
          })),
          groups: groups.map((group) => ({ id: group.id, name: groupDisplayName(group.name, locale) })),
          moreUsers: userIds.length > previewUserIds.length ? t.moreCount({ count: number(userIds.length - previewUserIds.length) }) : null,
          moreGroups:
            groupIds.length > previewGroupIds.length ? t.moreCount({ count: number(groupIds.length - previewGroupIds.length) }) : null,
          rules,
        }}
        state={address.state}
        page={address.page}
        pages={pages}
        total={recipientsPage?.total ?? 0}
        recipients={
          recipientsPage?.items.map((entry) => ({
            userId: entry.userId,
            name: entry.displayName || entry.uid,
            image: entry.avatarHash
              ? `/api/accounts/users/${encodeURIComponent(entry.userId)}/avatar?rev=${encodeURIComponent(entry.avatarHash)}`
              : undefined,
            uid: entry.uid,
            email: entry.recipient ?? "–",
            source: `${entry.provider === "ipa" ? "FreeIPA" : t.local} · ${entry.profile === "guest" ? t.guest : t.user}`,
            status: entry.status,
            mail:
              entry.outgoingMailStatus && entry.outgoingMailStatus !== "sent"
                ? {
                    label: t.outgoingMailStatus({ status: mailLabel(entry.outgoingMailStatus) }),
                    bad: ["failed", "bounced", "cancelled"].includes(entry.outgoingMailStatus),
                  }
                : null,
            attempts: entry.attemptCount,
            sent: entry.sentAt ? dates.formatDateTime(entry.sentAt, { locale, timeZone }) : "–",
            error: entry.error,
          })) ?? null
        }
        blocked={legacy && batch.status === "draft" ? t.legacyDraftBlocked : null}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
});
