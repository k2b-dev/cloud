import { DetailPanel, IconButton, Lightbox, type LightboxImage, prompts, Tooltip, toast } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { MAX_TASK_ATTACHMENTS, type SpaceItemAttachment } from "@/contracts";
import { readResponseError } from "../../../lib/response";

const MAX_IMAGE_LONGEST_SIDE = 2048;

export default function TaskAttachmentsSection(props: {
  spaceId: string;
  itemId: string;
  attachments: SpaceItemAttachment[];
  canWrite: boolean;
  onChanged: () => void;
}) {
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
  const images = createMemo(() => attachments().filter((attachment) => attachment.kind === "image"));
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

  const chooseAndUploadImage = async () => {
    setUploading(true);
    let changed = false;
    try {
      const { files } = await import("@k2b/stdlib/browser");
      const selected = await files.showFileDialog({ accept: "image/*,.svg", multiple: true });
      const remaining = MAX_TASK_ATTACHMENTS - attachments().length;
      const failures: { filename: string; message: string }[] = [];

      for (const source of selected.slice(0, remaining)) {
        try {
          const file = await transformImage(source);
          const form = new FormData();
          form.set("file", file);
          const response = await apiClient[":id"].items[":itemId"].attachments.$post(
            { param: { id: props.spaceId, itemId: props.itemId } },
            { init: { body: form } },
          );
          if (!response.ok) throw new Error(await readResponseError(response, "Failed to upload image"));
          const attachment = await response.json();
          setAttachments((current) => [...current, attachment]);
          changed = true;
        } catch (error) {
          failures.push({
            filename: source.name,
            message: error instanceof Error ? error.message : "Failed to upload image",
          });
        }
      }

      const firstFailure = failures[0];
      if (failures.length === 1 && firstFailure) toast.error(`Could not add ${firstFailure.filename}: ${firstFailure.message}`);
      else if (failures.length > 1) toast.error(`${failures.length} images could not be added`);
    } catch (error) {
      if (error instanceof Error && (error.message === "File dialog cancelled" || error.message === "No file selected")) return;
      toast.error(error instanceof Error ? error.message : "Failed to upload images");
    } finally {
      if (changed) props.onChanged();
      setUploading(false);
    }
  };

  const removeAttachment = async (attachment: SpaceItemAttachment) => {
    const confirmed = await prompts.confirm(`Delete "${attachment.filename}"?`, {
      title: "Delete attachment",
      variant: "danger",
    });
    if (!confirmed) return;
    setDeletingId(attachment.id);
    try {
      const response = await apiClient[":id"].items[":itemId"].attachments[":attachmentId"].$delete({
        param: { id: props.spaceId, itemId: props.itemId, attachmentId: attachment.id },
      });
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to delete attachment"));
      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
      props.onChanged();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : "Failed to delete attachment");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <DetailPanel.Section title="Attachments" icon="ti ti-paperclip" tone="neutral" meta={images().length || undefined}>
        <div class="flex flex-col gap-2">
          <Show when={images().length > 0}>
            <div class="flex flex-wrap gap-2">
              <For each={images()}>
                {(attachment) => (
                  <div
                    class="group relative overflow-hidden rounded-[var(--ui-radius-control)] bg-[var(--k2b-surface-muted)] shadow-xs ring-1 ring-[var(--k2b-border)]"
                    style="width:5rem;height:5rem;min-width:5rem;min-height:5rem;flex:0 0 5rem"
                  >
                    <button
                      type="button"
                      class="absolute inset-0 size-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--k2b-focus-ring)]"
                      aria-label={`Preview ${attachment.filename}`}
                      title={attachment.filename}
                      onClick={() => setLightboxIndex(images().findIndex((image) => image.id === attachment.id))}
                    >
                      <img src={contentUrl(attachment)} alt="" loading="lazy" class="size-full object-contain" />
                    </button>
                    <Show when={props.canWrite}>
                      <div class="absolute right-1 top-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                        <Tooltip.Anchor content="Delete attachment">
                          <IconButton
                            label={`Delete ${attachment.filename}`}
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
          <Show when={props.canWrite && attachments().length < MAX_TASK_ATTACHMENTS}>
            <DetailPanel.Action
              type="button"
              onClick={() => void chooseAndUploadImage()}
              disabled={uploading() || deletingId() !== null}
              leading={<i class={`ti ${uploading() ? "ti-loader-2 animate-spin" : "ti-photo-plus"}`} aria-hidden="true" />}
              title={uploading() ? "Adding image..." : "Add image"}
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
