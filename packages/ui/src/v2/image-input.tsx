import { createSignal, Show } from "solid-js";
import { useFilePick } from "./behavior/files";
import { Button } from "./button";
import { useControlMessages } from "./control-messages";
import { useField } from "./controls";
import { Icon } from "./marks";

export type ImageInputProps = {
  /** The address of the image (a URL or a data URL); `null` or empty for none. */
  value?: string | null;
  /** The new image, made from the picked file by `transform`, or `null` when it was removed. */
  onChange: (value: string | null) => void;
  /**
   * Turns the picked file into the value. By default a square picture of 512 px as a data URL (as for an avatar or a
   * logo); pass your own to upload the file and return its address.
   */
  transform?: (file: File) => Promise<string>;
  /** The file types to take, like the `accept` attribute; images by default. */
  accept?: string;
  /** A round preview, for a person's picture. */
  round?: boolean;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the picker stands without a Field. */
  label?: string;
  disabled?: boolean;
};

const imageAccept = "image/jpeg,image/png,image/gif,image/webp,image/svg+xml,.jpg,.jpeg,.png,.gif,.webp,.svg";

const squareImage = async (file: File): Promise<string> => {
  const { img } = await import("../inputs/image-tools");
  return img.presets.avatar(file);
};

/**
 * An image to pick: its preview (48 px), a button to choose or change it and one to remove it; a file dropped or
 * pasted on it counts as picked (the behaviour layer on the ui-sdk core). While the file is read, the choose button
 * turns busy; a file that cannot be read says so at the field.
 */
export const ImageInput = (props: ImageInputProps) => {
  const field = useField();
  field?.group();
  const t = useControlMessages();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const value = () => props.value || null;
  // The last pick wins: a file picked while an earlier one is still read replaces it, and the earlier one's value is
  // dropped when it arrives, so the image shown, the value sent and "Bild gewählt" all name the same file.
  let picks = 0;
  const take = async (file: File | undefined) => {
    if (!file) return;
    const mine = ++picks;
    setBusy(true);
    setFailed(false);
    try {
      const made = await (props.transform ?? squareImage)(file);
      if (mine === picks) props.onChange(made);
    } catch {
      if (mine === picks) setFailed(true);
    } finally {
      if (mine === picks) setBusy(false);
    }
  };
  // The file input only picks: it has no name, so a form never sends the file itself, and it is required only while
  // there is no image yet. What the form sends is the value, in a hidden input under the name.
  const pick = useFilePick(() => ({
    accept: props.accept ?? imageAccept,
    // not disabled while a picked file is read: a disabled input is left out of the form's checks, so a required
    // field would let the form go without its image (a second pick meanwhile replaces the first, see `take`)
    disabled: props.disabled,
    required: (field?.required && !value()) || undefined,
    onValueChange: (files: File[]) => void take(files[0]),
    onReject: () => setFailed(true),
    announcement: (change) => (change.added.length ? t().imageChosen : change.rejected.length ? t().imageFailed : null),
  }));
  const name = () => props.name ?? field?.name;
  return (
    <pick.Root class="k2-image" data-k2-part="ImageInput" role={field ? undefined : "group"} aria-label={field ? undefined : props.label}>
      <pick.Dropzone class="k2-image-preview" data-round={props.round ? "" : undefined}>
        <Show when={value()} fallback={<Icon name="photo" />}>
          {(source) => <img src={source()} alt="" />}
        </Show>
      </pick.Dropzone>
      <span class="k2-image-end">
        <pick.Trigger
          class="k2-btn"
          data-k2-part="Button"
          disabled={props.disabled}
          aria-busy={busy() ? "true" : undefined}
          data-busy={busy() ? "" : undefined}
          aria-describedby={field?.described}
        >
          <Icon name={value() ? "pencil" : "photo-plus"} />
          <span class="k2-btn-label">{value() ? t().changeImage : t().chooseImage}</span>
          <Show when={busy()}>
            <span class="k2-btn-busy" aria-hidden="true">
              <Icon name="loader-2" />
            </span>
          </Show>
        </pick.Trigger>
        <Show when={value()}>
          <Button
            variant="ghost"
            icon="trash"
            label={t().removeImage}
            disabled={props.disabled || busy()}
            onClick={() => props.onChange(null)}
          />
        </Show>
      </span>
      <pick.Input />
      <Show when={name()}>{(sent) => <input type="hidden" name={sent()} value={value() ?? ""} disabled={props.disabled} />}</Show>
      <Show when={failed()}>
        <span class="k2-image-failed" role="alert">
          {t().imageFailed}
        </span>
      </Show>
    </pick.Root>
  );
};
