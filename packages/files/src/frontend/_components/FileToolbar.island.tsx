import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Dropdown, ProgressBar, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { formatBytes } from "@valentinkolb/cloud/shared";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { FileBaseInfo } from "@/contracts";
import {
  buildItemPath,
  buildSelectionKey,
  clearSelection,
  FILE_SELECTION_EVENT,
  fileApiUrl,
  fileAppUrlForPath,
  getFilenameFromKey,
  navigateWithParam,
  parseSelectionKey,
  type SelectionKey,
  setHighlightedFiles,
  setSelectedInUrl,
} from "./context";
import MoveTargetSearch from "./MoveTargetSearch";
import { createUploadManager, type FileUploadState } from "./upload";
import { filesMessages } from "../messages";

type FileToolbarProps = {
  baseType: FileBaseInfo["type"];
  baseId: string;
  currentPath: string;
  initialFilterQuery?: string;
  initialSelected?: SelectionKey[];
  /** All item names in current directory (for Select All) */
  allItems?: string[];
  folderCount: number;
  fileCount: number;
  totalSize: string;
  bases?: FileBaseInfo[];
};

export default function FileToolbar({
  baseType,
  baseId,
  currentPath,
  initialFilterQuery = "",
  initialSelected = [],
  allItems = [],
  folderCount,
  fileCount,
  totalSize,
  bases = [],
}: FileToolbarProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const [filterQuery, setFilterQuery] = createSignal(initialFilterQuery);
  const [selected, setSelected] = createSignal<SelectionKey[]>(initialSelected);
  const uploadManager = createUploadManager(() => ({
    emptyFile: t().emptyFileUpload,
    preparationFailed: t().uploadPreparationFailed,
    startFailed: t().uploadStartFailed,
    chunkFailed: t().chunkUploadFailed,
    cancelled: t().uploadCancelled,
    uploadFailed: t().uploadFailed,
    selectFailed: t().selectFilesFailed,
  }));
  const validateName = (value: string | undefined) => {
    if (!value?.trim()) return t().requiredName;
    if (value.includes("/")) return t().invalidSlash;
    if (value === "." || value === "..") return t().invalidName;
    return null;
  };

  // Listen for selection changes from FileList
  onMount(() => {
    const handler = (e: Event) => {
      setSelected((e as CustomEvent<SelectionKey[]>).detail);
    };
    window.addEventListener(FILE_SELECTION_EVENT, handler);
    onCleanup(() => window.removeEventListener(FILE_SELECTION_EVENT, handler));
  });

  const allKeys = allItems.map((name) => buildSelectionKey(baseType, baseId, buildItemPath(currentPath, name)));
  const selectionCount = () => selected().length;
  const allSelected = () => selectionCount() === allKeys.length && allKeys.length > 0;

  const handleSelectAll = () => {
    setSelected(allKeys);
    setSelectedInUrl(new Set(allKeys));
  };

  const bulkDeleteMutation = mutations.create<{ total: number; errors: number } | null, void>({
    mutation: async () => {
      const keys = selected();
      if (keys.length === 0) return null;

      const confirmed = await prompts.confirm(t().moveItemsTrash({ count: keys.length }), {
        title: t().moveTrash,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().moveTrash,
        cancelText: t().cancel,
      });
      if (!confirmed) return null;

      let errors = 0;
      for (const key of keys) {
        const parsed = parseSelectionKey(key);
        if (!parsed) continue;
        const res = await apiClient[":baseType"][":baseId"].$delete({
          param: {
            baseType: parsed.baseType,
            baseId: parsed.baseId,
          },
          query: { path: parsed.path },
        });
        if (!res.ok) errors++;
      }
      return { total: keys.length, errors };
    },
    onSuccess: (result) => {
      if (!result) return;
      clearSelection();
      refreshCurrentPath();
      if (result.errors > 0) {
        void prompts.error(t().deleteItemsFailed({ count: result.errors }));
        return;
      }
      toast.success(t().movedItemsTrash({ count: result.total }));
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleBulkDownload = () => {
    for (const key of selected()) {
      const parsed = parseSelectionKey(key);
      if (!parsed) continue;
      const link = document.createElement("a");
      link.href = `${fileApiUrl(parsed.baseType, parsed.baseId)}/content?path=${encodeURIComponent(parsed.path)}`;
      link.download = getFilenameFromKey(key);
      link.click();
    }
  };

  const handleBulkMove = () => {
    const keys = selected();
    if (keys.length === 0) return;
    const firstParsed = parseSelectionKey(keys[0]!);
    if (!firstParsed) return;
    const sourcePaths = keys.map((key) => parseSelectionKey(key)?.path ?? "").filter(Boolean);
    prompts.dialog(
      (close) => (
        <MoveTargetSearch
          sourceBaseType={firstParsed.baseType}
          sourceBaseId={firstParsed.baseId}
          sourcePaths={sourcePaths}
          bases={bases}
          onComplete={(target) => {
            clearSelection();
            setHighlightedFiles(target.movedFiles);
            navigateTo(fileAppUrlForPath(target.baseType, target.baseId, target.path));
          }}
          close={close}
        />
      ),
      {
        title: t().moveItem({ count: keys.length }),
        icon: "ti ti-folder-share",
        size: "large",
      },
    );
  };

  const mkdirMutation = mutations.create<{ name: string } | null, void>({
    mutation: async () => {
      const result = await prompts.form({
        title: t().newFolder,
        icon: "ti ti-folder-plus",
        confirmText: t().create,
        fields: {
          name: {
            type: "text",
            label: t().folderName,
            placeholder: t().folderPlaceholder,
            required: true,
            validate: validateName,
          },
        },
      });
      if (!result) return null;

      const name = result.name.trim();
      const newPath = buildItemPath(currentPath, name);
      const res = await apiClient[":baseType"][":baseId"].$post({
        param: { baseType, baseId },
        query: { action: "mkdir", path: newPath },
      });
      if (!res.ok) {
        throw new Error(t().createFailed);
      }
      return { name };
    },
    onSuccess: (folder) => {
      if (!folder) return;
      toast.success(t().folderCreated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const uploadOptions = {
    onComplete: () => setTimeout(() => refreshCurrentPath(), 500),
    onError: (err: Error) => prompts.error(err.message),
  };

  const handleUploadFiles = () => uploadManager.startUpload("files", baseType, baseId, currentPath, uploadOptions);
  const handleUploadFolder = () => uploadManager.startUpload("folder", baseType, baseId, currentPath, uploadOptions);

  const handleFilterSubmit = (e: Event) => {
    e.preventDefault();
    navigateWithParam("filter", filterQuery().trim() || undefined);
  };

  const isLoading = () => mkdirMutation.loading() || bulkDeleteMutation.loading();
  const visibleUploads = () => uploadManager.state.files.filter((f) => f.status !== "complete");

  const totalFiles = () => uploadManager.state.files.length;
  const completedFiles = () => uploadManager.state.files.filter((f) => f.status === "complete").length;
  const failedFiles = () => uploadManager.state.files.filter((f) => f.status === "error").length;

  const totalBytes = () => uploadManager.state.files.reduce((sum, file) => sum + file.size, 0);

  const uploadedBytes = () =>
    uploadManager.state.files.reduce((sum, file) => {
      const progress = Math.max(0, Math.min(100, file.progress));
      return sum + Math.round((file.size * progress) / 100);
    }, 0);

  const globalProgress = () => {
    const bytes = totalBytes();
    if (bytes <= 0) return 0;
    return Math.round((uploadedBytes() / bytes) * 100);
  };

  return (
    <div class="flex flex-col gap-2 w-full">
      <div class="flex flex-wrap items-center gap-2">
        <Dropdown.Root
          position="bottom-right"
          width="11rem"
          items={[
            {
              sectionLabel: t().upload,
              items: [
                {
                  icon: "ti ti-upload",
                  label: t().uploadFiles,
                  action: handleUploadFiles,
                },
                {
                  icon: "ti ti-folder-up",
                  label: t().uploadFolder,
                  action: handleUploadFolder,
                },
              ],
            },
            {
              sectionLabel: t().create,
              items: [
                {
                  icon: "ti ti-folder-plus",
                  label: t().newFolder,
                  action: () => mkdirMutation.mutate(undefined),
                },
              ],
            },
          ]}
        >
          <Dropdown.Trigger
            variant="secondary"
            size="sm"
            disabled={isLoading() || uploadManager.state.isUploading}
            classList={{
              "opacity-50 pointer-events-none": isLoading() || uploadManager.state.isUploading,
            }}
          >
            <i class={`ti text-sm ${uploadManager.state.isUploading ? "ti-loader-2 animate-spin" : "ti-plus"}`} />
            <span>{t().new}</span>
            <i class="ti ti-chevron-down text-[10px]" />
          </Dropdown.Trigger>
        </Dropdown.Root>

        <Show when={selectionCount() > 0}>
          <Dropdown.Root
            position="bottom-right"
            width="10rem"
            items={[
              ...(bases.length > 0
                ? [
                    {
                      icon: "ti ti-folder-share",
                      label: t().move,
                      action: handleBulkMove,
                    },
                  ]
                : []),
              {
                icon: "ti ti-download",
                label: t().download,
                action: handleBulkDownload,
              },
              {
                icon: "ti ti-trash",
                label: t().delete,
                variant: "danger" as const,
                action: () => bulkDeleteMutation.mutate(undefined),
              },
              ...(!allSelected() && allKeys.length > 1
                ? [
                    {
                      icon: "ti ti-list-check",
                      label: t().selectAll,
                      action: handleSelectAll,
                    },
                  ]
                : []),
              {
                icon: "ti ti-x",
                label: t().deselect,
                action: clearSelection,
              },
            ]}
          >
            <Dropdown.Trigger variant="secondary" size="sm">
              <i class="ti ti-checks text-sm" />
              <span class="text-[10px]">{selectionCount()}</span>
              <i class="ti ti-chevron-down text-[10px]" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </Show>

        <form onSubmit={handleFilterSubmit} class="min-w-[14rem] flex-1" role="search">
          <TextInput
            type="search"
            placeholder={t().searchFolder}
            aria-label={t().searchFiles}
            value={filterQuery}
            onValueChange={setFilterQuery}
            clearable
            onClear={() => {
              setFilterQuery("");
              navigateWithParam("filter", undefined);
            }}
            icon="ti ti-search"
          />
        </form>

        <div class="ml-auto inline-flex min-h-[var(--ui-control-sm)] items-center gap-3 px-1 text-xs text-dimmed">
          <Show when={folderCount > 0}>
            <span class="inline-flex items-center gap-1" title={t().foldersCount({ count: folderCount })}>
              <i class="ti ti-folder text-[11px]" />
              <span>{t().foldersCount({ count: folderCount })}</span>
            </span>
          </Show>
          <Show when={fileCount > 0}>
            <span class="inline-flex items-center gap-1" title={`${t().filesCount({ count: fileCount })} (${totalSize})`}>
              <i class="ti ti-file text-[11px]" />
              <span>{t().filesCount({ count: fileCount })}</span>
            </span>
          </Show>
          <Show when={folderCount === 0 && fileCount === 0}>
            <span>{t().empty}</span>
          </Show>
          <Show when={totalSize !== "—" && fileCount > 0}>
            <span class="hidden sm:inline text-dimmed">{totalSize}</span>
          </Show>
        </div>
      </div>

      {/* Upload progress */}
      <Show when={uploadManager.state.files.length > 0}>
        <div class="paper flex flex-col gap-2 p-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-dimmed">
              {uploadManager.state.isUploading
                ? t().uploadingFiles({ completed: completedFiles(), total: totalFiles() })
                : failedFiles() > 0
                  ? t().uploadFinished({ completed: completedFiles(), failed: failedFiles() })
                  : t().uploadDone}
            </span>
            <Show when={!uploadManager.state.isUploading}>
              <Button type="button" variant="ghost" size="xs" onClick={() => uploadManager.clearAll()}>
                {t().clear}
              </Button>
            </Show>
            <Show when={uploadManager.state.isUploading}>
              <Button type="button" variant="danger" size="xs" onClick={() => uploadManager.cancel()}>
                {t().cancel}
              </Button>
            </Show>
          </div>
          <ProgressBar value={globalProgress()} size="sm" showValue label={t().overallProgress} />
          <div class="text-[11px] text-dimmed">
            {formatBytes(uploadedBytes())} / {formatBytes(totalBytes())}
          </div>
          <Show when={visibleUploads().length > 0}>
            <div class="max-h-40 overflow-y-auto">
              <div class="flex flex-col gap-1">
                <For each={visibleUploads()}>{(file) => <UploadProgressItem {...file} />}</For>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function UploadProgressItem(props: FileUploadState) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const statusIcon = () => {
    switch (props.status) {
      case "pending":
        return "ti-clock text-zinc-400";
      case "uploading":
        return "ti-loader-2 animate-spin text-primary";
      case "complete":
        return "ti-check text-green-500";
      case "error":
        return "ti-alert-triangle text-red-500";
    }
  };

  return (
    <Show
      when={props.status === "error"}
      fallback={
        <div class="flex items-center gap-2 text-xs">
          <i class={`ti ${statusIcon()}`} />
          <span class="flex-1 truncate" classList={{ "text-dimmed": props.status === "pending" }} title={props.filename}>
            {props.relativePath ?? props.filename}
          </span>
          <Show when={props.status === "uploading"}>
            <ProgressBar value={props.progress} size="xs" class="w-20" label={t().fileUploadProgress({ filename: props.filename })} />
            <span class="w-8 text-right text-dimmed">{props.progress}%</span>
          </Show>
        </div>
      }
    >
      <div class="flex flex-col gap-0.5 rounded-[var(--ui-radius-control)] bg-red-500/10 px-2 py-1 text-xs">
        <div class="flex items-center gap-2">
          <i class={`ti ${statusIcon()}`} />
          <span class="text-red-500 font-medium truncate" title={props.filename}>
            {props.relativePath ?? props.filename}
          </span>
        </div>
        <span class="text-red-400 text-[11px] pl-5">{props.error ?? t().uploadFailed}</span>
      </div>
    </Show>
  );
}
