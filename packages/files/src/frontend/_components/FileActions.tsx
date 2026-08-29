import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import type { DropdownItem } from "@k2b/ui";
import { Dropdown, prompts, toast, useLocale } from "@k2b/ui";
import { useContext } from "solid-js";
import { apiClient } from "@/api/client";
import type { FileBaseInfo, FileInfo } from "@/contracts";
import { FileContext, fileApiUrl, fileAppUrlForPath, requestFileLightboxOpen, setDetailFileInUrl, setHighlightedFiles } from "./context";
import MoveTargetSearch from "./MoveTargetSearch";
import { filesMessages } from "../messages";

export type FileActionContext = {
  baseType: FileBaseInfo["type"];
  baseId: string;
  bases: FileBaseInfo[];
};

export type FileActionOptions = {
  item: FileInfo;
  itemPath: string;
  ctx: FileActionContext;
  onShowDetail?: () => void;
  onCloseDetail?: () => void;
};

const hasFileExtension = (name: string) => {
  const trimmed = name.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < trimmed.length - 1;
};

const buildCopyName = (name: string) => {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? `${name.slice(0, dotIndex)}-copy${name.slice(dotIndex)}` : `${name}-copy`;
};

export const canOpenFileInline = (item: FileInfo) => {
  const mime = item.mimeType ?? "";
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime.startsWith("text/")
  );
};

export const openFileItem = ({ item, itemPath, ctx }: Pick<FileActionOptions, "item" | "itemPath" | "ctx">) => {
  if (item.type === "directory") {
    navigateTo(fileAppUrlForPath(ctx.baseType, ctx.baseId, itemPath));
    return;
  }

  if ((item.mimeType ?? "").startsWith("image/")) {
    requestFileLightboxOpen({
      baseType: ctx.baseType,
      baseId: ctx.baseId,
      path: itemPath,
    });
    return;
  }

  window.open(
    `${fileApiUrl(ctx.baseType, ctx.baseId)}/content?path=${encodeURIComponent(itemPath)}&inline=true`,
    "_blank",
    "noopener,noreferrer",
  );
};

export const downloadFileItem = ({ item, itemPath, ctx }: Pick<FileActionOptions, "item" | "itemPath" | "ctx">) => {
  const link = document.createElement("a");
  link.href = `${fileApiUrl(ctx.baseType, ctx.baseId)}/content?path=${encodeURIComponent(itemPath)}`;
  link.download = item.name;
  link.click();
};

export const renameFileItem = async ({ item, itemPath, ctx }: Pick<FileActionOptions, "item" | "itemPath" | "ctx">, locale = "en") => {
  const { t } = filesMessages.resolve([locale]);
  const isDirectory = item.type === "directory";
  const result = await prompts.form({
    title: isDirectory ? t.renameFolder : t.renameFile,
    icon: "ti ti-pencil",
    confirmText: t.rename,
    fields: {
      newName: {
        type: "text",
        label: t.newName,
        default: item.name,
        required: true,
        validate: (value) => {
          if (!value?.trim()) return t.requiredName;
          if (value.includes("/")) return t.invalidSlash;
          if (value === "." || value === "..") return t.invalidName;
          return null;
        },
      },
    },
  });

  if (!result || result.newName.trim() === item.name) return false;
  const newName = result.newName.trim();

  if (!isDirectory && !hasFileExtension(newName)) {
    const confirmed = await prompts.confirm(t.filenameNoExtension({ name: newName }), {
      title: t.renameWithoutExtension,
      icon: "ti ti-alert-triangle",
      confirmText: t.renameAnyway,
      cancelText: t.cancel,
    });
    if (!confirmed) return false;
  }

  const parentPath = itemPath.substring(0, itemPath.lastIndexOf("/")) || "/";
  const newPath = parentPath === "/" ? `/${newName}` : `${parentPath}/${newName}`;
  const res = await apiClient[":baseType"][":baseId"].$post({
    param: { baseType: ctx.baseType, baseId: ctx.baseId },
    query: { action: "move", path: itemPath, to: newPath },
  });

  if (!res.ok) {
    throw new Error(t.renameFailed);
  }
  return true;
};

export const duplicateFileItem = async ({ item, itemPath, ctx }: Pick<FileActionOptions, "item" | "itemPath" | "ctx">, locale = "en") => {
  const { t } = filesMessages.resolve([locale]);
  const defaultName = buildCopyName(item.name);
  const result = await prompts.form({
    title: t.duplicate,
    icon: "ti ti-copy",
    confirmText: t.duplicate,
    fields: {
      newName: {
        type: "text",
        label: t.newName,
        placeholder: defaultName,
        default: defaultName,
        required: true,
        validate: (value) => {
          if (!value?.trim()) return t.requiredName;
          if (value.includes("/")) return t.invalidSlash;
          return null;
        },
      },
    },
  });

  if (!result) return false;

  const res = await apiClient[":baseType"][":baseId"].duplicate.$post({
    param: { baseType: ctx.baseType, baseId: ctx.baseId },
    json: { path: itemPath, newName: result.newName.trim() },
  });

  if (!res.ok) {
    throw new Error(t.duplicateFailed);
  }
  return true;
};

export const deleteFileItem = async ({ item, itemPath, ctx }: Pick<FileActionOptions, "item" | "itemPath" | "ctx">, locale = "en") => {
  const { t } = filesMessages.resolve([locale]);
  const message = item.type === "directory" ? t.moveFolderTrash({ name: item.name }) : t.moveFileTrash({ name: item.name });
  const confirmed = await prompts.confirm(message, {
    title: t.moveTrash,
    icon: "ti ti-trash",
    variant: "danger",
    confirmText: t.moveTrash,
    cancelText: t.cancel,
  });
  if (!confirmed) return false;

  const res = await apiClient[":baseType"][":baseId"].$delete({
    param: { baseType: ctx.baseType, baseId: ctx.baseId },
    query: { path: itemPath },
  });

  if (!res.ok) {
    throw new Error(t.deleteFailed);
  }
  return true;
};

export const moveFileItem = async (
  { item, itemPath, ctx, onCloseDetail }: Pick<FileActionOptions, "item" | "itemPath" | "ctx" | "onCloseDetail">,
  locale = "en",
) => {
  if (ctx.bases.length === 0) return;

  prompts.dialog(
    (close) => (
      <MoveTargetSearch
        sourceBaseType={ctx.baseType}
        sourceBaseId={ctx.baseId}
        sourcePaths={[itemPath]}
        bases={ctx.bases}
        onComplete={(target) => {
          onCloseDetail?.();
          setHighlightedFiles(target.movedFiles);
          navigateTo(fileAppUrlForPath(target.baseType, target.baseId, target.path));
        }}
        close={close}
      />
    ),
    { title: filesMessages.resolve([locale]).t.moveNamedItem({ name: item.name }), icon: "ti ti-folder-share", size: "large" },
  );
};

type FileActionHandlers = {
  rename: (options: FileActionOptions) => void;
  duplicate: (options: FileActionOptions) => void;
  delete: (options: FileActionOptions) => void;
};

export const createFileActionMutations = () => {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const renameMutation = mutations.create<boolean, FileActionOptions, FileActionOptions>({
    onBefore: (options) => options,
    mutation: (options) => renameFileItem(options, locale()),
    onSuccess: (renamed, options) => {
      if (!renamed || !options) return;
      toast.success(options.item.type === "directory" ? t().folderRenamed : t().fileRenamed);
      if (options.onShowDetail) {
        setDetailFileInUrl(options.itemPath, options.item, options.ctx.baseType, options.ctx.baseId);
      }
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const duplicateMutation = mutations.create<boolean, FileActionOptions>({
    mutation: (options) => duplicateFileItem(options, locale()),
    onSuccess: (duplicated) => {
      if (!duplicated) return;
      toast.success(t().duplicated);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteMutation = mutations.create<boolean, FileActionOptions, FileActionOptions>({
    onBefore: (options) => options,
    mutation: (options) => deleteFileItem(options, locale()),
    onSuccess: (deleted, options) => {
      if (!deleted) return;
      toast.success(t().movedTrash);
      options?.onCloseDetail?.();
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const handlers: FileActionHandlers = {
    rename: (options) => renameMutation.mutate(options),
    duplicate: (options) => duplicateMutation.mutate(options),
    delete: (options) => deleteMutation.mutate(options),
  };

  return {
    buildFileMenuElements: (options: FileActionOptions) => buildFileMenuElements(options, handlers, locale()),
    loading: () => renameMutation.loading() || duplicateMutation.loading() || deleteMutation.loading(),
  };
};

export const buildFileMenuElements = (
  { item, itemPath, ctx, onShowDetail, onCloseDetail }: FileActionOptions,
  handlers?: FileActionHandlers,
  locale = "en",
): DropdownItem[] => {
  const { t } = filesMessages.resolve([locale]);
  const detailItemKey = itemPath;
  const canOpenInline = item.type === "directory" || canOpenFileInline(item);
  const actionOptions = { item, itemPath, ctx, onShowDetail, onCloseDetail };

  return [
    {
      icon: "ti ti-file-info",
      label: item.type === "directory" ? t.showFolderDetail : t.showDetail,
      action: () => onShowDetail?.(),
    },
    {
      icon: item.type === "directory" ? "ti ti-folder-open" : "ti ti-eye",
      label: item.type === "directory" ? t.openFolder : t.open,
      action: () => openFileItem({ item, itemPath, ctx }),
    },
    {
      icon: "ti ti-download",
      label: item.type === "directory" ? t.downloadTar : t.download,
      action: () => downloadFileItem({ item, itemPath, ctx }),
    },
    {
      icon: "ti ti-pencil",
      label: t.rename,
      action: async () => {
        if (handlers) {
          handlers.rename(actionOptions);
          return;
        }
        const renamed = await renameFileItem({ item, itemPath, ctx }, locale);
        if (!renamed) return;
        if (onShowDetail) {
          setDetailFileInUrl(detailItemKey, item, ctx.baseType, ctx.baseId);
        }
        refreshCurrentPath();
      },
    },
    {
      icon: "ti ti-copy",
      label: t.duplicate,
      action: async () => {
        if (handlers) {
          handlers.duplicate(actionOptions);
          return;
        }
        const duplicated = await duplicateFileItem({ item, itemPath, ctx }, locale);
        if (!duplicated) return;
        refreshCurrentPath();
      },
    },
    ...(ctx.bases.length > 0
      ? [
          {
            icon: "ti ti-folder-share",
            label: t.moveTo,
            action: () => moveFileItem({ item, itemPath, ctx, onCloseDetail }, locale),
          },
        ]
      : []),
    ...(canOpenInline && item.type !== "directory"
      ? [
          {
            icon: "ti ti-external-link",
            label: t.openNewTab,
            action: () =>
              window.open(`${fileApiUrl(ctx.baseType, ctx.baseId)}/content?path=${encodeURIComponent(itemPath)}&inline=true`, "_blank"),
          },
        ]
      : []),
    {
      icon: "ti ti-trash",
      label: t.delete,
      variant: "danger" as const,
      action: async () => {
        if (handlers) {
          handlers.delete(actionOptions);
          return;
        }
        const deleted = await deleteFileItem({ item, itemPath, ctx }, locale);
        if (!deleted) return;
        onCloseDetail?.();
        refreshCurrentPath();
      },
    },
  ];
};

type FileActionsProps = {
  item: FileInfo;
  itemPath: string;
};

export default function FileActions(props: FileActionsProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const ctx = useContext(FileContext);
  if (!ctx) return null;
  const fileActions = createFileActionMutations();

  return (
    <Dropdown.Root
      position="bottom-left"
      width="12rem"
      items={fileActions.buildFileMenuElements({
        item: props.item,
        itemPath: props.itemPath,
        ctx,
      })}
    >
      <Dropdown.Trigger
        label={t().actions}
        appearance="plain"
        class="inline-flex h-8 w-8 items-center justify-center text-dimmed transition-colors hover:app-accent-text"
        data-dnd-ignore
      >
        <i class="ti ti-dots" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
