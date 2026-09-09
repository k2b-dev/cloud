import { type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import type { AccessEntry } from "@k2b/cloud/contracts";
import * as access from "./access";
import * as activity from "./activity";
import * as apiKeys from "./api-keys";
import * as attachments from "./attachments";
import * as backup from "./backup";
import * as comments from "./comments";
import * as exporter from "./export";
import * as favorites from "./favorites";
import * as links from "./links";
import * as noteQuery from "./note-query";
import * as noteRefs from "./note-refs";
import * as notebooks from "./notebooks";
import * as notes from "./notes";
import * as presence from "./presence";
import { reindexRuntime } from "./reindex-scheduler";
import * as search from "./search";
import * as tags from "./tags";
import * as templates from "./templates";
import * as workspaceEvents from "./workspace-events";
import { yjsSnapshotWorker } from "./yjs-snapshot-worker";

const snapshotRuntime = backup.snapshotRuntime;

const pageFromPagination = (pagination?: PageParams) => {
  if (!pagination) return null;
  const { page, perPage, offset } = paginate(pagination);
  return {
    page,
    perPage,
    offset,
  };
};

export const notebooksService = {
  activity: {
    list: activity.list,
    record: activity.record,
  },
  notebook: {
    list: async (config: {
      userId: string | null;
      serviceAccountId?: string | null;
      boundNotebookId?: string | null;
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<notebooks.Notebook>> => {
      const pageInfo = pageFromPagination(config.pagination);
      const result = await notebooks.list({
        userId: config.userId,
        serviceAccountId: config.serviceAccountId,
        boundNotebookId: config.boundNotebookId,
        query: config.filter?.query,
        pagination: pageInfo ? { limit: pageInfo.perPage, offset: pageInfo.offset } : undefined,
      });
      const page = pageInfo?.page ?? 1;
      const perPage = pageInfo?.perPage ?? result.items.length;
      return {
        items: result.items,
        page,
        perPage,
        total: result.total,
        hasNext: page * perPage < result.total,
      };
    },
    get: notebooks.get,
    getByShortId: notebooks.getByShortId,
    create: notebooks.create,
    update: notebooks.update,
    remove: notebooks.remove,
    permission: {
      get: notebooks.getPermission,
      canAccess: notebooks.canAccess,
    },
    admin: {
      list: async (config: {
        pagination?: PageParams;
        filter?: { query?: string };
      }): Promise<Paginated<notebooks.NotebookAdminListItem>> => {
        const { page, perPage, offset } = paginate(config.pagination);
        const result = await notebooks.listAdmin({
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
      summary: async (config: { filter?: { query?: string } }) => notebooks.adminSummary({ search: config.filter?.query }),
    },
    graph: links.buildNotebookGraph,
    access: {
      list: async (config: {
        notebookId: string;
        pagination?: PageParams;
        filter?: {
          query?: string;
          principalType?: AccessEntry["principal"]["type"];
        };
      }): Promise<Paginated<AccessEntry>> => {
        const pageInfo = pageFromPagination(config.pagination);
        const result = await access.listNotebookAccessPage({
          notebookId: config.notebookId,
          query: config.filter?.query,
          principalType: config.filter?.principalType,
          pagination: pageInfo ? { limit: pageInfo.perPage, offset: pageInfo.offset } : undefined,
        });
        const page = pageInfo?.page ?? 1;
        const perPage = pageInfo?.perPage ?? result.items.length;
        return {
          items: result.items,
          page,
          perPage,
          total: result.total,
          hasNext: page * perPage < result.total,
        };
      },
      grant: access.grantNotebookAccess,
      ensureServiceAccount: access.ensureNotebookServiceAccountAccess,
      update: access.updateNotebookAccess,
      remove: (config: { notebookId: string; accessId: string }) => access.removeNotebookAccess(config.notebookId, config.accessId),
      add: (config: { notebookId: string; accessId: string }) => access.addNotebookAccess(config.notebookId, config.accessId),
      count: (config: { notebookId: string }) => access.countNotebookAccess(config.notebookId),
      guard: (config: { notebookId: string; accessId: string }) => access.getNotebookAccessGuard(config),
      getPermission: access.getNotebookPermission,
      apiKeys: {
        list: apiKeys.list,
        create: apiKeys.create,
        revoke: apiKeys.revoke,
      },
    },
  },
  template: {
    list: templates.list,
    get: templates.get,
    instantiate: templates.instantiate,
  },
  note: {
    list: async (config: {
      notebookId: string;
      pagination?: PageParams;
      filter?: { query?: string; parentId?: string | null };
    }): Promise<Paginated<notes.Note>> => {
      const pageInfo = pageFromPagination(config.pagination);
      const result = await notes.listPaged({
        notebookId: config.notebookId,
        query: config.filter?.query,
        parentId: config.filter?.parentId,
        pagination: pageInfo ? { limit: pageInfo.perPage, offset: pageInfo.offset } : undefined,
      });
      const page = pageInfo?.page ?? 1;
      const perPage = pageInfo?.perPage ?? result.items.length;
      return {
        items: result.items,
        page,
        perPage,
        total: result.total,
        hasNext: page * perPage < result.total,
      };
    },
    get: notes.get,
    getByShortId: notes.getByShortId,
    getWithContent: notes.getWithContent,
    getCurrentWithContent: notes.getCurrentWithContent,
    getWithContentByShortId: notes.getWithContentByShortId,
    resolveIdsToShortIds: notes.resolveIdsToShortIds,
    resolveShortIdsToNotebookShortIds: notes.resolveShortIdsToNotebookShortIds,
    getTree: notes.getTree,
    create: notes.create,
    update: notes.update,
    editContent: notes.editContent,
    remove: notes.remove,
    move: notes.move,
    save: notes.save,
    isLocked: notes.isLocked,
    lock: notes.lock,
    getYjsStateWithCursor: notes.getYjsStateWithCursor,
    adoptSnapshotAtHead: notes.adoptSnapshotAtHead,
    versions: {
      list: notes.listVersions,
      getSnapshot: notes.getVersionSnapshot,
      getWithContent: notes.getVersionWithContent,
      restore: notes.restoreFromSnapshot,
    },
    copyToNotebook: notes.copyToNotebook,
    search: search.searchInNotebook,
    query: noteQuery.resolveNoteQuery,
    /** ACL-safe cross-notebook search used by app search, REST, and the CLI. */
    searchAcross: search.searchAcross,
    recentForUser: notes.recentForUser,
    favorites: {
      listIds: favorites.listIds,
      isFavorite: favorites.isFavorite,
      set: favorites.setFavorite,
    },
    backlinks: {
      list: links.listBacklinks,
    },
    comments: {
      getByShortId: comments.getByShortId,
      listPage: comments.listPage,
      create: comments.create,
      update: comments.update,
      remove: comments.remove,
    },
    /** Pull every distinct `note://<shortId>` reference out of a markdown
     *  body. Returns short-ids (the form embedded in the body); the
     *  caller resolves to UUIDs / hrefs as needed. */
    extractLinks: links.extractNoteLinks,
  },
  presence: {
    join: presence.join,
    heartbeat: presence.heartbeat,
    leave: presence.leave,
    snapshot: presence.snapshot,
    watch: presence.watch,
  },
  workspaceEvents: {
    live: workspaceEvents.live,
    latestCursor: workspaceEvents.latestCursor,
    notebookUpdated: workspaceEvents.notebookUpdated,
    noteCreated: workspaceEvents.noteCreated,
    noteUpdated: workspaceEvents.noteUpdated,
    noteDeleted: workspaceEvents.noteDeleted,
    noteFavoriteChanged: workspaceEvents.noteFavoriteChanged,
    noteCommentsChanged: workspaceEvents.noteCommentsChanged,
    invalidated: workspaceEvents.invalidated,
  },
  tag: {
    listForNotebook: tags.listForNotebook,
    listNotesForTag: tags.listNotesForTag,
    countNotesForTag: tags.countNotesForTag,
    count: tags.count,
    extractTags: tags.extractTags,
    transformHtml: tags.transformTags,
  },
  noteRefs: {
    reindexNoteRefs: noteRefs.reindexNoteRefs,
    reindexNoteRefsSafe: noteRefs.reindexNoteRefsSafe,
    reindexNotebook: noteRefs.reindexNotebook,
    reindexAll: noteRefs.reindexAll,
  },
  attachment: {
    upload: attachments.upload,
    get: attachments.get,
    getByShortId: attachments.getByShortId,
    getContent: attachments.getContent,
    getContentByShortId: attachments.getContentByShortId,
    list: attachments.list,
    listByIds: attachments.listByIds,
    listByShortIds: attachments.listByShortIds,
    /** Paginated + searchable variant — used by the overview page. */
    listPaginated: async (config: {
      notebookId: string;
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<attachments.Attachment>> => {
      const { page, perPage, offset } = paginate(config.pagination);
      const result = await attachments.searchPaginated({
        notebookId: config.notebookId,
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
    remove: attachments.remove,
    count: attachments.count,
    usageCount: attachments.usageCount,
    extractIds: attachments.extractIds,
    transformHtml: attachments.transformAttachments,
  },
  exporter: {
    exportNotebookZip: exporter.exportNotebookZip,
  },
  backup: {
    getConfig: backup.getConfig,
    updateConfig: backup.updateConfig,
    getCron: backup.getCron,
    updateCron: backup.updateCron,
    listLogs: backup.listLogs,
    runS3: backup.runNotebookS3Backup,
  },
};

export type { NotebookActivityActor, NotebookActivityEvent, NotebookActivityPage } from "./activity";
export type { Attachment, AttachmentContent, AttachmentKind } from "./attachments";
export type { NoteComment } from "./comments";
export type { Backlink, GraphEdge, GraphNode, NoteGraph, NoteLink } from "./links";
// Re-export commonly used types
export type { CreateNotebook, Notebook, NotebookAdminListItem, UpdateNotebook } from "./notebooks";
export type {
  CreateNote,
  Note,
  NoteTreeNode,
  NoteVersion,
  NoteWithContent,
  UpdateNote,
} from "./notes";
export {
  access,
  activity,
  attachments,
  backup,
  comments,
  exporter,
  favorites,
  links,
  notebooks,
  noteRefs,
  notes,
  presence,
  reindexRuntime,
  snapshotRuntime,
  tags,
  workspaceEvents,
  yjsSnapshotWorker,
};
