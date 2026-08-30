import { type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import type { AccessSubject } from "@valentinkolb/cloud/server";
import type { AccessEntry, Space, SpaceColumn, SpaceComment, SpaceItem, SpaceTag } from "@/contracts";
import * as access from "./access";
import * as activity from "./activity";
import * as apiKeys from "./api-keys";
import * as calendarInvitations from "./calendar-invitations";
import * as columns from "./columns";
import * as comments from "./comments";
import * as ical from "./ical";
import * as itemAttachments from "./item-attachments";
import * as itemChecklist from "./item-checklist";
import * as itemDependencies from "./item-dependencies";
import * as itemResourceReferences from "./item-resource-references";
import * as items from "./items";
import * as spaces from "./spaces";
import * as tags from "./tags";
import * as wormholes from "./wormholes";

const paginateItems = <T>(items: T[], pagination?: PageParams): Paginated<T> => {
  if (!pagination) {
    return {
      items,
      page: 1,
      perPage: items.length,
      total: items.length,
      hasNext: false,
    };
  }

  const { page, perPage, offset } = paginate(pagination);
  const sliced = items.slice(offset, offset + perPage);
  return {
    items: sliced,
    page,
    perPage,
    total: items.length,
    hasNext: page * perPage < items.length,
  };
};

export const spacesService = {
  activity,
  calendarInvitations,
  space: {
    listWithPermission: spaces.listPage,
    list: async (config: {
      subject: AccessSubject;
      boundSpaceId?: string | null;
      requiredLevel?: "read" | "write" | "admin";
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<Space>> => {
      const items = await spaces.list({
        subject: config.subject,
        boundSpaceId: config.boundSpaceId,
        requiredLevel: config.requiredLevel,
      });

      const query = config.filter?.query?.trim().toLowerCase();
      const filtered =
        query && query.length > 0
          ? items.filter((space) => {
              const name = space.name.toLowerCase();
              const description = (space.description ?? "").toLowerCase();
              return name.includes(query) || description.includes(query);
            })
          : items;

      return paginateItems(filtered, config.pagination);
    },
    get: spaces.get,
    getDetail: spaces.getDetail,
    create: spaces.create,
    update: spaces.update,
    remove: spaces.remove,
    regenerateICalToken: spaces.regenerateICalToken,
    getByICalToken: spaces.getByICalToken,
    permission: {
      canAccess: spaces.canAccess,
      get: spaces.getPermission,
    },
    admin: {
      list: async (config: { pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<spaces.SpaceAdminListItem>> => {
        const { page, perPage, offset } = paginate(config.pagination);
        const result = await spaces.listAdmin({
          search: config.filter?.query,
          pagination: { limit: perPage, offset },
        });
        return {
          items: result.items,
          page,
          perPage,
          total: result.total,
          hasNext: page * perPage < result.total,
        };
      },
      summary: async (config: { filter?: { query?: string } }) => spaces.adminSummary({ search: config.filter?.query }),
    },
  },
  column: {
    list: async (config: { spaceId: string; pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<SpaceColumn>> => {
      const items = await columns.list({ spaceId: config.spaceId });
      const query = config.filter?.query?.trim().toLowerCase();
      const filtered = query && query.length > 0 ? items.filter((column) => column.name.toLowerCase().includes(query)) : items;
      return paginateItems(filtered, config.pagination);
    },
    get: columns.get,
    create: columns.create,
    update: columns.update,
    remove: columns.remove,
    reorder: columns.reorder,
  },
  tag: {
    list: async (config: { spaceId: string; pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<SpaceTag>> => {
      const items = await tags.list({ spaceId: config.spaceId });
      const query = config.filter?.query?.trim().toLowerCase();
      const filtered = query && query.length > 0 ? items.filter((tag) => tag.name.toLowerCase().includes(query)) : items;
      return paginateItems(filtered, config.pagination);
    },
    get: tags.get,
    create: tags.create,
    update: tags.update,
    remove: tags.remove,
  },
  wormhole: {
    actorForUser: wormholes.actorForUser,
    listUsable: wormholes.listUsable,
    listConfigured: wormholes.listConfigured,
    listDestinations: wormholes.listDestinations,
    create: wormholes.create,
    update: wormholes.update,
    reorder: wormholes.reorder,
    remove: wormholes.remove,
    transfer: wormholes.transfer,
  },
  item: {
    list: async (config: {
      spaceId: string;
      includeCompleted?: boolean;
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<SpaceItem>> => {
      const entries = await items.list({
        spaceId: config.spaceId,
        includeCompleted: config.includeCompleted,
      });
      const query = config.filter?.query?.trim().toLowerCase();
      const filtered =
        query && query.length > 0
          ? entries.filter((item) => {
              const title = item.title.toLowerCase();
              const description = (item.description ?? "").toLowerCase();
              return title.includes(query) || description.includes(query);
            })
          : entries;
      return paginateItems(filtered, config.pagination);
    },
    listFiltered: items.listFiltered,
    listAssignableUsers: items.listAssignableUsers,
    /** Single-query cross-space search used by the global search dialog. */
    searchAcross: items.searchAcross,
    get: items.get,
    getRecurringOverride: items.getRecurringOverride,
    create: items.create,
    update: items.update,
    splitRecurring: items.splitRecurring,
    remove: items.remove,
    move: items.move,
    setCompleted: items.setCompleted,
    setAssignees: items.setAssignees,
    setTags: items.setTags,
    calendar: {
      list: items.listCalendar,
      checkOverlap: items.checkOverlap,
    },
    tasks: {
      listMine: items.listMyTasks,
    },
    dashboardSnapshot: items.dashboardSnapshot,
    references: itemResourceReferences,
    dependencies: itemDependencies,
    attachments: itemAttachments,
    checklist: itemChecklist,
  },
  comment: {
    list: async (config: {
      itemId: string;
      recurrenceId?: string | null;
      viewerUserId?: string | null;
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<SpaceComment>> => {
      return comments.list({
        itemId: config.itemId,
        recurrenceId: config.recurrenceId,
        viewerUserId: config.viewerUserId,
        pagination: config.pagination,
        query: config.filter?.query,
      });
    },
    get: comments.get,
    create: comments.create,
    update: comments.update,
    remove: comments.remove,
  },
  access: {
    list: async (config: {
      spaceId: string;
      pagination?: PageParams;
      filter?: {
        query?: string;
        principalType?: AccessEntry["principal"]["type"];
      };
    }): Promise<Paginated<AccessEntry>> => {
      const items = await access.listSpaceAccess(config.spaceId);
      const query = config.filter?.query?.trim().toLowerCase();
      const principalType = config.filter?.principalType;

      const filtered = items.filter((entry) => {
        if (principalType && entry.principal.type !== principalType) {
          return false;
        }
        if (!query) return true;

        const displayName = (entry.displayName ?? "").toLowerCase();
        if (displayName.includes(query)) return true;

        if (entry.principal.type === "user") {
          return entry.principal.userId.toLowerCase().includes(query);
        }
        if (entry.principal.type === "group") {
          return entry.principal.groupId.toLowerCase().includes(query);
        }
        if (entry.principal.type === "service_account") {
          return entry.principal.serviceAccountId.toLowerCase().includes(query);
        }
        if (entry.principal.type === "authenticated") {
          return "all signed-in users authenticated".includes(query);
        }
        return "public".includes(query);
      });

      return paginateItems(filtered, config.pagination);
    },
    grant: access.grantSpaceAccess,
    remove: access.revokeSpaceAccess,
    update: access.updateSpaceAccessPermission,
    add: (config: { spaceId: string; accessId: string }) => access.addSpaceAccess(config.spaceId, config.accessId),
    count: (config: { spaceId: string }) => access.countSpaceAccess(config.spaceId),
    getPermission: access.getSpacePermission,
    ensureServiceAccount: access.ensureSpaceServiceAccountAccess,
    apiKeys: {
      list: apiKeys.list,
      create: apiKeys.create,
      revoke: apiKeys.revoke,
    },
  },
  ical: {
    getByToken: ical.getByToken,
    generate: ical.generate,
  },
};

// Re-export types needed by widgets
export type { ItemAcrossKind, ItemAcrossResult, TaskItem } from "./items";
export type { SpaceAdminListItem, SpaceWithPermission } from "./spaces";
export { access, activity, calendarInvitations, columns, comments, ical, items, spaces, tags, wormholes };
