import { err, fail, ok } from "@k2b/stdlib";
import {
  type CapabilityExecutionContext,
  type CloudResourceView,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import { filesService } from "./service";

const supportsFilesApp = (user: { provider: string; profile: string }) => user.provider === "ipa" && user.profile === "user";

const normalizePath = (path: string): string => (!path || path === "/" ? "/" : path.startsWith("/") ? path : `/${path}`);

const buildFileHref = (baseType: "home" | "group", baseId: string, path: string): string => {
  const normalizedPath = normalizePath(path);
  if (baseType === "home") {
    if (normalizedPath === "/") return "/app/files/home";
    const encodedSegments = normalizedPath
      .slice(1)
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/app/files/home/${encodedSegments}`;
  }
  if (normalizedPath === "/") return `/app/files/group/${encodeURIComponent(baseId)}`;
  return `/app/files/group/${encodeURIComponent(baseId)}?path=${encodeURIComponent(normalizedPath)}`;
};

const toPattern = (query: string): string => (query.includes("*") || query.includes("?") ? query : `**/*${query}*`);
const isImage = (mimeType?: string) => typeof mimeType === "string" && mimeType.startsWith("image/");
const buildPreviewUrl = (baseType: "home" | "group", baseId: string, path: string) =>
  `/api/files/${baseType}/${encodeURIComponent(baseId)}/thumbnail?path=${encodeURIComponent(path)}`;

const fileResourceInput = (type: "files.file" | "files.directory") =>
  z
    .object({
      id: z.string().min(1).max(4_608).describe(`Exact ${type} resource ID from the typed ref returned by Search files.`),
    })
    .strict();

const FileResourceBaseSchema = z
  .object({
    type: z.enum(["home", "group"]),
    id: z.string(),
    name: z.string(),
  })
  .strict();

const FileReadDataSchema = z
  .object({
    id: z.string(),
    type: z.literal("file"),
    name: z.string(),
    path: z.string(),
    base: FileResourceBaseSchema,
    size: z.number().nonnegative(),
    modifiedAt: z.string(),
    hidden: z.boolean(),
    mimeType: z.string().optional(),
  })
  .strict();

const DirectoryReadDataSchema = z
  .object({
    id: z.string(),
    type: z.literal("directory"),
    name: z.string(),
    path: z.string(),
    base: FileResourceBaseSchema,
    modifiedAt: z.string(),
    hidden: z.boolean(),
    itemCount: z.number().int().nonnegative(),
  })
  .strict();

const parseResourceId = (id: string) => {
  const first = id.indexOf(":");
  const second = id.indexOf(":", first + 1);
  const baseType = id.slice(0, first);
  const baseId = id.slice(first + 1, second);
  const path = id.slice(second + 1);
  return (baseType === "home" || baseType === "group") && baseId && path
    ? ok({ baseType, baseId, path })
    : fail(err.badInput("File resource ID must be an exact typed ref returned by Search files"));
};

const serviceError = (result: { ok: false; error: string; status: 400 | 401 | 403 | 404 | 409 | 500 }) => {
  if (result.status === 401 || result.status === 403) return fail(err.forbidden(result.error));
  if (result.status === 404) return fail(err.notFound(result.error.replace(/ not found$/i, "")));
  if (result.status === 409) return fail(err.conflict(result.error));
  if (result.status === 500) return fail(err.internal(result.error));
  return fail(err.badInput(result.error));
};

const readResource = async (id: string, expectedType: "file" | "directory", context: CapabilityExecutionContext) => {
  const user = context.user;
  if (!user || !supportsFilesApp(user)) return fail(err.forbidden("Files resources require a full IPA user account"));
  const identity = parseResourceId(id);
  if (!identity.ok) return identity;
  const base = await filesService.base.get(identity.data);
  if (!base.ok) return serviceError(base);
  const access = await filesService.base.permission.canAccess({ user, base: base.data });
  if (!access.ok) return serviceError(access);
  const item = await filesService.item.get({ base: base.data, path: identity.data.path, showHidden: false, computeSizes: false });
  if (!item.ok) return serviceError(item);
  if (item.data.type !== expectedType) {
    return fail(err.badInput(`The path is now a ${item.data.type}; use a current files.${item.data.type} ref returned by Search files`));
  }
  const baseInfo = filesService.base.toInfo(base.data);
  const href = buildFileHref(baseInfo.type, baseInfo.id, item.data.path);
  const common = {
    id,
    type: item.data.type,
    name: item.data.name,
    path: item.data.path,
    base: baseInfo,
    modifiedAt: item.data.mtime,
    hidden: item.data.isHidden,
  };
  return item.data.type === "file"
    ? ok({
        data: { ...common, type: "file" as const, size: item.data.size, ...(item.data.mimeType ? { mimeType: item.data.mimeType } : {}) },
        summary: `Read file “${item.data.name}”.`,
        refs: [{ type: "files.file", id, title: item.data.name, preview: `${baseInfo.name} • ${item.data.path}`, icon: "ti ti-file" }],
        links: [{ rel: "open" as const, href }],
      })
    : ok({
        data: { ...common, type: "directory" as const, itemCount: item.data.total },
        summary: `Read directory “${item.data.name}” with ${item.data.total} ${item.data.total === 1 ? "item" : "items"}.`,
        refs: [
          {
            type: "files.directory",
            id,
            title: item.data.name,
            preview: `${baseInfo.name} • ${item.data.path}`,
            icon: "ti ti-folder",
          },
        ],
        links: [{ rel: "open" as const, href }],
      });
};

const TAG_OVERFETCH_MULTIPLIER = 5;
const TAG_OVERFETCH_CAP = 200;

type FileLike = { type: "file" | "directory"; mimeType?: string; name: string };

const TAG_FILTERS: Record<string, (file: FileLike) => boolean> = {
  file: (file) => file.type === "file",
  folder: (file) => file.type === "directory",
  directory: (file) => file.type === "directory",
  image: (file) => file.type === "file" && isImage(file.mimeType),
  pdf: (file) => file.type === "file" && (file.mimeType === "application/pdf" || /\.pdf$/i.test(file.name)),
  excel: (file) => file.type === "file" && (/(spreadsheet|excel|csv)/i.test(file.mimeType ?? "") || /\.(xlsx|xls|csv)$/i.test(file.name)),
};

const runSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const user = context.user;
  if (!user || !supportsFilesApp(user)) return ok({ data: [] });

  const tagPredicates = input.tags
    .map((tag) => TAG_FILTERS[tag])
    .filter((predicate): predicate is (file: FileLike) => boolean => Boolean(predicate));
  if (input.query.length === 0 && tagPredicates.length === 0) return ok({ data: [] });

  const bases = await filesService.base.listResolved({ user });
  if (bases.length === 0) return ok({ data: [] });

  const pattern = input.query.length === 0 ? "**/*" : toPattern(input.query);
  const fetchLimit = tagPredicates.length > 0 ? Math.min(TAG_OVERFETCH_CAP, input.limit * TAG_OVERFETCH_MULTIPLIER) : input.limit;
  const result = await filesService.search.list({ bases, pattern, showHidden: false, limit: fetchLimit });
  if (!result.ok) return ok({ data: [] });

  const matches = (file: FileLike) => tagPredicates.every((predicate) => predicate(file));
  const data: CloudResourceView[] = result.data.results
    .flatMap((group) =>
      group.files.filter(matches).map((file) => {
        const id = `${group.base.type}:${group.base.id}:${file.path}`;
        return {
          ref: { type: file.type === "directory" ? "files.directory" : "files.file", id },
          title: file.name,
          preview: `${group.base.name} • ${file.path}`,
          icon: file.type === "directory" ? "ti ti-folder" : "ti ti-file",
          priority: file.type === "directory" ? 5 : 6,
          metadata: [
            { label: "Type", value: file.type === "directory" ? "Directory" : "File" },
            { label: "Base", value: group.base.name },
            { label: "Path", value: file.path },
          ],
          links: [
            { rel: "open" as const, href: buildFileHref(group.base.type, group.base.id, file.path) },
            ...(file.type === "file" && isImage(file.mimeType)
              ? [{ rel: "preview" as const, href: buildPreviewUrl(group.base.type, group.base.id, file.path) }]
              : []),
          ],
        };
      }),
    )
    .slice(0, input.limit);
  return ok({ data });
};

export const filesCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    file: { title: "File", description: "A file in personal or shared storage.", icon: "ti ti-file", reader: "file.read" },
    directory: {
      title: "Directory",
      description: "A folder in personal or shared storage.",
      icon: "ti ti-folder",
      reader: "directory.read",
    },
  },
  queries: {
    "file.read": {
      title: "Read file metadata",
      description: "Read bounded metadata for one known file from its typed resource ref. This does not return file content.",
      input: fileResourceInput("files.file"),
      data: FileReadDataSchema,
      openWorld: false,
      run: async ({ id }, context) => readResource(id, "file", context),
    },
    "directory.read": {
      title: "Read directory metadata",
      description: "Read bounded metadata and the child count for one known directory without returning its contents.",
      input: fileResourceInput("files.directory"),
      data: DirectoryReadDataSchema,
      openWorld: false,
      run: async ({ id }, context) => readResource(id, "directory", context),
    },
    search: {
      title: "Search files",
      description: "Find permission-filtered files and directories across accessible storage bases.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          { tag: "file", title: "Files", description: "Show files only." },
          { tag: "folder", title: "Folders", description: "Show directories only.", aliases: ["directory"] },
          { tag: "image", title: "Images", description: "Show image files only." },
          { tag: "excel", title: "Spreadsheets", description: "Show spreadsheet files such as XLSX, XLS, and CSV." },
          { tag: "pdf", title: "PDF", description: "Show PDF documents only." },
        ],
      },
      run: runSearch,
    },
  },
});
