import { err, fail, ok, type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import type { FileBase, FileBaseInfo, User } from "@/contracts";
import * as operations from "./operations";
import * as paths from "./paths";
import * as permissions from "./permissions";

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

const baseId = (base: FileBase): string => (base.type === "home" ? base.uid : base.name);

const filterRequestedBases = (bases: FileBase[], requested?: string) => {
  if (!requested) return ok(bases);

  const requestedKeys = requested
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requestedKeys.length === 0) return fail(err.badInput("No accessible bases match the provided filter"));

  const requestedSet = new Set(requestedKeys);
  const filtered = bases.filter((base) => requestedSet.has(`${base.type}:${baseId(base)}`));
  if (filtered.length === 0) return fail(err.badInput("No accessible bases match the provided filter"));

  return ok(filtered);
};

export const filesService = {
  base: {
    list: async (config: {
      user: User;
      pagination?: PageParams;
      filter?: { query?: string; type?: FileBaseInfo["type"] };
    }): Promise<Paginated<FileBaseInfo>> => {
      const items = (await permissions.listBases(config.user)).map(permissions.toBaseInfo);
      const query = config.filter?.query?.trim().toLowerCase();
      const type = config.filter?.type;
      const filtered = items.filter((base) => {
        if (type && base.type !== type) return false;
        if (!query) return true;
        return base.name.toLowerCase().includes(query) || base.id.toLowerCase().includes(query);
      });
      return paginateItems(filtered, config.pagination);
    },
    listResolved: async (config: {
      user: User;
      filter?: {
        type?: FileBase["type"];
        ids?: string[];
      };
    }): Promise<FileBase[]> => {
      const items = await permissions.listBases(config.user);
      const type = config.filter?.type;
      const ids = config.filter?.ids;
      return items.filter((base) => {
        if (type && base.type !== type) return false;
        if (!ids || ids.length === 0) return true;
        const id = base.type === "home" ? base.uid : base.name;
        return ids.includes(id);
      });
    },
    get: async (config: { baseType: string; baseId: string }) => paths.parseBase(config.baseType, config.baseId),
    toInfo: permissions.toBaseInfo,
    permission: {
      canAccess: async (config: { user: User; base: FileBase }) => permissions.canAccess(config.user, config.base),
    },
  },
  path: {
    resolveBase: (config: { base: FileBase }) => paths.resolveBase(config.base),
    resolve: (config: { base: FileBase; relativePath: string }) => paths.resolvePath(config.base, config.relativePath),
  },
  item: {
    get: operations.info,
    download: operations.download,
    thumbnail: operations.thumbnail,
    upload: operations.upload,
    createDirectory: operations.mkdir,
    move: operations.move,
    copy: operations.copy,
    remove: operations.remove,
    duplicate: operations.duplicate,
    searchDirectories: operations.searchDirectories,
  },
  search: {
    list: operations.searchAll,
    global: async (config: { user: User; bases?: string; pattern: string; showHidden?: boolean; limit?: number }) => {
      const accessibleBases = await permissions.listBases(config.user);
      const bases = filterRequestedBases(accessibleBases, config.bases);
      if (!bases.ok) return bases;
      return operations.searchAll({
        bases: bases.data,
        pattern: config.pattern,
        showHidden: config.showHidden,
        limit: config.limit,
      });
    },
  },
  transfer: {
    execute: operations.transfer,
  },
  upload: {
    start: operations.chunkedUploadStart,
    chunk: operations.chunkedUploadChunk,
  },
};

export const files = {
  paths,
  permissions,
  ...operations,
};
