import { fileIcons, text } from "@k2b/stdlib";
import { showFileDialog } from "@k2b/stdlib/browser";
import {
  Button,
  canPreviewFile,
  dialogCore,
  FileView,
  type FileViewContent,
  IconButton,
  IconButtonLink,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Tooltip,
} from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { PublicField as Field, PublicGridFile as GridFile } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { uploadRecordFile } from "./record-transfer-client";

type RecordFileLocation = {
  endpoint: string;
};

export const recordFileHref = (location: RecordFileLocation, file: GridFile) => {
  const url = new URL(location.endpoint, "http://grids.local");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(file.id)}`;
  return `${url.pathname}${url.search}`;
};

export const recordFileContentHref = (location: RecordFileLocation, file: GridFile, inline = false) => {
  const url = new URL(recordFileHref(location, file), "http://grids.local");
  url.pathname = `${url.pathname}/content`;
  if (inline) url.searchParams.set("inline", "true");
  return `${url.pathname}${url.search}`;
};

export const recordFileRemovalPrompt = (filename: string) =>
  `Remove "${filename}" from this record? Protected history or artifacts may retain the exact file. Without a protected reference, it may be cleaned up later.`;

export async function refreshFilesAfterCommittedChange(
  onChanged: (() => void) | undefined,
  refresh: () => Promise<void>,
  reportRefreshError: (error: unknown) => void,
) {
  onChanged?.();
  try {
    await refresh();
  } catch (error) {
    reportRefreshError(error);
  }
}

function RecordFilePreviewDialog(props: { location: RecordFileLocation; file: GridFile; close: () => void }) {
  const downloadHref = () => recordFileContentHref(props.location, props.file);
  const previewHref = () => recordFileContentHref(props.location, props.file, true);
  const load = async (): Promise<FileViewContent> => {
    const response = await fetch(previewHref());
    if (!response.ok) throw new Error(await errorMessage(response, "Failed to load file preview"));
    return {
      encoding: "utf8",
      content: await response.text(),
      mediaType: response.headers.get("content-type")?.split(";", 1)[0] || props.file.mimeType,
    };
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.file.filename}
        subtitle={props.file.mimeType}
        icon={`ti ${fileIcons.getFileIcon({
          name: props.file.filename,
          type: "file",
          mimeType: props.file.mimeType,
        })}`}
        actions={
          <Tooltip.Anchor content="Download file">
            <IconButtonLink
              variant="ghost"
              size="sm"
              href={downloadHref()}
              download={props.file.filename}
              label={`Download ${props.file.filename}`}
            >
              <i class="ti ti-download" aria-hidden="true" />
              <span class="sr-only">Download {props.file.filename}</span>
            </IconButtonLink>
          </Tooltip.Anchor>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <FileView
          file={{
            path: props.file.filename,
            mediaType: props.file.mimeType,
            size: props.file.sizeBytes,
          }}
          load={load}
          previewHref={previewHref()}
          downloadHref={downloadHref()}
          class="min-h-[24rem]"
        />
      </PanelDialog.Body>
    </PanelDialog>
  );
}

const openRecordFilePreview = (location: RecordFileLocation, file: GridFile) =>
  dialogCore.open<void>(
    (close) => <RecordFilePreviewDialog location={location} file={file} close={() => close()} />,
    panelDialogWorkspaceOptions,
  );

export default function RecordFileField(props: {
  tableId: string;
  recordId: string;
  field: Field;
  canWrite: boolean;
  initialFiles: GridFile[];
  endpoint?: string;
  onChanged?: () => void;
}) {
  const [uploading, setUploading] = createSignal(false);
  const [files, setFiles] = createSignal<GridFile[]>(props.initialFiles);

  createEffect(() => setFiles(props.initialFiles));

  const refetch = async () => {
    const res = await fetch(location().endpoint);
    if (!res.ok) throw new Error(await errorMessage(res, "Failed to load files"));
    setFiles(((await res.json()) as { items: GridFile[] }).items);
  };
  const refreshAfterCommittedChange = () =>
    refreshFilesAfterCommittedChange(props.onChanged, refetch, () => {
      prompts.error("The file was changed, but the current file list could not be refreshed.");
    });

  const accept = () => {
    const raw = (props.field.config as { accept?: string[] }).accept;
    return Array.isArray(raw) ? raw.join(",") : undefined;
  };
  const location = (): RecordFileLocation => ({
    endpoint:
      props.endpoint ??
      `/api/grids/records/${encodeURIComponent(props.tableId)}/${encodeURIComponent(props.recordId)}/files/${encodeURIComponent(props.field.id)}`,
  });
  const previewable = (file: GridFile) =>
    canPreviewFile({
      path: file.filename,
      mediaType: file.mimeType,
      size: file.sizeBytes,
    });
  const previewableImages = () => files().filter((file) => file.mimeType.startsWith("image/") && previewable(file));

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const res = props.endpoint
        ? await (() => {
            const form = new FormData();
            form.set("file", file);
            return fetch(location().endpoint, { method: "POST", body: form });
          })()
        : await uploadRecordFile({
            tableId: props.tableId,
            recordId: props.recordId,
            fieldId: props.field.id,
            file,
          });
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to upload file"));
      await refreshAfterCommittedChange();
    } catch (e) {
      prompts.error(e instanceof Error ? e.message : "Failed to upload file");
    } finally {
      setUploading(false);
    }
  };

  const replace = async (current: GridFile, file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(recordFileHref(location(), current), { method: "PUT", body: form });
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to replace file"));
      await refreshAfterCommittedChange();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : "Failed to replace file");
    } finally {
      setUploading(false);
    }
  };

  const chooseFile = async () => {
    if (uploading()) return;
    try {
      await upload(await showFileDialog({ accept: accept() }));
    } catch (error) {
      if (error instanceof Error && (error.message === "File dialog cancelled" || error.message === "No file selected")) {
        return;
      }
      prompts.error(error instanceof Error ? error.message : "Could not open the file picker");
    }
  };

  const chooseReplacement = async (current: GridFile) => {
    if (uploading()) return;
    try {
      await replace(current, await showFileDialog({ accept: accept() }));
    } catch (error) {
      if (error instanceof Error && (error.message === "File dialog cancelled" || error.message === "No file selected")) {
        return;
      }
      prompts.error(error instanceof Error ? error.message : "Could not open the file picker");
    }
  };

  const remove = async (file: GridFile) => {
    const confirmed = await prompts.confirm(recordFileRemovalPrompt(file.filename), {
      title: "Remove attachment?",
      variant: "danger",
      confirmText: "Remove",
    });
    if (!confirmed) return;
    const res = await fetch(recordFileHref(location(), file), { method: "DELETE" });
    if (!res.ok) {
      prompts.error(await errorMessage(res, "Failed to remove attachment"));
      return;
    }
    await refreshAfterCommittedChange();
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={files().length === 0}>
        <span class="text-dimmed">—</span>
      </Show>
      <Show when={files().length > 0}>
        <Show when={previewableImages().length > 0}>
          <div class="flex flex-wrap gap-2">
            <For each={previewableImages()}>
              {(file) => (
                <button
                  type="button"
                  class="grids-record-file-thumbnail relative overflow-hidden rounded-[var(--ui-radius-control)] bg-[var(--k2b-surface-muted)] shadow-xs transition-[background-color,box-shadow] hover:bg-[var(--k2b-hover)] hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                  aria-label={`Preview ${file.filename}`}
                  onClick={() => void openRecordFilePreview(location(), file)}
                >
                  <img src={recordFileContentHref(location(), file, true)} alt="" class="h-full w-full object-cover" loading="lazy" />
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="flex flex-col gap-1">
          <For each={files()}>
            {(file) => (
              <div class="group flex min-w-0 items-center gap-2 py-1 text-sm">
                <i
                  aria-hidden="true"
                  class={`ti ${fileIcons.getFileIcon({
                    name: file.filename,
                    type: "file",
                    mimeType: file.mimeType,
                  })} shrink-0 text-base`}
                />
                <Tooltip.Anchor content={file.filename} class="min-w-0 flex-1">
                  <a
                    class="min-w-0 flex-1 truncate text-secondary transition-colors hover:text-primary"
                    href={recordFileContentHref(location(), file)}
                  >
                    {file.filename}
                  </a>
                </Tooltip.Anchor>
                <span class="shrink-0 text-xs text-dimmed">{text.pprintBytes(file.sizeBytes)}</span>
                <Show when={props.canWrite}>
                  <Tooltip.Anchor content="Replace file">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      class="text-dimmed hover:text-primary"
                      label={`Replace ${file.filename}`}
                      disabled={uploading()}
                      onClick={() => void chooseReplacement(file)}
                    >
                      <i class="ti ti-refresh" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </Show>
                <Show when={previewable(file)}>
                  <Tooltip.Anchor content="Preview file">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      class="text-dimmed hover:text-primary"
                      label={`Preview ${file.filename}`}
                      onClick={() => void openRecordFilePreview(location(), file)}
                    >
                      <i class="ti ti-eye" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </Show>
                <Show when={props.canWrite}>
                  <Tooltip.Anchor content="Remove from record">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      class="text-dimmed hover:text-red-500"
                      label={`Remove ${file.filename} from record`}
                      disabled={uploading()}
                      onClick={() => void remove(file)}
                    >
                      <i class="ti ti-unlink" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.canWrite}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          class="w-fit"
          disabled={uploading()}
          aria-busy={uploading()}
          onClick={() => void chooseFile()}
        >
          <i aria-hidden="true" class={`ti ${uploading() ? "ti-loader-2 animate-spin" : "ti-upload"} text-sm`} />
          Upload
        </Button>
      </Show>
    </div>
  );
}
