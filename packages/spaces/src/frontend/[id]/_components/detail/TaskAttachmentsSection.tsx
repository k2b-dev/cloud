import {
  ButtonLink,
  DetailPanel,
  dialogCore,
  FileDropTarget,
  IconButton,
  IconButtonLink,
  Lightbox,
  type LightboxImage,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Tooltip,
  toast,
  VideoPlayer,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import {
  attachmentMediaType,
  isPlayableVideoType,
  MAX_TASK_ATTACHMENT_SIZE_BYTES,
  MAX_TASK_ATTACHMENTS,
  type SpaceItemAttachment,
} from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

const MAX_IMAGE_LONGEST_SIDE = 2048;
const MEDIA_ACCEPT = "image/*,.svg,video/*,.mov,.m4v";

export default function TaskAttachmentsSection(props: {
  spaceId: string;
  itemId: string;
  attachments: SpaceItemAttachment[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  const [attachments, setAttachments] = createSignal([...props.attachments]);
  const [uploading, setUploading] = createSignal(false);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = createSignal<number | null>(null);

  createEffect(() => {
    props.itemId;
    setAttachments([...props.attachments]);
  });

  const contentUrl = (attachment: SpaceItemAttachment, download = false) =>
    `/api/spaces/${encodeURIComponent(props.spaceId)}/items/${encodeURIComponent(props.itemId)}/attachments/${encodeURIComponent(attachment.id)}/content${download ? "?download=true" : ""}`;
  const isVideo = (attachment: SpaceItemAttachment) => isPlayableVideoType(attachment.mimeType);
  const images = createMemo(() => attachments().filter((attachment) => attachment.kind === "image"));
  /** Images and playable videos, in upload order; other files have no tile. */
  const media = createMemo(() => attachments().filter((attachment) => attachment.kind === "image" || isVideo(attachment)));
  const lightboxImages = createMemo<LightboxImage[]>(() =>
    images().map((attachment) => ({
      src: contentUrl(attachment),
      alt: attachment.filename,
      downloadUrl: contentUrl(attachment, true),
    })),
  );

  const transformImage = async (file: File): Promise<File> => {
    const { img } = await import("@k2b/stdlib/browser");
    const source = await img.create(file);
    const longest = Math.max(source.width, source.height);
    const resized =
      longest > MAX_IMAGE_LONGEST_SIDE
        ? await (source.width >= source.height ? img.resize(MAX_IMAGE_LONGEST_SIDE) : img.resize(undefined, MAX_IMAGE_LONGEST_SIDE))(source)
        : source;
    const base = file.name.replace(/\.[^.]+$/u, "").trim() || "screenshot";
    return img.toFile(`${base}.webp`, "webp", 0.85)(resized);
  };

  /**
   * A video uploads as it is, without transcoding, within the attachment size limit; an image is downscaled first. The
   * picker offers every video, so one that cannot play here says so instead of failing as an image.
   */
  const prepareUpload = async (source: File): Promise<File> => {
    const type = attachmentMediaType(source.name, source.type);
    if (type.startsWith("video/") && !isPlayableVideoType(type)) throw new Error(t.videoTypeUnsupported);
    if (!isPlayableVideoType(type)) return transformImage(source);
    if (source.size > MAX_TASK_ATTACHMENT_SIZE_BYTES)
      throw new Error(t.videoTooLarge({ megabytes: Math.round(MAX_TASK_ATTACHMENT_SIZE_BYTES / 1024 / 1024) }));
    return type === source.type ? source : new File([source], source.name, { type });
  };

  const remaining = () => MAX_TASK_ATTACHMENTS - attachments().length;
  /** Picked or dropped files take the same path: up to the attachment limit, each prepared, then uploaded in order. */
  const uploadMedia = async (selected: readonly File[]) => {
    setUploading(true);
    let changed = false;
    try {
      const room = remaining();
      const failures: { filename: string; message: string }[] = [];

      for (const source of selected.slice(0, room)) {
        try {
          const file = await prepareUpload(source);
          const form = new FormData();
          form.set("file", file);
          const response = await apiClient[":id"].items[":itemId"].attachments.$post(
            { param: { id: props.spaceId, itemId: props.itemId } },
            { init: { body: form } },
          );
          if (!response.ok) throw new Error(await readResponseError(response, t.uploadMediaFailed));
          const attachment = await response.json();
          setAttachments((current) => [...current, attachment]);
          changed = true;
        } catch (error) {
          failures.push({
            filename: source.name,
            message: error instanceof Error ? error.message : t.uploadMediaFailed,
          });
        }
      }

      const firstFailure = failures[0];
      if (failures.length === 1 && firstFailure)
        toast.error(t.addMediaFileFailed({ filename: firstFailure.filename, message: firstFailure.message }));
      else if (failures.length > 1) toast.error(t.addMediaFilesFailed({ count: failures.length }));
    } finally {
      if (changed) props.onChanged();
      setUploading(false);
    }
  };

  const chooseAndUploadMedia = async () => {
    try {
      const { files } = await import("@k2b/stdlib/browser");
      await uploadMedia(await files.showFileDialog({ accept: MEDIA_ACCEPT, multiple: true }));
    } catch (error) {
      if (error instanceof Error && (error.message === "File dialog cancelled" || error.message === "No file selected")) return;
      toast.error(error instanceof Error ? error.message : t.uploadMediaFilesFailed);
    }
  };

  /** A video plays in a dialog of its own, at the size of the screen's work area. */
  const openVideo = (attachment: SpaceItemAttachment) =>
    dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header
            title={attachment.filename}
            actions={
              <IconButtonLink size="sm" href={contentUrl(attachment, true)} download={attachment.filename} label={t.downloadAttachment}>
                <i class="ti ti-download" aria-hidden="true" />
              </IconButtonLink>
            }
            close={() => close()}
          />
          <PanelDialog.Body scrollFade={false}>
            <VideoPlayer
              src={contentUrl(attachment)}
              label={attachment.filename}
              fallbackAction={
                <ButtonLink size="sm" variant="secondary" href={contentUrl(attachment, true)} download={attachment.filename}>
                  <i class="ti ti-download" aria-hidden="true" />
                  {t.downloadAttachment}
                </ButtonLink>
              }
            />
          </PanelDialog.Body>
        </PanelDialog>
      ),
      {
        ...panelDialogWorkspaceOptions,
        panelClassName: `${panelDialogWorkspaceOptions.panelClassName} spaces-video-dialog`,
        // Playback keys work at once: Space plays, the arrows seek.
        initialFocus: (dialog) => dialog.querySelector<HTMLElement>("video"),
      },
    );

  const removeAttachment = async (attachment: SpaceItemAttachment) => {
    const confirmed = await prompts.confirm(t.deleteAttachmentQuestion({ filename: attachment.filename }), {
      title: t.deleteAttachment,
      variant: "danger",
    });
    if (confirmed) await deleteAttachment(props.itemId, attachment);
  };
  const deleteAttachment = async (itemId: string, attachment: SpaceItemAttachment) => {
    setDeletingId(attachment.id);
    try {
      const response = await apiClient[":id"].items[":itemId"].attachments[":attachmentId"].$delete({
        param: { id: props.spaceId, itemId, attachmentId: attachment.id },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.deleteAttachmentFailed));
      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
      props.onChanged();
    } catch (error) {
      retryToast(error instanceof Error ? error.message : t.deleteAttachmentFailed, t.retry, () => deleteAttachment(itemId, attachment));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <DetailPanel.Section title={t.attachments} icon="ti ti-paperclip" tone="neutral" meta={media().length || undefined}>
        <div class="flex flex-col gap-2">
          <Show when={media().length > 0}>
            <div class="flex flex-wrap gap-2">
              <For each={media()}>
                {(attachment) => (
                  <div
                    class="group relative overflow-hidden rounded-[var(--ui-radius-control)] bg-[var(--k2b-surface-muted)] shadow-xs ring-1 ring-[var(--k2b-border)]"
                    style="width:5rem;height:5rem;min-width:5rem;min-height:5rem;flex:0 0 5rem"
                  >
                    <Show
                      when={isVideo(attachment)}
                      fallback={
                        <button
                          type="button"
                          class="absolute inset-0 size-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--k2b-focus-ring)]"
                          aria-label={t.previewAttachment({ filename: attachment.filename })}
                          title={attachment.filename}
                          onClick={() => setLightboxIndex(images().findIndex((image) => image.id === attachment.id))}
                        >
                          <img src={contentUrl(attachment)} alt="" loading="lazy" class="size-full object-contain" />
                        </button>
                      }
                    >
                      {/* The first frame shows what the video is; the browser reads only its start. */}
                      <button
                        type="button"
                        class="absolute inset-0 size-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--k2b-focus-ring)]"
                        aria-label={t.playVideo({ filename: attachment.filename })}
                        title={attachment.filename}
                        onClick={() => openVideo(attachment)}
                      >
                        <video
                          src={`${contentUrl(attachment)}#t=0.001`}
                          class="pointer-events-none size-full object-contain"
                          preload="metadata"
                          muted
                          playsinline
                          tabIndex={-1}
                          aria-hidden="true"
                        />
                        <span class="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
                          <span class="grid size-7 place-items-center rounded-full bg-black/55 text-white">
                            <i class="ti ti-player-play-filled text-sm" />
                          </span>
                        </span>
                      </button>
                    </Show>
                    <Show when={props.canWrite}>
                      <div class="absolute right-1 top-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                        <Tooltip.Anchor content={t.deleteAttachment}>
                          <IconButton
                            label={t.deleteAttachmentNamed({ filename: attachment.filename })}
                            size="xs"
                            class="bg-white/90 text-dimmed backdrop-blur-sm dark:bg-zinc-950/80"
                            disabled={deletingId() !== null}
                            onClick={() => void removeAttachment(attachment)}
                          >
                            <i class="ti ti-trash text-xs" aria-hidden="true" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.canWrite}>
            {/* Images and videos dropped anywhere on the open task attach to it. */}
            <FileDropTarget
              label={t.dropToAttachMedia}
              accept={MEDIA_ACCEPT}
              maxFiles={remaining()}
              disabled={uploading() || remaining() <= 0}
              onDrop={(files) => void uploadMedia(files)}
            />
          </Show>
          <Show when={props.canWrite && attachments().length < MAX_TASK_ATTACHMENTS}>
            <DetailPanel.Action
              type="button"
              onClick={() => void chooseAndUploadMedia()}
              disabled={uploading() || deletingId() !== null}
              leading={<i class={`ti ${uploading() ? "ti-loader-2 animate-spin" : "ti-photo-plus"}`} aria-hidden="true" />}
              title={uploading() ? t.addingMedia : t.addMedia}
            />
          </Show>
        </div>
      </DetailPanel.Section>
      <Show when={lightboxIndex() !== null}>
        <Lightbox images={lightboxImages()} initialIndex={lightboxIndex() ?? 0} onClose={() => setLightboxIndex(null)} />
      </Show>
    </>
  );
}
