/**
 * Attachment picker dialog — opened by `/file` slash command and the
 * footer paperclip button. Single mode: accepts any file type. The
 * `kind` (image vs file) is auto-detected server-side from the MIME
 * type and drives whether the markdown insertion is `![...]()` (block
 * image) or `[...]()` (inline file pill).
 *
 * Selecting (upload OR pick) dispatches `EDITOR_INSERT_ATTACHMENT_EVENT`
 * with {id, kind, filename}. The editor listens, inserts at cursor.
 */

import { fileIcons } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, FileDropzone, prompts, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { EDITOR_INSERT_ATTACHMENT_EVENT } from "../detail/events";
import type { Attachment, AttachmentRef } from "./attachments-client";
import { formatBytes, uploadFile } from "./attachments-client";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  notebookId: string;
  close: () => void;
};

const fetchList = async (notebookId: string, signal: AbortSignal, loadError: (input: { status: number }) => string): Promise<Attachment[]> => {
  const res = await apiClient[":id"].attachments.$get({ param: { id: notebookId } }, { init: { signal } });
  if (!res.ok) throw new Error(loadError({ status: res.status }));
  return await res.json();
};

const dispatchInsert = (att: AttachmentRef) => window.dispatchEvent(new CustomEvent(EDITOR_INSERT_ATTACHMENT_EVENT, { detail: att }));

const AttachmentPicker = (props: Props) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const list = query.create({
    source: () => props.notebookId,
    load: (notebookId, { abortSignal }) => fetchList(notebookId, abortSignal, t().loadAttachmentsFailed),
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const upload = mutation.create<{ uploaded: Attachment[]; error: string | null }, File[]>({
    mutation: async (files, { abortSignal }) => {
      const uploaded: Attachment[] = [];
      // Sequential to keep order + UI feedback simple.
      for (const file of files) {
        try {
          const att = await uploadFile(props.notebookId, file, abortSignal);
          uploaded.push(att);
        } catch (error) {
          if (abortSignal.aborted) throw error;
          return { uploaded, error: error instanceof Error ? error.message : t().uploadFailed };
        }
      }
      return { uploaded, error: null };
    },
    onSuccess: (outcome) => {
      for (const att of outcome.uploaded) {
        dispatchInsert({ id: att.id, kind: att.kind, filename: att.filename });
      }
      if (!outcome.error) {
        props.close();
        return;
      }
      if (outcome.uploaded.length > 0) {
        setReconcileError(null);
        void list.invalidate().catch(() => {
          setReconcileError(t().uploadedReconcileFailed);
        });
      }
    },
  });
  onCleanup(() => upload.abort());

  const handleFiles = (files: File[]) => {
    if (files.length > 0 && !upload.loading()) void upload.mutate([...files]);
  };

  const pick = (att: Attachment) => {
    dispatchInsert({ id: att.id, kind: att.kind, filename: att.filename });
    props.close();
  };

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <FileDropzone
        title={t().attachmentDropTitle}
        subtitle={t().attachmentDropSubtitle}
        hint={t().attachmentLimit}
        busy={upload.loading()}
        onDrop={handleFiles}
      />

      <Show when={upload.error() || upload.data()?.error}>
        <p class="text-xs text-red-600 dark:text-red-400">{upload.error()?.message ?? upload.data()?.error}</p>
      </Show>

      <Show when={reconcileError()}>
        <p class="text-xs text-amber-700 dark:text-amber-300">{reconcileError()}</p>
      </Show>

      <Show when={list.error()}>
        <div class="flex items-center justify-between gap-2 text-xs text-red-600 dark:text-red-400">
          <span>{list.error()!.message}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void list.refresh()} loading={list.refreshing()}>
            {t().retry}
          </Button>
        </div>
      </Show>

      {/* Existing attachments — pick to reuse without re-upload */}
      <Show when={(list.data() ?? []).length > 0}>
        <div class="flex flex-col gap-1.5">
          <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">{t().reuseExisting}</p>
          <ul class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
            <For each={list.data() ?? []}>
              {(att) => (
                <li>
                  <Button type="button" variant="ghost" size="sm" onClick={() => pick(att)} class="w-full justify-start text-left text-xs">
                    <i
                      class={`ti ${fileIcons.getFileIcon({ name: att.filename, type: "file", mimeType: att.mimeType })} text-sm shrink-0`}
                    />
                    <span class="flex-1 truncate">{att.filename}</span>
                    <span class="text-dimmed tabular-nums">{formatBytes(att.sizeBytes)}</span>
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
};

/** Open the picker dialog. Used by `/file` slash command + footer button. */
export const openAttachmentPicker = (notebookId: string, locale = document.documentElement.lang): Promise<void> => {
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return prompts
    .dialog<void>((close) => <AttachmentPicker notebookId={notebookId} close={close} />, { title: t.attach, icon: "ti ti-paperclip" })
    .then(() => undefined);
};
