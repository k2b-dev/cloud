import { err, fail, ok, type PageParams, type Paginated, paginate, tryCatch } from "@k2b/stdlib";
import { notifications } from "@valentinkolb/cloud/services";

type NotificationItem = Awaited<ReturnType<typeof notifications.list>>["notifications"][number];
type NotificationStatus = NotificationItem["status"];

/**
 * Translates notification mutation errors into stable API error variants.
 */
const mapNotificationMutationError = (failure: { code: string; error: string }) =>
  failure.code === "not_found" ? err.notFound("Notification") : err.badInput(failure.error);

/**
 * Translates send-to-user failures into domain-specific API errors.
 */

export const notificationsService = {
  delivery: notifications.observability.deliveries,
  registry: notifications.observability.registry,
  facets: notifications.observability.facets,
  notification: {
    list: async (config: {
      pagination?: PageParams;
      access: { sentBy: string; isAdmin: boolean; search?: string; status?: NotificationStatus };
    }): Promise<Paginated<NotificationItem>> => {
      const { page, perPage, offset } = paginate(config.pagination);
      const result = await notifications.list(
        { page, perPage, offset },
        {
          sentBy: config.access.sentBy,
          isAdmin: config.access.isAdmin,
          search: config.access.search,
          status: config.access.status,
        },
      );
      return {
        items: result.notifications,
        page,
        perPage,
        total: result.total,
        hasNext: page * perPage < result.total,
      };
    },
    get: async (config: { id: string }) => notifications.getById(config.id),
    summary: async (config: { access: { sentBy: string; isAdmin: boolean }; days?: number }) =>
      notifications.getStatusSummary({
        sentBy: config.access.sentBy,
        isAdmin: config.access.isAdmin,
        days: config.days,
      }),
    searchSummary: async (config: { access: { sentBy: string; isAdmin: boolean }; search: string }) =>
      notifications.getSearchSummary({
        sentBy: config.access.sentBy,
        isAdmin: config.access.isAdmin,
        search: config.search,
      }),
    resend: async (config: { id: string }) => {
      const result = await notifications.resend(config.id);
      if (!result.ok) return fail(mapNotificationMutationError(result));
      return ok();
    },
    update: async (config: {
      id: string;
      data: { subject?: string; content?: string; recipient?: string };
      access: { isAdmin: boolean };
    }) => {
      const result = await notifications.update(config.id, config.data, {
        isAdmin: config.access.isAdmin,
      });
      if (!result.ok) return fail(mapNotificationMutationError(result));
      return ok();
    },
  },
  system: {
    pendingCount: async () => notifications.getPendingSystemCount(),
    sendAllPending: async () =>
      tryCatch(
        () => notifications.sendAllPendingSystem(),
        (error) => err.internal(error instanceof Error ? error.message : String(error)),
      ),
  },
};

export type NotificationsService = typeof notificationsService;
