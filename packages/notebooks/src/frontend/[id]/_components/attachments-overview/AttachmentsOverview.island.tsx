/**
 * Attachments overview — notebook-wide tile grid with per-tile actions
 * (download / copy markdown / delete). Lives at /app/notebooks/<id>/attachments.
 *
 * Images render as actual thumbnails (lazy-loaded), non-image attachments
 * as file-icon tiles in the same grid. KISS: no thumbnail generation
 * server-side — the browser does the work via `<img loading="lazy">` and
 * the API's content endpoint streams the bytea blob with the right
 * Content-Disposition.
 *
 * Delete is the only path that wipes a blob. After delete, broken refs in
 * other notes stay broken by design (KISS — see dex task `vnzej6v5`).
 */

import { fileIcons } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import { IconButton, Placeholder, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebookWorkspaceMessages } from "../../messages";
import {
  type Attachment,
  attachmentMarkdown,
  buildAttachmentContentUrl,
  confirmAndDownload,
  formatBytes,
} from "../editor/attachments-client";

type Props = {
  notebookId: string;
  initial: Attachment[];
  /** Active search query — used to differentiate empty states. */
  searchQuery: string;
};

const AttachmentsOverview = (props: Props) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [items, setItems] = createSignal<Attachment[]>(props.initial);

  const onDownload = (att: Attachment) => void confirmAndDownload(att.filename, buildAttachmentContentUrl(props.notebookId, att.id));

  const onCopy = async (att: Attachment) => {
    try {
      await clipboard.copy(attachmentMarkdown({ id: att.id, kind: att.kind, filename: att.filename }));
      toast.success(t().attachmentMarkdownCopied);
    } catch {
      toast.error(t().attachmentMarkdownCopyFailed);
    }
  };

  const onDelete = async (att: Attachment) => {
    const usageRes = await apiClient[":id"].attachments[":attId"].usage.$get({
      param: { id: props.notebookId, attId: att.id },
    });
    if (!usageRes.ok) {
      await prompts.error(t().attachmentUsageFailed);
      return;
    }
    const { count } = await usageRes.json();

    const message =
      count > 0 ? t().deleteReferencedAttachmentConfirm({ filename: att.filename, count }) : t().deleteAttachmentConfirm({ filename: att.filename });

    const ok = await prompts.confirm(message, {
      title: t().deleteAttachment,
      icon: "ti ti-trash",
      confirmText: t().delete,
      variant: "danger",
    });
    if (!ok) return;

    const delRes = await apiClient[":id"].attachments[":attId"].$delete({
      param: { id: props.notebookId, attId: att.id },
    });
    if (!delRes.ok) {
      const data = (await delRes.json().catch(() => null)) as {
        message?: string;
      } | null;
      await prompts.error(data?.message ?? t().deleteAttachmentFailed);
      return;
    }

    setItems((prev) => prev.filter((a) => a.id !== att.id));
  };

  return (
    <Show
      when={items().length > 0}
      fallback={
        props.searchQuery ? (
          <Placeholder surface="paper" icon="ti ti-paperclip" description={t().noMatchingAttachments({ query: props.searchQuery })} />
        ) : (
          <Placeholder
            surface="paper"
            icon="ti ti-paperclip"
            title={t().noAttachments}
            description={t().noAttachmentsDescription}
          />
        )
      }
    >
      <ul class="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 2xl:grid-cols-16">
        <For each={items()}>
          {(att) => (
            <li class="group relative flex flex-col overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow-surface)]">
              {/* Preview area — fixed square box. Thumbnail / icon sits
                    absolutely inside it so portrait/landscape images can
                    never push the tile out of square (otherwise
                    `aspect-ratio` grows when the intrinsic image is
                    taller than wide). Action buttons overlay on hover —
                    at this tile width the meta row has no room for them. */}
              <div class="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                {att.kind === "image" ? (
                  <img
                    src={buildAttachmentContentUrl(props.notebookId, att.id)}
                    alt={att.filename}
                    loading="lazy"
                    class="absolute inset-0 w-full h-full object-contain"
                  />
                ) : (
                  <div class="absolute inset-0 flex items-center justify-center">
                    <i
                      class={`ti ${fileIcons.getFileIcon({
                        name: att.filename,
                        type: "file",
                        mimeType: att.mimeType,
                      })} text-2xl`}
                    />
                  </div>
                )}

                {/* Hover overlay: download / copy / delete. Sits on the
                      preview so meta row stays clean (filename + size). */}
                <div class="absolute right-1 top-1 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <Tooltip.Anchor content={t().downloadAttachment}>
                    <IconButton
                      label={t().downloadNamedAttachment({ filename: att.filename })}
                      size="xs"
                      onClick={() => onDownload(att)}
                      class="bg-white/90 text-dimmed backdrop-blur-sm dark:bg-zinc-950/80"
                    >
                      <i class="ti ti-download text-xs" />
                    </IconButton>
                  </Tooltip.Anchor>
                  <Tooltip.Anchor content={t().copyAttachmentMarkdown}>
                    <IconButton
                      label={t().copyNamedAttachmentMarkdown({ filename: att.filename })}
                      size="xs"
                      onClick={() => void onCopy(att)}
                      class="bg-white/90 text-dimmed backdrop-blur-sm dark:bg-zinc-950/80"
                    >
                      <i class="ti ti-copy text-xs" />
                    </IconButton>
                  </Tooltip.Anchor>
                  <Tooltip.Anchor content={t().deleteAttachment}>
                    <IconButton
                      label={t().deleteNamedAttachment({ filename: att.filename })}
                      size="xs"
                      variant="danger"
                      onClick={() => void onDelete(att)}
                      class="bg-white/90 backdrop-blur-sm dark:bg-zinc-950/80"
                    >
                      <i class="ti ti-trash text-xs" />
                    </IconButton>
                  </Tooltip.Anchor>
                </div>
              </div>

              {/* Meta — filename + size only. Actions live on the preview. */}
              <div class="flex flex-col gap-0.5 px-1.5 py-1">
                <p class="text-[11px] leading-tight truncate" title={att.filename}>
                  {att.filename}
                </p>
                <p class="text-[10px] text-dimmed tabular-nums">{formatBytes(att.sizeBytes)}</p>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
};

export default AttachmentsOverview;
