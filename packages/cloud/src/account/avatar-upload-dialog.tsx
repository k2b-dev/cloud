import { Button, dialogCore, FileDropzone, ImageCropper, type ImageCropState, PanelDialog, panelDialogOptions } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { CloudAvatar } from "./Avatar";
import { createAvatarDataUrlFromFile, validateAvatarSourceFile } from "./avatar-upload";

export type AvatarUploadDialogOptions = {
  username: string;
  userId?: string | null;
  avatarHash?: string | null;
  title?: string;
  subtitle?: string;
  visibilityText?: string;
  saveLabel?: string;
  messages?: Partial<{
    processFailed: string;
    typeInvalid: string;
    tooLarge: string;
    empty: string;
    unsupported: string;
    compressionFailed: string;
    saveFailed: string;
    removeFailed: string;
    replaceDrop: string;
    chooseDrop: string;
    cropHint: string;
    removing: string;
    remove: string;
    removeAria: string;
    cancel: string;
    saving: string;
  }>;
  onSave: (dataUrl: string) => Promise<void> | void;
  onRemove?: () => Promise<void> | void;
};

const avatarErrorMessage = (error: unknown, messages?: AvatarUploadDialogOptions["messages"]): string => {
  if (!(error instanceof Error)) return messages?.processFailed ?? "Failed to process avatar image.";
  if (error.message === "Choose a PNG, JPEG, or WebP image.") return messages?.typeInvalid ?? error.message;
  if (error.message === "Choose an image smaller than 32 MB.") return messages?.tooLarge ?? error.message;
  if (error.message === "Avatar image is empty.") return messages?.empty ?? error.message;
  if (error.message === "Avatar image processing is not supported in this browser.") return messages?.unsupported ?? error.message;
  if (error.message.includes("could not be compressed")) {
    return messages?.compressionFailed ?? "This image could not be prepared as a small avatar. Try a simpler image.";
  }
  return messages?.processFailed ?? "Failed to process avatar image.";
};

function AvatarUploadDialog(props: AvatarUploadDialogOptions & { close: (saved?: boolean) => void }) {
  const [sourceFile, setSourceFile] = createSignal<File | null>(null);
  const [cropState, setCropState] = createSignal<ImageCropState | null>(null);
  const [processing, setProcessing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [removing, setRemoving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const busy = () => processing() || saving() || removing();

  const handleFiles = async (files: File[]) => {
    const file = files[0];
    if (!file || busy()) return;
    setProcessing(true);
    setError(null);
    try {
      validateAvatarSourceFile(file);
      setSourceFile(file);
      setCropState(null);
    } catch (err) {
      setSourceFile(null);
      setCropState(null);
      setError(avatarErrorMessage(err, props.messages));
    } finally {
      setProcessing(false);
    }
  };

  const handleSave = async () => {
    const file = sourceFile();
    const crop = cropState();
    if (!file || !crop || busy()) return;
    setSaving(true);
    setError(null);
    try {
      const nextAvatar = await createAvatarDataUrlFromFile(file, crop);
      await props.onSave(nextAvatar);
      props.close(true);
    } catch (err) {
      setError(
        avatarErrorMessage(err, {
          ...props.messages,
          processFailed: props.messages?.saveFailed ?? "Failed to save avatar.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!props.avatarHash || !props.onRemove || busy()) return;
    setRemoving(true);
    setError(null);
    try {
      await props.onRemove();
      props.close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : (props.messages?.removeFailed ?? "Failed to remove avatar."));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.title ?? "Change Avatar"}
        subtitle={props.subtitle ?? "Choose a profile picture and review it before saving."}
        icon="ti ti-user-circle"
        close={() => props.close(false)}
      />
      <PanelDialog.Body>
        <div class="flex flex-col items-center gap-4 px-5 py-6">
          <Show
            when={sourceFile()}
            fallback={
              <CloudAvatar
                username={props.username}
                userId={props.userId}
                avatarHash={props.avatarHash}
                size="xl"
                class="h-28 w-28 rounded-full text-2xl shadow-[var(--ui-shadow-surface)]"
              />
            }
          >
            <div class="w-full max-w-md">
              <ImageCropper
                source={sourceFile()!}
                aspect={{ width: 1, height: 1 }}
                previewShape="circle"
                disabled={busy()}
                onValueChange={setCropState}
              />
            </div>
          </Show>
          <p class="max-w-md text-center text-xs text-dimmed">
            {props.visibilityText ?? "Profile pictures are visible to all account holders."}
          </p>
          <div class="w-full max-w-xl">
            <FileDropzone
              accept="image/png,image/jpeg,image/webp"
              multiple={false}
              disabled={saving() || removing()}
              busy={processing()}
              error={error}
              icon="ti-photo-plus"
              title={
                sourceFile()
                  ? (props.messages?.replaceDrop ?? "Drop another image or click to replace")
                  : (props.messages?.chooseDrop ?? "Drop image or click to choose")
              }
              subtitle="PNG, JPEG, or WebP"
              hint={props.messages?.cropHint ?? "Adjust the crop, then save."}
              onDrop={handleFiles}
            />
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="min-w-0">
          <Show when={props.avatarHash && props.onRemove}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRemove}
              disabled={busy()}
              aria-label={props.messages?.removeAria ?? "Remove current avatar"}
            >
              <i class="ti ti-user-x" aria-hidden="true" />
              {removing() ? (props.messages?.removing ?? "Removing...") : (props.messages?.remove ?? "Remove Avatar")}
            </Button>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => props.close(false)} disabled={saving() || removing()}>
            {props.messages?.cancel ?? "Cancel"}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={handleSave} disabled={!sourceFile() || !cropState() || busy()}>
            {saving() ? (props.messages?.saving ?? "Saving...") : (props.saveLabel ?? "Save Avatar")}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAvatarUploadDialog = (options: AvatarUploadDialogOptions): Promise<boolean> =>
  dialogCore
    .open<boolean>((close) => <AvatarUploadDialog {...options} close={(saved) => close(Boolean(saved))} />, panelDialogOptions)
    .then(Boolean);
