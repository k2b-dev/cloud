import { sql } from "bun";
import { accountCategory } from "../../contracts/account-categories";
import type {
  BaseGroup,
  BaseUser,
  EntityKind,
  EntityListItem,
  GroupMember,
  MutationResult,
  User,
  UserProfile,
  UserProvider,
} from "../../contracts/shared";
import {
  err,
  fail,
  ok,
  type PageParams,
  type Paginated,
  paginate,
  paginateItems,
  type Result,
  type ServiceError,
} from "../../server/services";
import { renderAccountActionNotice } from "../../shared/account-action-notice";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { accountLifecycle } from "../account-lifecycle";
import { lifecycleJobs } from "../account-lifecycle/scheduler";
import { type AuditActor, type AuditTarget, audit } from "../audit";
import { getFreeIpaConfig } from "../freeipa-config";
import { type LogEntry, logger, logging } from "../logging";
import { isUniqueViolation } from "../postgres";
import { providers } from "../providers";
import { get as getSetting } from "../settings";
import { type AccountsActor, canMutateManagedGroup, hasOnlySelfUpdateFields, isAdminActor, isSelfTarget } from "./authz";
import { listDuplicateEmails } from "./duplicate-emails";
import * as entities from "./entities";
import * as groups from "./groups";
import type { AccountsNotificationSender } from "./notification-sender";
import { accountRequestsEnabled } from "./request-policy";
import * as users from "./users";

type CreateUserInput =
  | {
      provider: "ipa";
      email: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification?: boolean;
      requestId?: string;
    }
  | {
      provider: "local";
      profile: UserProfile;
      admin?: boolean;
      email: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification?: boolean;
      requestId?: string;
    };

type DbRow = Record<string, unknown>;
type MutationErrorStatus = Extract<MutationResult, { ok: false }>["status"];
type CreateUserResult = {
  id: string;
  uid: string;
  accountExpires: string | null;
  notificationSent: boolean;
  creationNotice?: { markdown: string | null; failed: boolean };
};

export type AccountRequestStatus = "pending" | "completed" | "denied";
export type AccountRequestScope = "open" | "processed" | "all";

export type AccountRequest = {
  id: string;
  userId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  phone: string | null;
  comment: string | null;
  status: AccountRequestStatus;
  createdAt: string;
};

export type AccountsDashboardSummary = {
  ipaAccountsTotal: number;
  localAccountsTotal: number;
  localUserAccountsTotal: number;
  localGuestAccountsTotal: number;
  groupsTotal: number;
  ipaGroupsTotal: number;
  localGroupsTotal: number;
  openRequests: number;
  ipaExpiring30d: number;
  localUserExpiring30d: number;
  localGuestExpiring30d: number;
  overdueLocalGuests: number;
  reminderErrors: number;
  deletedLast7d: number;
  runHealthWindow: number;
  recentSyncRuns: number;
  recentSyncRunsWithFailures: number;
  recentDemotionRuns: number;
  recentDemotionRunsWithFailures: number;
  recentReminderRuns: number;
  recentReminderRunsWithFailures: number;
  lastSync: {
    createdAt: string;
    users: number;
    groups: number;
  } | null;
};

const ACTIVITY_SOURCES = [
  "auth:ipa:sync",
  "auth:ipa:backfill",
  "auth:local-user:backfill",
  "auth:guest:backfill",
  "auth:reminder:daily",
  "auth:guest:cleanup",
  "auth:lifecycle:scheduler",
] as const;

const toServiceError = (status: MutationErrorStatus, message: string): ServiceError => {
  if (status === 400) return err.badInput(message);
  if (status === 401) return err.unauthenticated(message);
  if (status === 403) return err.forbidden(message);
  if (status === 404) return { code: "NOT_FOUND", message, status };
  if (status === 409) return { code: "CONFLICT", message, status };
  return err.internal(message);
};

const fromMutationResult = <T>(result: MutationResult<T>): Result<T> => {
  if (result.ok) return ok(result.data);
  return fail(toServiceError(result.status, result.error));
};

const mapAccountRequestRow = (row: DbRow): AccountRequest => ({
  id: row.id as string,
  userId: row.user_id as string | null,
  email: (row.email as string) ?? "",
  firstName: (row.first_name as string) ?? "",
  lastName: (row.last_name as string) ?? "",
  displayName: (row.display_name as string) ?? null,
  phone: (row.phone as string) ?? null,
  comment: row.comment as string | null,
  status: row.status as AccountRequestStatus,
  createdAt: (row.created_at as Date).toISOString(),
});

const mapSummary = (row: DbRow): AccountsDashboardSummary => {
  const lastSyncCreatedAt = row.last_sync_created_at as Date | null;

  return {
    ipaAccountsTotal: Number(row.ipa_accounts_total ?? 0),
    localAccountsTotal: Number(row.local_accounts_total ?? 0),
    localUserAccountsTotal: Number(row.local_user_accounts_total ?? 0),
    localGuestAccountsTotal: Number(row.local_guest_accounts_total ?? 0),
    groupsTotal: Number(row.groups_total ?? 0),
    ipaGroupsTotal: Number(row.ipa_groups_total ?? 0),
    localGroupsTotal: Number(row.local_groups_total ?? 0),
    openRequests: Number(row.open_requests ?? 0),
    ipaExpiring30d: Number(row.ipa_expiring_30d ?? 0),
    localUserExpiring30d: Number(row.local_user_expiring_30d ?? 0),
    localGuestExpiring30d: Number(row.local_guest_expiring_30d ?? 0),
    overdueLocalGuests: Number(row.overdue_local_guests ?? 0),
    reminderErrors: Number(row.reminder_errors ?? 0),
    deletedLast7d: Number(row.deleted_last_7d ?? 0),
    runHealthWindow: Number(row.run_health_window ?? 10),
    recentSyncRuns: Number(row.recent_sync_runs ?? 0),
    recentSyncRunsWithFailures: Number(row.recent_sync_runs_with_failures ?? 0),
    recentDemotionRuns: Number(row.recent_demotion_runs ?? 0),
    recentDemotionRunsWithFailures: Number(row.recent_demotion_runs_with_failures ?? 0),
    recentReminderRuns: Number(row.recent_reminder_runs ?? 0),
    recentReminderRunsWithFailures: Number(row.recent_reminder_runs_with_failures ?? 0),
    lastSync: lastSyncCreatedAt
      ? {
          createdAt: lastSyncCreatedAt.toISOString(),
          users: Number(row.last_sync_users ?? 0),
          groups: Number(row.last_sync_groups ?? 0),
        }
      : null,
  };
};

const appLog = logger("accounts:app");

const auditActor = (actor: AccountsActor | null | undefined): AuditActor | null =>
  actor
    ? {
        userId: actor.userId,
        uid: actor.uid,
        provider: actor.provider,
        roles: actor.roles,
      }
    : null;

const userTarget = (user: { id?: string | null; uid?: string | null; provider?: string | null } | null | undefined): AuditTarget => ({
  type: "user",
  id: user?.id ?? null,
  label: user?.uid ?? null,
  provider: user?.provider ?? null,
});

const groupTarget = (group: { id?: string | null; name?: string | null; provider?: string | null } | null | undefined): AuditTarget => ({
  type: "group",
  id: group?.id ?? null,
  label: group?.name ?? null,
  provider: group?.provider ?? null,
});

const recordCompletedMutation = <T>(params: {
  action: string;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  metadata?: Record<string, unknown> | null;
  result: Result<T>;
}) => (params.result.ok ? audit.recordResultAfterSideEffect(params) : audit.recordResult(params));

const requireAdminActor = async <T>(params: {
  actor: AccountsActor | null | undefined;
  action: string;
  target?: AuditTarget;
}): Promise<Result<T> | null> => {
  if (isAdminActor(params.actor)) return null;
  return audit.deny<T>({
    action: params.action,
    actor: auditActor(params.actor),
    target: params.target,
    message: "Admin access required",
  });
};

const requireDifferentActor = async <T>(params: {
  actor: AccountsActor | null | undefined;
  targetUserId: string;
  action: string;
  message: string;
  target?: AuditTarget;
}): Promise<Result<T> | null> => {
  if (!isSelfTarget({ actor: params.actor, targetUserId: params.targetUserId })) return null;
  return audit.deny<T>({
    action: params.action,
    actor: auditActor(params.actor),
    target: params.target,
    message: params.message,
  });
};

const authorizeGroupMutation = async <T>(params: {
  actor: AccountsActor | null | undefined;
  group: BaseGroup;
  action: string;
}): Promise<Result<T> | null> => {
  if (canMutateManagedGroup({ actor: params.actor, groupId: params.group.id, managedGroupIds: [] })) return null;
  if (!params.actor) {
    return audit.deny<T>({
      action: params.action,
      target: groupTarget(params.group),
      message: "Access denied",
    });
  }
  const managedGroupIds = await users.getManagedGroupIds({ id: params.actor.userId, recursive: true });
  if (canMutateManagedGroup({ actor: params.actor, groupId: params.group.id, managedGroupIds })) return null;
  return audit.deny<T>({
    action: params.action,
    actor: auditActor(params.actor),
    target: groupTarget(params.group),
    message: "Access denied",
  });
};

const buildAccountRequestWhereClause = (config: {
  access: { userId: string; isAdmin: boolean };
  filter?: { status?: AccountRequestStatus; scope?: AccountRequestScope };
}) => {
  if (!config.access.isAdmin) {
    return sql`r.user_id = ${config.access.userId}::uuid AND r.status = 'pending'`;
  }

  if (config.filter?.status) {
    return sql`r.status = ${config.filter.status}`;
  }

  const scope = config.filter?.scope ?? "open";
  if (scope === "processed") return sql`r.status IN ('completed', 'denied')`;
  if (scope === "all") return sql`TRUE`;
  return sql`r.status = 'pending'`;
};

export const accountsAppService = {
  user: {
    listDuplicateEmails,
    list: async (config: {
      pagination?: PageParams;
      filter?: { search?: string };
      scope?: { ids?: string[]; uids?: string[]; provider?: UserProvider; profile?: UserProfile };
    }): Promise<Paginated<BaseUser>> => {
      const { page, perPage } = paginate(config.pagination);
      const result = await users.list({
        page,
        perPage,
        search: config.filter?.search,
        ids: config.scope?.ids,
        uids: config.scope?.uids,
        provider: config.scope?.provider,
        profile: config.scope?.profile,
      });

      return {
        items: result.users,
        page,
        perPage,
        total: result.total,
        hasNext: result.pagination.has_next,
      };
    },
    get: async (config: { id: string } | { uid: string }): Promise<User | null> => users.get(config),
    getMinimal: async (config: { id: string } | { uid: string }) => users.getMinimal(config),
    getAvatar: async (config: { id: string }) => users.getAvatar(config),
    setAvatar: async (config: { actor: AccountsActor; id: string; dataUrl: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const selfService = config.actor.userId === config.id;
      if (!selfService) {
        const adminError = await requireAdminActor<{ avatarHash: string }>({
          actor: config.actor,
          action: "accounts.user.avatar.update",
          target: targetInfo,
        });
        if (adminError) return adminError;
      }
      const result = fromMutationResult(await users.setAvatar({ id: config.id, dataUrl: config.dataUrl }));
      return recordCompletedMutation({
        action: "accounts.user.avatar.update",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { selfService, avatarHash: result.ok ? result.data.avatarHash : null },
        result,
      });
    },
    clearAvatar: async (config: { actor: AccountsActor; id: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const selfService = config.actor.userId === config.id;
      if (!selfService) {
        const adminError = await requireAdminActor<void>({
          actor: config.actor,
          action: "accounts.user.avatar.clear",
          target: targetInfo,
        });
        if (adminError) return adminError;
      }
      const result = fromMutationResult(await users.clearAvatar({ id: config.id }));
      return recordCompletedMutation({
        action: "accounts.user.avatar.clear",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { selfService },
        result,
      });
    },
    group: {
      list: async (config: {
        userId: string;
        recursive?: boolean;
        pagination?: PageParams;
        filter?: { query?: string };
      }): Promise<Paginated<string>> => {
        const userGroups = await users.getGroups({
          id: config.userId,
          recursive: config.recursive,
        });
        const query = config.filter?.query?.trim().toLowerCase();
        const filtered = query ? userGroups.filter((groupName) => groupName.toLowerCase().includes(query)) : userGroups;
        return paginateItems(filtered, config.pagination);
      },
    },
    groupId: {
      list: async (config: { userId: string; recursive?: boolean }): Promise<string[]> =>
        users.getGroupIds({
          id: config.userId,
          recursive: config.recursive,
        }),
    },
    managedGroup: {
      list: async (config: {
        userId: string;
        recursive?: boolean;
        pagination?: PageParams;
        filter?: { query?: string };
      }): Promise<Paginated<string>> => {
        const managedGroups = await users.getManagedGroups({
          id: config.userId,
          recursive: config.recursive,
        });
        const query = config.filter?.query?.trim().toLowerCase();
        const filtered = query ? managedGroups.filter((groupName) => groupName.toLowerCase().includes(query)) : managedGroups;
        return paginateItems(filtered, config.pagination);
      },
    },
    managedGroupId: {
      /**
       * Use this for authorization checks — names are only unique per provider,
       * so comparing names across providers can grant incorrect access.
       */
      list: async (config: { userId: string; recursive?: boolean }): Promise<string[]> =>
        users.getManagedGroupIds({
          id: config.userId,
          recursive: config.recursive,
        }),
    },
    create: async (config: {
      actor: AccountsActor;
      data: CreateUserInput;
      processedBy: string;
      notificationSender: AccountsNotificationSender;
      locale?: string;
    }): Promise<Result<CreateUserResult>> => {
      const adminError = await requireAdminActor<{ id: string; uid: string; accountExpires: string | null; notificationSent: boolean }>({
        actor: config.actor,
        action: "accounts.user.create",
        target: { type: "user", label: config.data.email, provider: config.data.provider },
      });
      if (adminError) return adminError;
      let requestCompletionFailed = false;
      const createFromRequest = async () => {
        const txResult = await sql.begin(async (tx) => {
          const requestRows: DbRow[] = await tx`
            SELECT r.id
            FROM auth.account_requests r
            JOIN auth.users u ON u.id = r.user_id
            WHERE r.id = ${config.data.requestId}
              AND r.status = 'pending'
              AND lower(u.mail) = lower(${config.data.email})
            LIMIT 1
            FOR UPDATE OF r
          `;
          if (requestRows.length === 0) {
            return {
              completed: false,
              result: fail(err.badInput("Account request not found, already processed, or not owned by the target email.")),
            };
          }

          const result = fromMutationResult(
            await users.create({
              actor: auditActor(config.actor) ?? undefined,
              data: {
                ...config.data,
                profile: config.data.provider === "ipa" ? "user" : config.data.profile,
                admin: config.data.provider === "local" ? config.data.admin : undefined,
              },
            }),
          );
          if (!result.ok) return { completed: false, result };

          const completedRows: DbRow[] = await tx`
            UPDATE auth.account_requests
            SET status = 'completed', processed_at = now(), processed_by = ${config.processedBy}
            WHERE id = ${config.data.requestId}
              AND user_id = ${result.data.user.id}::uuid
              AND status = 'pending'
            RETURNING id
          `;

          return { completed: completedRows.length > 0, result };
        });

        if (txResult.result.ok && !txResult.completed) {
          requestCompletionFailed = true;
          appLog.warn("Account request completion did not match", {
            requestId: config.data.requestId,
            createdUserId: txResult.result.data.user.id,
            processedBy: config.processedBy,
          });
          await audit.recordResultAfterSideEffect({
            action: "accounts.request.complete",
            actor: auditActor(config.actor),
            target: { type: "account_request", id: config.data.requestId },
            metadata: { createdUserId: txResult.result.data.user.id, provider: config.data.provider },
            result: fail(err.badInput("Account request not found, already processed, or not owned by the created user")),
          });
        }

        return txResult.result;
      };

      const createResult = config.data.requestId
        ? await createFromRequest()
        : fromMutationResult(
            await users.create({
              actor: auditActor(config.actor) ?? undefined,
              data: {
                ...config.data,
                profile: config.data.provider === "ipa" ? "user" : config.data.profile,
                admin: config.data.provider === "local" ? config.data.admin : undefined,
              },
            }),
          );
      if (!createResult.ok) {
        return audit.recordResult({
          action: "accounts.user.create",
          actor: auditActor(config.actor),
          target: { type: "user", label: config.data.email, provider: config.data.provider },
          metadata: { provider: config.data.provider, requestId: config.data.requestId ?? null },
          result: createResult,
        });
      }

      const created = createResult.data;

      const autoSend = config.data.autoSendNotification ?? true;
      let notificationSent = false;
      if (autoSend && created.user.mail) {
        try {
          const delivery =
            config.data.provider === "ipa" && created.temporaryPassword
              ? await config.notificationSender.sendFreeIpaWelcome({
                  userId: created.user.id,
                  uid: created.user.uid,
                  temporaryPassword: created.temporaryPassword,
                  accountExpires: created.user.accountExpires,
                  locale: config.locale,
                })
              : config.data.provider === "local"
                ? await config.notificationSender.sendLocalWelcome({
                    userId: created.user.id,
                    email: created.user.mail,
                    accountExpires: created.user.accountExpires,
                    locale: config.locale,
                  })
                : null;
          notificationSent = delivery?.status === "delivered" || delivery?.status === "queued";
          if (delivery && !notificationSent) {
            appLog.warn("Account welcome notification was not accepted", {
              userId: created.user.id,
              provider: config.data.provider,
              notificationEventId: delivery.id,
              notificationStatus: delivery.status,
            });
          }
        } catch (error) {
          appLog.error("Account welcome notification failed", {
            userId: created.user.id,
            provider: config.data.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let creationNotice: { markdown: string | null; failed: boolean } = { markdown: null, failed: false };
      try {
        creationNotice.markdown = renderAccountActionNotice(await getSetting<string>("user.action_notice"), {
          action: "user.create",
          id: created.user.id,
          name: created.user.uid,
          uid: created.user.uid,
          email: created.user.mail ?? "",
          firstName: config.data.givenname,
          lastName: config.data.sn,
          provider: created.user.provider,
          profile: created.user.profile,
          category: accountCategory(created.user),
        });
      } catch {
        creationNotice.failed = true;
        appLog.warn("Account created, but administrator notice could not be rendered", { userId: created.user.id });
      }
      return audit.recordResultAfterSideEffect({
        action: "accounts.user.create",
        actor: auditActor(config.actor),
        target: userTarget(created.user),
        metadata: {
          provider: config.data.provider,
          requestId: config.data.requestId ?? null,
          notificationSent,
          requestCompletionFailed,
        },
        result: ok({
          id: created.user.id,
          uid: created.user.uid,
          accountExpires: created.user.accountExpires,
          notificationSent,
          creationNotice,
        }),
      });
    },
    update: async (config: { actor: AccountsActor; id: string; data: Parameters<typeof users.update>[0]["data"] }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const selfService = config.actor.userId === config.id;
      if (selfService && !hasOnlySelfUpdateFields(config.data as Record<string, unknown>)) {
        return audit.recordResult({
          action: "accounts.user.update",
          actor: auditActor(config.actor),
          target: targetInfo,
          metadata: { changedFields: Object.keys(config.data), selfService },
          result: fail(err.forbidden("Only admins can update account management fields.")),
        });
      }
      if (!selfService) {
        const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.user.update", target: targetInfo });
        if (adminError) return adminError;
      }
      const result = fromMutationResult(await users.update(config));
      return recordCompletedMutation({
        action: "accounts.user.update",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { changedFields: Object.keys(config.data), selfService },
        result,
      });
    },
    resetPassword: async (config: { actor: AccountsActor; id: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<{ password: string }>({
        actor: config.actor,
        action: "accounts.user.password_reset",
        target: targetInfo,
      });
      if (adminError) return adminError;
      const selfError = await requireDifferentActor<{ password: string }>({
        actor: config.actor,
        targetUserId: config.id,
        action: "accounts.user.password_reset",
        target: targetInfo,
        message: "You cannot reset your own password from the admin users API.",
      });
      if (selfError) return selfError;
      const result = fromMutationResult(await users.resetPassword(config));
      return recordCompletedMutation({
        action: "accounts.user.password_reset",
        actor: auditActor(config.actor),
        target: targetInfo,
        result: result.ok ? ok({ password: "[REDACTED]" }) : result,
      }).then(() => result);
    },
    setExpiry: async (config: { actor: AccountsActor; id: string; expiryDate: string | null }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.user.set_expiry", target: targetInfo });
      if (adminError) return adminError;
      const result = fromMutationResult(await users.setExpiry(config));
      return recordCompletedMutation({
        action: "accounts.user.set_expiry",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { expiryDate: config.expiryDate },
        result,
      });
    },
    setProfile: async (config: { actor: AccountsActor; id: string; profile: UserProfile }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.user.set_profile", target: targetInfo });
      if (adminError) return adminError;
      const selfError =
        config.profile === "guest"
          ? await requireDifferentActor<void>({
              actor: config.actor,
              targetUserId: config.id,
              action: "accounts.user.set_profile",
              target: targetInfo,
              message: "You cannot demote your own account to guest.",
            })
          : null;
      if (selfError) return selfError;
      const result = fromMutationResult(await users.setProfile({ ...config, actor: auditActor(config.actor) ?? undefined }));
      return recordCompletedMutation({
        action: "accounts.user.set_profile",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { profile: config.profile },
        result,
      });
    },
    setAdmin: async (config: { actor: AccountsActor; id: string; admin: boolean }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.user.set_admin", target: targetInfo });
      if (adminError) return adminError;
      const result = fromMutationResult(await users.setAdmin(config));
      return recordCompletedMutation({
        action: "accounts.user.set_admin",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { admin: config.admin },
        result,
      });
    },
    switchProvider: async (config: { actor: AccountsActor; id: string; provider: UserProvider }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({
        actor: config.actor,
        action: "accounts.user.switch_provider",
        target: targetInfo,
      });
      if (adminError) return adminError;
      const selfError = await requireDifferentActor<void>({
        actor: config.actor,
        targetUserId: config.id,
        action: "accounts.user.switch_provider",
        target: targetInfo,
        message: "You cannot switch your own account provider.",
      });
      if (selfError) return selfError;
      const result = fromMutationResult(await users.switchProvider(config));
      return recordCompletedMutation({
        action: "accounts.user.switch_provider",
        actor: auditActor(config.actor),
        target: targetInfo,
        metadata: { provider: config.provider },
        result,
      });
    },
    demoteToGuest: async (config: { actor: AccountsActor; id: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({
        actor: config.actor,
        action: "accounts.user.demote_to_guest",
        target: targetInfo,
      });
      if (adminError) return adminError;
      const selfError = await requireDifferentActor<void>({
        actor: config.actor,
        targetUserId: config.id,
        action: "accounts.user.demote_to_guest",
        target: targetInfo,
        message: "You cannot demote your own account.",
      });
      if (selfError) return selfError;
      const result = fromMutationResult(await users.demoteToGuest(config));
      return recordCompletedMutation({
        action: "accounts.user.demote_to_guest",
        actor: auditActor(config.actor),
        target: targetInfo,
        result,
      });
    },
    sendLoginLink: async (config: {
      actor: AccountsActor;
      id: string;
      notificationSender: AccountsNotificationSender;
      locale?: string;
    }) => {
      const target = await users.getMinimal({ id: config.id });
      const adminError = await requireAdminActor<void>({
        actor: config.actor,
        action: "accounts.user.send_login_link",
        target: userTarget(target),
      });
      if (adminError) return adminError;
      const result = fromMutationResult(await users.sendLoginLink(config));
      return recordCompletedMutation({
        action: "accounts.user.send_login_link",
        actor: auditActor(config.actor),
        target: userTarget(target),
        result,
      });
    },
    createLoginToken: async (config: { actor: AccountsActor; id: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<{ token: string; magicLink: string; expiresInSeconds: number }>({
        actor: config.actor,
        action: "accounts.user.create_login_token",
        target: targetInfo,
      });
      if (adminError) return adminError;
      const result = fromMutationResult(await users.createLoginToken(config));
      await recordCompletedMutation({
        action: "accounts.user.create_login_token",
        actor: auditActor(config.actor),
        target: targetInfo,
        result: result.ok ? ok({ token: "[REDACTED]", magicLink: "[REDACTED]", expiresInSeconds: result.data.expiresInSeconds }) : result,
      });
      return result;
    },
    remove: async (config: { actor: AccountsActor; id: string }) => {
      const target = await users.getMinimal({ id: config.id });
      const targetInfo = userTarget(target);
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.user.remove", target: targetInfo });
      if (adminError) return adminError;
      const selfError = await requireDifferentActor<void>({
        actor: config.actor,
        targetUserId: config.id,
        action: "accounts.user.remove",
        target: targetInfo,
        message: "You cannot delete your own account.",
      });
      if (selfError) return selfError;
      const result = fromMutationResult(await users.remove(config));
      return recordCompletedMutation({
        action: "accounts.user.remove",
        actor: auditActor(config.actor),
        target: targetInfo,
        result,
      });
    },

    /**
     * Change an IPA user's own password. Verifies the current password via
     * `providers.ipa.auth.login` and issues the change through the session
     * returned by verification. Keeps this logic inside core — the accounts
     * admin app is UI only and must not dispatch on provider or speak to
     * FreeIPA directly.
     */
    changeOwnPassword: async (config: { user: User; currentPassword: string; newPassword: string }): Promise<Result<void>> => {
      const actor = { userId: config.user.id, uid: config.user.uid, roles: config.user.roles, provider: config.user.provider };
      if (!(await getFreeIpaConfig()).enabled) {
        const result = fail(err.badInput("FreeIPA is disabled."));
        return audit.recordResult({
          action: "accounts.user.change_own_password",
          actor: auditActor(actor),
          target: userTarget(config.user),
          result,
        });
      }
      if (config.user.provider !== "ipa") {
        const result = fail(err.badInput("Password change is only available for IPA accounts."));
        return audit.recordResult({
          action: "accounts.user.change_own_password",
          actor: auditActor(actor),
          target: userTarget(config.user),
          result,
        });
      }

      const verify = await providers.ipa.auth.login(config.user.uid, config.currentPassword);
      if (verify.status !== "success") {
        const result = fail(err.unauthenticated("Current password is incorrect."));
        return audit.recordResult({
          action: "accounts.user.change_own_password",
          actor: auditActor(actor),
          target: userTarget(config.user),
          result,
        });
      }

      const result = await providers.ipa.auth.changePassword({
        ipaSession: verify.session,
        uid: config.user.uid,
        newPassword: config.newPassword,
      });
      const serviceResult = result.ok ? ok(undefined) : fail(toServiceError(result.status, result.error));
      return recordCompletedMutation({
        action: "accounts.user.change_own_password",
        actor: auditActor(actor),
        target: userTarget(config.user),
        result: serviceResult,
      });
    },

    /**
     * Self-delete for the current user. Only guest profiles may self-delete;
     * callers must enforce that before calling. Dispatches to the correct
     * provider internally — callers should not branch on provider themselves.
     */
    removeSelf: async (config: { user: User }): Promise<Result<void>> => {
      const actor = { userId: config.user.id, uid: config.user.uid, roles: config.user.roles, provider: config.user.provider };
      if (config.user.profile !== "guest") {
        const result = fail(err.forbidden("Only guest accounts can be self-deleted."));
        return audit.recordResult({
          action: "accounts.user.remove_self",
          actor: auditActor(actor),
          target: userTarget(config.user),
          result,
        });
      }
      if (config.user.provider === "ipa") {
        const result = fromMutationResult(await users.remove({ id: config.user.id, actor }));
        return recordCompletedMutation({
          action: "accounts.user.remove_self",
          actor: auditActor(actor),
          target: userTarget(config.user),
          result,
        });
      }
      const result = fromMutationResult(await providers.local.users.remove({ id: config.user.id, actor }));
      return recordCompletedMutation({
        action: "accounts.user.remove_self",
        actor: auditActor(actor),
        target: userTarget(config.user),
        result,
      });
    },
  },

  group: {
    list: async (config: {
      pagination?: PageParams;
      filter?: { search?: string };
      scope?: { userId?: string; ids?: string[]; provider?: UserProvider; mode?: "all" | "member" | "managed" };
    }): Promise<Paginated<BaseGroup>> => {
      const { page, perPage } = paginate(config.pagination);
      const result = await groups.list({
        page,
        perPage,
        search: config.filter?.search,
        userId: config.scope?.userId,
        scope: config.scope?.mode,
        ids: config.scope?.ids,
        provider: config.scope?.provider,
      });

      return {
        items: result.groups,
        page,
        perPage,
        total: result.total,
        hasNext: result.pagination.hasNext,
      };
    },
    get: async (config: { id: string }) => groups.get(config),
    member: {
      list: async (config: {
        id: string;
        recursive?: boolean;
        pagination?: PageParams;
        filter?: { query?: string; type?: GroupMember["type"] };
      }): Promise<Paginated<GroupMember>> => {
        const members = await groups.getMembers({
          id: config.id,
          recursive: config.recursive,
        });
        const query = config.filter?.query?.trim().toLowerCase();
        const type = config.filter?.type;
        const filtered = members.filter((member) => {
          if (type && member.type !== type) return false;
          if (!query) return true;
          const id = member.id.toLowerCase();
          const displayName = (member.displayName ?? "").toLowerCase();
          return id.includes(query) || displayName.includes(query);
        });
        return paginateItems(filtered, config.pagination);
      },
      add: async (config: { actor: AccountsActor; id: string; provider?: UserProvider; userId?: string; groupId?: string }) => {
        const group = await groups.get({ id: config.id });
        if (!group) {
          const result = fail(err.notFound("Group not found"));
          return audit.recordResult({
            action: "accounts.group.member.add",
            actor: auditActor(config.actor),
            target: { type: "group", id: config.id },
            result,
          });
        }
        const accessError = await authorizeGroupMutation<void>({ actor: config.actor, group, action: "accounts.group.member.add" });
        if (accessError) return accessError;
        const result = fromMutationResult(
          await groups.addMember({
            id: config.id,
            provider: config.provider,
            user: config.userId,
            group: config.groupId,
          }),
        );
        return recordCompletedMutation({
          action: "accounts.group.member.add",
          actor: auditActor(config.actor),
          target: groupTarget(group),
          metadata: { userId: config.userId ?? null, groupId: config.groupId ?? null },
          result,
        });
      },
      remove: async (config: { actor: AccountsActor; id: string; provider?: UserProvider; userId?: string; groupId?: string }) => {
        const group = await groups.get({ id: config.id });
        if (!group) {
          const result = fail(err.notFound("Group not found"));
          return audit.recordResult({
            action: "accounts.group.member.remove",
            actor: auditActor(config.actor),
            target: { type: "group", id: config.id },
            result,
          });
        }
        const accessError = await authorizeGroupMutation<void>({ actor: config.actor, group, action: "accounts.group.member.remove" });
        if (accessError) return accessError;
        const result = fromMutationResult(
          await groups.removeMember({
            id: config.id,
            provider: config.provider,
            user: config.userId,
            group: config.groupId,
          }),
        );
        return recordCompletedMutation({
          action: "accounts.group.member.remove",
          actor: auditActor(config.actor),
          target: groupTarget(group),
          metadata: { userId: config.userId ?? null, groupId: config.groupId ?? null },
          result,
        });
      },
    },
    manager: {
      list: async (config: {
        id: string;
        pagination?: PageParams;
        filter?: { query?: string; type?: GroupMember["type"] };
      }): Promise<Paginated<GroupMember>> => {
        const managers = await groups.getManagers({ id: config.id });
        const query = config.filter?.query?.trim().toLowerCase();
        const type = config.filter?.type;
        const filtered = managers.filter((manager) => {
          if (type && manager.type !== type) return false;
          if (!query) return true;
          const id = manager.id.toLowerCase();
          const displayName = (manager.displayName ?? "").toLowerCase();
          return id.includes(query) || displayName.includes(query);
        });
        return paginateItems(filtered, config.pagination);
      },
      add: async (config: { actor: AccountsActor; id: string; provider?: UserProvider; userId?: string; groupId?: string }) => {
        const group = await groups.get({ id: config.id });
        if (!group) {
          const result = fail(err.notFound("Group not found"));
          return audit.recordResult({
            action: "accounts.group.manager.add",
            actor: auditActor(config.actor),
            target: { type: "group", id: config.id },
            result,
          });
        }
        const accessError = await requireAdminActor<void>({
          actor: config.actor,
          action: "accounts.group.manager.add",
          target: groupTarget(group),
        });
        if (accessError) return accessError;
        const result = fromMutationResult(
          await groups.addManager({
            id: config.id,
            provider: config.provider,
            user: config.userId,
            group: config.groupId,
          }),
        );
        return recordCompletedMutation({
          action: "accounts.group.manager.add",
          actor: auditActor(config.actor),
          target: groupTarget(group),
          metadata: { userId: config.userId ?? null, groupId: config.groupId ?? null },
          result,
        });
      },
      remove: async (config: { actor: AccountsActor; id: string; provider?: UserProvider; userId?: string; groupId?: string }) => {
        const group = await groups.get({ id: config.id });
        if (!group) {
          const result = fail(err.notFound("Group not found"));
          return audit.recordResult({
            action: "accounts.group.manager.remove",
            actor: auditActor(config.actor),
            target: { type: "group", id: config.id },
            result,
          });
        }
        const accessError = await requireAdminActor<void>({
          actor: config.actor,
          action: "accounts.group.manager.remove",
          target: groupTarget(group),
        });
        if (accessError) return accessError;
        const result = fromMutationResult(
          await groups.removeManager({
            id: config.id,
            provider: config.provider,
            user: config.userId,
            group: config.groupId,
          }),
        );
        return recordCompletedMutation({
          action: "accounts.group.manager.remove",
          actor: auditActor(config.actor),
          target: groupTarget(group),
          metadata: { userId: config.userId ?? null, groupId: config.groupId ?? null },
          result,
        });
      },
    },
    parent: {
      list: async (config: {
        id: string;
        recursive?: boolean;
        pagination?: PageParams;
        filter?: { query?: string };
      }): Promise<Paginated<string>> => {
        const parentGroups = await groups.getParents({
          id: config.id,
          recursive: config.recursive,
        });
        const query = config.filter?.query?.trim().toLowerCase();
        const filtered = query ? parentGroups.filter((groupId) => groupId.toLowerCase().includes(query)) : parentGroups;
        return paginateItems(filtered, config.pagination);
      },
    },
    managedGroup: {
      list: async (config: { id: string; pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<string>> => {
        const managedGroups = await groups.getManagedGroups({ id: config.id });
        const query = config.filter?.query?.trim().toLowerCase();
        const filtered = query ? managedGroups.filter((groupId) => groupId.toLowerCase().includes(query)) : managedGroups;
        return paginateItems(filtered, config.pagination);
      },
    },
    create: async (config: { actor: AccountsActor; provider: UserProvider; name: string; description?: string; posix?: boolean }) => {
      const adminError = await requireAdminActor<BaseGroup>({
        actor: config.actor,
        action: "accounts.group.create",
        target: { type: "group", label: config.name, provider: config.provider },
      });
      if (adminError) return adminError;
      const result = fromMutationResult(await groups.create(config));
      return recordCompletedMutation({
        action: "accounts.group.create",
        actor: auditActor(config.actor),
        target: result.ok ? groupTarget(result.data) : { type: "group", label: config.name, provider: config.provider },
        metadata: { posix: config.posix ?? false },
        result,
      });
    },
    update: async (config: { actor: AccountsActor; id: string; provider?: UserProvider; description: string }) => {
      const group = await groups.get({ id: config.id });
      const target = groupTarget(group ?? { id: config.id, name: null, provider: config.provider ?? null });
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.group.update", target });
      if (adminError) return adminError;
      const result = fromMutationResult(await groups.update(config));
      return recordCompletedMutation({
        action: "accounts.group.update",
        actor: auditActor(config.actor),
        target,
        metadata: { changedFields: ["description"] },
        result,
      });
    },
    remove: async (config: { actor: AccountsActor; id: string; provider?: UserProvider }) => {
      const group = await groups.get({ id: config.id });
      const target = groupTarget(group ?? { id: config.id, name: null, provider: config.provider ?? null });
      const adminError = await requireAdminActor<void>({ actor: config.actor, action: "accounts.group.remove", target });
      if (adminError) return adminError;
      const result = fromMutationResult(await groups.remove(config));
      return recordCompletedMutation({
        action: "accounts.group.remove",
        actor: auditActor(config.actor),
        target,
        result,
      });
    },
    makePosix: async (config: { actor: AccountsActor; id: string; provider?: UserProvider }) => {
      const group = await groups.get({ id: config.id });
      const target = groupTarget(group ?? { id: config.id, name: null, provider: config.provider ?? null });
      const adminError = await requireAdminActor<{ gidnumber: number | null }>({
        actor: config.actor,
        action: "accounts.group.make_posix",
        target,
      });
      if (adminError) return adminError;
      const result = fromMutationResult(await groups.makePosix(config));
      return recordCompletedMutation({
        action: "accounts.group.make_posix",
        actor: auditActor(config.actor),
        target,
        result,
      });
    },
  },
  entity: {
    list: async (config: {
      actor: AccountsActor;
      pagination?: PageParams;
      search?: string;
      kinds?: EntityKind[];
      provider?: UserProvider;
      profile?: UserProfile;
      userIds?: string[];
      groupIds?: string[];
      excludeUserIds?: string[];
      excludeGroupIds?: string[];
      excludeServiceAccountIds?: string[];
      userMemberOfGroupIds?: string[];
      memberOfGroupId?: string;
      managerOfGroupId?: string;
      parentGroupId?: string;
      managedByUserId?: string;
      recursive?: boolean;
    }): Promise<Paginated<EntityListItem>> => {
      const canSearchDirectory = config.actor.roles.includes("user");
      const usesRelationFilter = Boolean(
        config.userMemberOfGroupIds?.length ||
          config.memberOfGroupId ||
          config.managerOfGroupId ||
          config.parentGroupId ||
          config.managedByUserId,
      );
      if (!canSearchDirectory && usesRelationFilter) {
        throw new Error("Guest accounts cannot use entity relation filters");
      }
      const { page, perPage } = paginate(config.pagination);
      const result = await entities.list({
        visibility: canSearchDirectory ? { type: "directory" } : { type: "self_and_effective_groups", userId: config.actor.userId },
        search: config.search,
        kinds: config.kinds,
        provider: config.provider,
        profile: config.profile,
        userIds: config.userIds,
        groupIds: config.groupIds,
        excludeUserIds: config.excludeUserIds,
        excludeGroupIds: config.excludeGroupIds,
        excludeServiceAccountIds: config.excludeServiceAccountIds,
        userMemberOfGroupIds: config.userMemberOfGroupIds,
        memberOfGroupId: config.memberOfGroupId,
        managerOfGroupId: config.managerOfGroupId,
        parentGroupId: config.parentGroupId,
        managedByUserId: config.managedByUserId,
        recursive: config.recursive,
        page,
        perPage,
      });

      return {
        items: result.items,
        page,
        perPage,
        total: result.total,
        hasNext: result.pagination.hasNext,
      };
    },
  },

  accountRequest: {
    isEnabled: accountRequestsEnabled,
    list: async (config: {
      access: { userId: string; isAdmin: boolean };
      pagination?: PageParams;
      filter?: { status?: AccountRequestStatus; scope?: AccountRequestScope };
    }): Promise<Paginated<AccountRequest>> => {
      const { page, perPage, offset } = paginate(config.pagination);
      const where = buildAccountRequestWhereClause(config);
      const rows = await sql`
        SELECT r.id, r.user_id, u.mail AS email, u.given_name AS first_name, u.sn AS last_name,
               u.display_name, r.phone, r.comment, r.status, r.created_at
        FROM auth.account_requests r
        JOIN auth.users u ON u.id = r.user_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT ${perPage}
        OFFSET ${offset}
      `;

      const totalRows = await sql`
        SELECT COUNT(*)::int AS total
        FROM auth.account_requests r
        WHERE ${where}
      `;

      const total = totalRows[0]?.total ?? 0;
      return {
        items: rows.map(mapAccountRequestRow),
        page,
        perPage,
        total,
        hasNext: page * perPage < total,
      };
    },
    get: async (config: { id: string; access: { userId: string; isAdmin: boolean } }) => {
      const rows: DbRow[] = await sql`
        SELECT r.id, r.user_id, u.mail AS email, u.given_name AS first_name, u.sn AS last_name,
               u.display_name, r.phone, r.comment, r.status, r.created_at
        FROM auth.account_requests r
        JOIN auth.users u ON u.id = r.user_id
        WHERE r.id = ${config.id}
      `;

      if (rows.length === 0) {
        return fail(err.notFound("Request"));
      }

      const request = rows[0]!;
      if (!config.access.isAdmin && request.user_id !== config.access.userId) {
        return fail(err.forbidden("Access denied"));
      }

      return ok(mapAccountRequestRow(request));
    },
    getPendingForUser: async (config: { userId: string }): Promise<{ id: string; createdAt: Date } | null> => {
      const rows: DbRow[] = await sql`
        SELECT id, created_at FROM auth.account_requests
        WHERE user_id = ${config.userId} AND status = 'pending'
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      return {
        id: rows[0]!.id as string,
        createdAt: rows[0]!.created_at as Date,
      };
    },
    create: async (config: {
      user: Pick<User, "id" | "uid" | "mail" | "provider" | "roles">;
      data: { phone?: string; comment?: string; acceptedAgb: true };
    }) => {
      const actor = { userId: config.user.id, uid: config.user.uid, roles: config.user.roles, provider: config.user.provider };
      if (!(await accountRequestsEnabled())) {
        return audit.recordResult({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request" },
          result: fail(err.forbidden("Account requests are disabled")),
        });
      }
      if (!(await getFreeIpaConfig()).enabled || !(await isAccountCategoryAllowed({ provider: "ipa", profile: "user" }))) {
        const result = fail(err.badInput("FreeIPA access is disabled"));
        return audit.recordResult({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request", label: config.user.mail },
          result,
        });
      }
      if (config.user.provider !== "local") {
        const result = fail(err.forbidden("Only local accounts can request IPA-backed access"));
        return audit.recordResult({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request", label: config.user.mail },
          result,
        });
      }
      if (!config.user.mail) {
        const result = fail(err.badInput("Your account has no email address"));
        return audit.recordResult({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request", id: config.user.id },
          result,
        });
      }

      const existingRows: DbRow[] = await sql`
        SELECT id FROM auth.account_requests
        WHERE user_id = ${config.user.id} AND status = 'pending'
      `;
      if (existingRows.length > 0) {
        const result = fail({
          code: "CONFLICT",
          message: "You already have a pending account request",
          status: 409,
        });
        return audit.recordResult({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request", label: config.user.mail },
          result,
        });
      }

      try {
        const rows: DbRow[] = await sql`
          INSERT INTO auth.account_requests (id, user_id, phone, comment, accepted_agb)
          VALUES (gen_random_uuid(), ${config.user.id}, ${config.data.phone ?? null}, ${config.data.comment ?? null}, ${config.data.acceptedAgb})
          RETURNING id
        `;

        const requestId = rows[0]!.id as string;
        const result = ok({
          id: requestId,
          message: "FreeIPA account request submitted",
        });
        return audit.recordResultAfterSideEffect({
          action: "accounts.request.create",
          actor: auditActor(actor),
          target: { type: "account_request", id: requestId, label: config.user.mail },
          metadata: { hasPhone: !!config.data.phone, hasComment: !!config.data.comment },
          result,
        });
      } catch (error) {
        // Belt-and-suspenders: the partial unique index
        // uq_account_requests_one_pending_per_user closes the race between the
        // check above and the insert under concurrent submissions.
        if (isUniqueViolation(error, "uq_account_requests_one_pending_per_user")) {
          const result = fail({
            code: "CONFLICT",
            message: "You already have a pending account request",
            status: 409,
          });
          return audit.recordResult({
            action: "accounts.request.create",
            actor: auditActor(actor),
            target: { type: "account_request", label: config.user.mail },
            result,
          });
        }
        throw error;
      }
    },
    withdraw: async (config: { id: string; actor: AccountsActor }) => {
      const deletedRows: DbRow[] = await sql`
        DELETE FROM auth.account_requests
        WHERE id = ${config.id}
          AND user_id = ${config.actor.userId}::uuid
          AND status = 'pending'
        RETURNING id
      `;

      if (deletedRows.length > 0) {
        return audit.recordResultAfterSideEffect({
          action: "accounts.request.withdraw",
          actor: auditActor(config.actor),
          target: { type: "account_request", id: config.id },
          result: ok(),
        });
      }

      const rows: DbRow[] = await sql`
        SELECT id, user_id, status FROM auth.account_requests WHERE id = ${config.id}
      `;
      if (rows.length === 0) {
        const result = fail(err.notFound("Request"));
        return audit.recordResult({
          action: "accounts.request.withdraw",
          actor: auditActor(config.actor),
          target: { type: "account_request", id: config.id },
          result,
        });
      }
      const request = rows[0]!;
      if (request.user_id !== config.actor.userId) {
        const result = fail(err.forbidden("Access denied"));
        return audit.recordResult({
          action: "accounts.request.withdraw",
          actor: auditActor(config.actor),
          target: { type: "account_request", id: config.id },
          result,
        });
      }
      if (request.status !== "pending") {
        const result = fail(err.forbidden("Only pending requests can be withdrawn"));
        return audit.recordResult({
          action: "accounts.request.withdraw",
          actor: auditActor(config.actor),
          target: { type: "account_request", id: config.id },
          result,
        });
      }
      const result = fail(err.conflict("Account request could not be withdrawn. Please retry."));
      return audit.recordResult({
        action: "accounts.request.withdraw",
        actor: auditActor(config.actor),
        target: { type: "account_request", id: config.id },
        result,
      });
    },
    deny: async (config: {
      id: string;
      reason?: string;
      actor: AccountsActor;
      notificationSender: AccountsNotificationSender;
      locale?: string;
    }) => {
      const adminError = await requireAdminActor<void>({
        actor: config.actor,
        action: "accounts.request.deny",
        target: { type: "account_request", id: config.id },
      });
      if (adminError) return adminError;
      const rows: DbRow[] = await sql`
        UPDATE auth.account_requests r
        SET status = 'denied', denied_reason = ${config.reason ?? null}, processed_at = now(), processed_by = ${config.actor.userId}
        FROM auth.users u
        WHERE r.id = ${config.id}
          AND r.status = 'pending'
          AND u.id = r.user_id
        RETURNING r.id, r.user_id, r.status, u.mail AS email, u.given_name AS first_name
      `;

      if (rows.length === 0) {
        const currentRows: DbRow[] = await sql`
          SELECT id, status FROM auth.account_requests WHERE id = ${config.id}
        `;
        if (currentRows.length === 0) {
          const result = fail(err.notFound("Request"));
          return audit.recordResult({
            action: "accounts.request.deny",
            actor: auditActor(config.actor),
            target: { type: "account_request", id: config.id },
            result,
          });
        }
        const result = fail(err.badInput("Only pending requests can be denied"));
        return audit.recordResult({
          action: "accounts.request.deny",
          actor: auditActor(config.actor),
          target: { type: "account_request", id: config.id },
          result,
        });
      }

      const request = rows[0]!;

      let notificationStatus: string | null = null;
      if (config.reason) {
        try {
          const delivery = await config.notificationSender.sendRequestDenied({
            requestId: config.id,
            userId: request.user_id as string,
            firstName: request.first_name as string,
            reason: config.reason,
            sentBy: config.actor.userId,
            locale: config.locale,
          });
          notificationStatus = delivery.status;
          if (delivery.status === "error" || delivery.status === "suppressed") {
            appLog.warn("Account request denial notification was not accepted", {
              requestId: config.id,
              notificationEventId: delivery.id,
              notificationStatus: delivery.status,
            });
          }
        } catch (error) {
          notificationStatus = "error";
          appLog.error("Account request denial notification failed", {
            requestId: config.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return audit.recordResultAfterSideEffect({
        action: "accounts.request.deny",
        actor: auditActor(config.actor),
        target: { type: "account_request", id: config.id, label: request.email as string },
        metadata: { hasReason: !!config.reason, notificationStatus },
        result: ok(),
      });
    },
  },

  dashboard: {
    get: async (): Promise<AccountsDashboardSummary> => {
      const rows = await sql<DbRow[]>`
        WITH latest_sync AS (
          SELECT created_at, metadata
          FROM logging.entries
          WHERE source = 'auth:ipa:sync'
            AND message = 'Sync complete'
          ORDER BY created_at DESC
          LIMIT 1
        ),
        recent_sync_runs AS (
          SELECT message, metadata
          FROM logging.entries
          WHERE source = 'auth:ipa:sync'
            AND message IN ('Sync complete', 'Sync step failed', 'Expired IPA demotion step failed')
          ORDER BY created_at DESC
          LIMIT 10
        ),
        recent_demotion_runs AS (
          SELECT metadata
          FROM logging.entries
          WHERE source = 'auth:ipa:sync'
            AND message = 'Expired IPA demotion complete'
          ORDER BY created_at DESC
          LIMIT 10
        ),
        recent_reminder_runs AS (
          SELECT metadata
          FROM logging.entries
          WHERE source = 'auth:reminder:daily'
            AND message = 'Reminder run complete'
          ORDER BY created_at DESC
          LIMIT 10
        )
        SELECT
          (SELECT COUNT(*)::int FROM auth.users WHERE provider = 'ipa') AS ipa_accounts_total,
          (SELECT COUNT(*)::int FROM auth.users WHERE provider = 'local') AS local_accounts_total,
          (SELECT COUNT(*)::int FROM auth.users WHERE provider = 'local' AND profile = 'user') AS local_user_accounts_total,
          (SELECT COUNT(*)::int FROM auth.users WHERE provider = 'local' AND profile = 'guest') AS local_guest_accounts_total,
          (SELECT COUNT(*)::int FROM auth.groups) AS groups_total,
          (SELECT COUNT(*)::int FROM auth.groups WHERE provider = 'ipa') AS ipa_groups_total,
          (SELECT COUNT(*)::int FROM auth.groups WHERE provider = 'local') AS local_groups_total,
          (SELECT COUNT(*)::int FROM auth.account_requests WHERE status = 'pending') AS open_requests,
          (
            SELECT COUNT(*)::int
            FROM auth.users
            WHERE provider = 'ipa'
              AND account_expires IS NOT NULL
              AND account_expires > now()
              AND account_expires <= now() + interval '30 days'
          ) AS ipa_expiring_30d,
          (
            SELECT COUNT(*)::int
            FROM auth.users
            WHERE provider = 'local'
              AND profile = 'guest'
              AND account_expires IS NOT NULL
              AND account_expires > now()
              AND account_expires <= now() + interval '30 days'
          ) AS local_guest_expiring_30d,
          (
            SELECT COUNT(*)::int
            FROM auth.users
            WHERE provider = 'local'
              AND profile = 'user'
              AND account_expires IS NOT NULL
              AND account_expires > now()
              AND account_expires <= now() + interval '30 days'
          ) AS local_user_expiring_30d,
          (
            SELECT COUNT(*)::int
            FROM auth.users
            WHERE provider = 'local'
              AND profile = 'guest'
              AND account_expires IS NOT NULL
              AND account_expires <= now()
          ) AS overdue_local_guests,
          (SELECT COUNT(*)::int FROM auth.account_lifecycle_reminders WHERE status = 'error') AS reminder_errors,
          (SELECT COUNT(*)::int FROM auth.deleted_accounts WHERE deleted_at >= now() - interval '7 days') AS deleted_last_7d,
          10 AS run_health_window,
          (SELECT COUNT(*)::int FROM recent_sync_runs) AS recent_sync_runs,
          (
            SELECT COUNT(*)::int
            FROM recent_sync_runs
            WHERE message <> 'Sync complete'
          ) AS recent_sync_runs_with_failures,
          (SELECT COUNT(*)::int FROM recent_demotion_runs) AS recent_demotion_runs,
          (
            SELECT COUNT(*)::int
            FROM recent_demotion_runs
            WHERE COALESCE((metadata->>'failed')::int, 0) > 0
          ) AS recent_demotion_runs_with_failures,
          (SELECT COUNT(*)::int FROM recent_reminder_runs) AS recent_reminder_runs,
          (
            SELECT COUNT(*)::int
            FROM recent_reminder_runs
            WHERE COALESCE((metadata->>'failed')::int, 0) > 0
          ) AS recent_reminder_runs_with_failures,
          (SELECT created_at FROM latest_sync) AS last_sync_created_at,
          COALESCE((SELECT COALESCE((metadata->>'activeUsersSynced')::int, (metadata->>'users')::int) FROM latest_sync), 0) AS last_sync_users,
          COALESCE((SELECT COALESCE((metadata->>'groupsSynced')::int, (metadata->>'groups')::int) FROM latest_sync), 0) AS last_sync_groups
      `;
      return mapSummary(rows[0] ?? {});
    },
    activity: async (): Promise<LogEntry[]> => {
      const result = await logging.list({ page: 1, perPage: 15, offset: 0 }, { sources: [...ACTIVITY_SOURCES] });
      return result.entries;
    },
  },

  lifecycle: {
    deletedAccounts: { list: accountLifecycle.listDeletedAccounts },
    reminders: { list: accountLifecycle.listReminderAudit },
  },

  jobs: {
    runIpaBackfill: async (): Promise<string> => lifecycleJobs.submitIpaBackfill(),
    runLocalUserBackfill: async (): Promise<string> => lifecycleJobs.submitLocalUserBackfill(),
    runGuestBackfill: async (): Promise<string> => lifecycleJobs.submitGuestBackfill(),
  },
} as const;

export type AccountsAppService = typeof accountsAppService;
export type AccountsDashboardActivityEntry = LogEntry;
export { ACTIVITY_SOURCES };
