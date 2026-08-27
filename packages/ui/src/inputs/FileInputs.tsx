import { dropzone } from "@k2b/stdlib/solid";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { FieldProps, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import {
  clampImageCropRect,
  getInitialImageCropRect,
  type ImageCropAspect,
  type ImageCropRect,
  type ImageCropResizeHandle,
  type ImageCropRotation,
  type ImageCropSource,
  type ImageCropState,
  resizeImageCropFromCorner,
  rotateImageCropRight,
} from "./image-crop";

export type FileDropzoneProps = FieldProps & {
  accept?: string;
  multiple?: boolean;
  busy?: boolean;
  icon?: string;
  title?: JSX.Element;
  subtitle?: JSX.Element;
  hint?: JSX.Element;
  onDrop: (files: File[]) => void | Promise<void>;
};

export function FileDropzone(props: FileDropzoneProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const disabled = () => Boolean(props.disabled || props.busy);
  const error = () => resolveMaybeAccessor(props.error);
  let input: HTMLInputElement | undefined;
  const emit = (files: File[]) => {
    if (disabled() || files.length === 0) return;
    void props.onDrop(props.multiple === false ? files.slice(0, 1) : files);
  };
  const zone = dropzone.create({
    get accept() {
      return props.accept;
    },
    onDrop: emit,
  });
  const title = () =>
    props.busy
      ? messages().uploading
      : zone.invalidDrag()
        ? messages().fileTypeNotAccepted
        : zone.isDragging()
          ? messages().dropToUpload
          : (props.title ?? messages().dropFiles);

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      required={props.required}
      disabled={disabled()}
    >
      <button
        id={meta.controlId}
        type="button"
        class="k2b-dropzone"
        data-dragging={zone.isDragging() ? "true" : undefined}
        data-invalid={zone.invalidDrag() || error() ? "true" : undefined}
        disabled={disabled()}
        {...fieldControlAria(meta, props)}
        onClick={() => input?.click()}
        {...zone.handlers}
      >
        <span class="k2b-dropzone__icon" aria-hidden="true">
          <i class={props.busy ? "ti ti-loader-2 k2b-spin" : (props.icon ?? "ti ti-cloud-upload")} />
        </span>
        <span class="k2b-dropzone__copy">
          <strong>{title()}</strong>
          <Show
            when={zone.invalidDrag()}
            fallback={
              <Show when={props.subtitle}>
                <span class="k2b-dropzone__subtitle">{props.subtitle}</span>
              </Show>
            }
          >
            <span class="k2b-dropzone__subtitle">{messages().chooseMatchingFile}</span>
          </Show>
          <Show when={props.hint}>
            <span class="k2b-dropzone__hint">{props.hint}</span>
          </Show>
        </span>
      </button>
      <input
        ref={input}
        class="k2b-sr-only"
        type="file"
        aria-label={
          props["aria-label"] ??
          (typeof props.label === "string" ? props.label : props.multiple === false ? messages().chooseFile : messages().chooseFiles)
        }
        accept={props.accept}
        multiple={props.multiple ?? true}
        disabled={disabled()}
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // Reset before emitting so re-picking the same file still fires change,
          // even when onDrop throws.
          event.currentTarget.value = "";
          emit(files);
        }}
      />
    </Field>
  );
}

export type ImageInputProps = ValueFieldProps<string | null> & {
  round?: boolean;
  variant?: "default" | "small";
  transform?: (file: File) => Promise<string>;
  accept?: string;
  fallbackMarker?: string;
};

const DEFAULT_IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/svg+xml,.jpg,.jpeg,.png,.gif,.webp,.svg";

const defaultImageTransform = async (file: File): Promise<string> => {
  const { img } = await import("@k2b/stdlib/browser");
  return img.presets.avatar(file);
};

export function ImageInput(props: ImageInputProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const [busy, setBusy] = createSignal(false);
  const [localError, setLocalError] = createSignal<string>();
  let input: HTMLInputElement | undefined;
  const disabled = () => Boolean(props.disabled || busy() || !props.onValueChange);
  const error = () => resolveMaybeAccessor(props.error) ?? localError();
  const value = () => {
    const current = resolveMaybeAccessor(props.value);
    return current && !current.includes(props.fallbackMarker ?? "?fallback") ? current : null;
  };
  const compact = () => props.variant === "small";
  const changeLabel = () => (value() ? messages().changeImage : messages().addImage);
  const changeIcon = () => (value() ? "ti ti-pencil" : "ti ti-photo-plus");
  const select = async (file: File | undefined) => {
    if (!file || disabled()) return;
    setBusy(true);
    setLocalError();
    try {
      const transformed = await (props.transform ?? defaultImageTransform)(file);
      commitFieldValue(props, transformed);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : messages().imageProcessingFailed);
    } finally {
      setBusy(false);
      if (input) input.value = "";
    }
  };

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      required={props.required}
      disabled={disabled()}
    >
      <div
        class="k2b-image-input"
        data-round={props.round ? "true" : undefined}
        data-variant={props.variant ?? "default"}
        role="group"
        aria-labelledby={props.label ? meta.labelId : undefined}
        aria-label={!props.label ? props["aria-label"] : undefined}
        aria-describedby={fieldControlAria(meta, { ...props, error })["aria-describedby"]}
      >
        <div class="k2b-image-input__preview">
          <Show when={value()} fallback={<i class="ti ti-photo-off" aria-hidden="true" />}>
            {(source) => <img src={source()} alt={typeof props.label === "string" ? props.label : messages().selectedImage} />}
          </Show>
        </div>
        <div class="k2b-image-input__actions">
          <Show
            when={compact()}
            fallback={
              <Button
                variant="secondary"
                loading={busy()}
                loadingLabel={messages().processingImage}
                disabled={disabled()}
                onClick={() => input?.click()}
              >
                <i class={changeIcon()} aria-hidden="true" />
                {value() ? messages().change : messages().add}
              </Button>
            }
          >
            <IconButton
              label={changeLabel()}
              loading={busy()}
              loadingLabel={messages().processingImage}
              disabled={disabled()}
              onClick={() => input?.click()}
            >
              <i class={changeIcon()} aria-hidden="true" />
            </IconButton>
          </Show>
          <Show when={value()}>
            <Show
              when={compact()}
              fallback={
                <Button variant="ghost" disabled={disabled()} onClick={() => commitFieldValue(props, null)}>
                  <i class="ti ti-trash" aria-hidden="true" /> Remove
                </Button>
              }
            >
              <IconButton label={messages().removeImage} disabled={disabled()} onClick={() => commitFieldValue(props, null)}>
                <i class="ti ti-trash" aria-hidden="true" />
              </IconButton>
            </Show>
          </Show>
        </div>
        <input
          ref={input}
          id={meta.controlId}
          class="k2b-sr-only"
          type="file"
          accept={props.accept ?? DEFAULT_IMAGE_ACCEPT}
          disabled={disabled()}
          required={props.required && !value()}
          {...fieldControlAria(meta, { ...props, error })}
          onChange={(event) => void select(event.currentTarget.files?.[0])}
        />
      </div>
    </Field>
  );
}

type PreviewState = {
  url: string;
  objectUrl: boolean;
  sourceWidth: number;
  sourceHeight: number;
};

type DragHandle = "move" | ImageCropResizeHandle;
type DragState = {
  handle: DragHandle;
  pointerId: number;
  startX: number;
  startY: number;
  startCrop: ImageCropRect;
};

export type ImageCropperProps = {
  source: ImageCropSource;
  aspect?: ImageCropAspect;
  previewShape?: "rect" | "circle";
  disabled?: boolean;
  onValueChange?: (state: ImageCropState | null) => void;
  class?: string;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const imageElementReady = async (image: HTMLImageElement): Promise<void> => {
  if (image.complete && image.naturalWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("Failed to load image.")), { once: true });
  });
};

const loadPreviewState = async (source: ImageCropSource): Promise<PreviewState> => {
  const sourceImage =
    source instanceof HTMLImageElement
      ? source
      : Object.assign(new Image(), {
          crossOrigin: source instanceof Blob ? undefined : "anonymous",
          src:
            source instanceof HTMLCanvasElement
              ? source.toDataURL("image/png")
              : source instanceof Blob
                ? URL.createObjectURL(source)
                : source,
        });

  try {
    await imageElementReady(sourceImage);
    return {
      url: source instanceof HTMLImageElement ? source.currentSrc || source.src : sourceImage.src,
      objectUrl: source instanceof Blob,
      sourceWidth: sourceImage.naturalWidth || sourceImage.width,
      sourceHeight: sourceImage.naturalHeight || sourceImage.height,
    };
  } catch (error) {
    if (source instanceof Blob) URL.revokeObjectURL(sourceImage.src);
    throw error;
  }
};

export function ImageCropper(props: ImageCropperProps): JSX.Element {
  const messages = useUiMessages();
  let frame: HTMLDivElement | undefined;
  let activePreview: PreviewState | null = null;
  const aspect = () => props.aspect ?? "free";
  const previewShape = () => props.previewShape ?? "rect";
  const disabled = () => props.disabled ?? false;
  const [preview, setPreview] = createSignal<PreviewState | null>(null);
  const [crop, setCrop] = createSignal<ImageCropRect | null>(null);
  const [rotation, setRotation] = createSignal<ImageCropRotation>(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [drag, setDrag] = createSignal<DragState | null>(null);

  const previewSize = (): { width: number; height: number } | null => {
    const currentPreview = preview();
    if (!currentPreview) return null;
    const swapsDimensions = rotation() === 90 || rotation() === 270;
    return {
      width: swapsDimensions ? currentPreview.sourceHeight : currentPreview.sourceWidth,
      height: swapsDimensions ? currentPreview.sourceWidth : currentPreview.sourceHeight,
    };
  };

  const replacePreview = (next: PreviewState | null) => {
    if (activePreview?.objectUrl) URL.revokeObjectURL(activePreview.url);
    activePreview = next;
    setPreview(next);
  };

  onCleanup(() => {
    if (activePreview?.objectUrl) URL.revokeObjectURL(activePreview.url);
  });

  createEffect(() => {
    props.source;
    setRotation(0);
    setCrop(null);
  });

  createEffect(() => {
    const source = props.source;
    let disposed = false;
    replacePreview(null);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const nextPreview = await loadPreviewState(source);
        if (disposed) {
          if (nextPreview.objectUrl) URL.revokeObjectURL(nextPreview.url);
          return;
        }
        replacePreview(nextPreview);
      } catch {
        if (disposed) return;
        replacePreview(null);
        setCrop(null);
        setError(messages().failedLoadImage);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    onCleanup(() => {
      disposed = true;
    });
  });

  createEffect(() => {
    const currentSize = previewSize();
    const currentAspect = aspect();
    if (!currentSize) return;
    setCrop((current) => clampImageCropRect(current ?? getInitialImageCropRect(currentSize, currentAspect), currentSize, currentAspect));
  });

  createEffect(() => {
    const currentCrop = crop();
    const currentPreview = preview();
    props.onValueChange?.(currentCrop && currentPreview ? { crop: currentCrop, rotation: rotation() } : null);
  });

  const readPointerPosition = (event: PointerEvent) => {
    if (!frame) return { x: 0, y: 0 };
    const rect = frame.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
  };

  const moveCrop = (event: PointerEvent) => {
    const state = drag();
    const currentSize = previewSize();
    if (!state || !currentSize || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = readPointerPosition(event);
    const dx = point.x - state.startX;
    const dy = point.y - state.startY;
    const start = state.startCrop;

    if (state.handle === "move") {
      setCrop(
        clampImageCropRect(
          {
            ...start,
            x: start.x + dx,
            y: start.y + dy,
          },
          currentSize,
          aspect(),
        ),
      );
      return;
    }

    setCrop(resizeImageCropFromCorner(start, currentSize, aspect(), state.handle, dx, dy));
  };

  const endDrag = (event: PointerEvent) => {
    const state = drag();
    if (!state || state.pointerId !== event.pointerId) return;
    window.removeEventListener("pointermove", moveCrop);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    setDrag(null);
  };

  const startDrag = (handle: DragHandle, event: PointerEvent) => {
    const currentCrop = crop();
    if (!currentCrop || disabled()) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    const point = readPointerPosition(event);
    setDrag({
      handle,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      startCrop: currentCrop,
    });
    window.addEventListener("pointermove", moveCrop);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  };

  onCleanup(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", moveCrop);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  });

  const rotateRight = () => {
    if (disabled()) return;
    setRotation((current) => rotateImageCropRight(current));
  };

  const nudgeCrop = (handle: DragHandle, event: KeyboardEvent) => {
    if (disabled() || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const current = crop();
    const currentSize = previewSize();
    if (!current || !currentSize) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    setCrop(
      handle === "move"
        ? clampImageCropRect({ ...current, x: current.x + dx, y: current.y + dy }, currentSize, aspect())
        : resizeImageCropFromCorner(current, currentSize, aspect(), handle, dx, dy),
    );
  };

  const previewFrameStyle = (): JSX.CSSProperties => {
    const currentSize = previewSize();
    if (!currentSize) return {};
    return {
      "aspect-ratio": `${currentSize.width} / ${currentSize.height}`,
      "max-width": `min(100%, calc(min(58vh, 24rem) * ${currentSize.width} / ${currentSize.height}))`,
    };
  };

  const previewImageStyle = (): JSX.CSSProperties => {
    const currentPreview = preview();
    const currentSize = previewSize();
    if (!currentPreview || !currentSize) return {};
    const swapsDimensions = rotation() === 90 || rotation() === 270;
    return {
      left: "50%",
      top: "50%",
      width: swapsDimensions ? `${(currentPreview.sourceWidth / currentSize.width) * 100}%` : "100%",
      height: swapsDimensions ? `${(currentPreview.sourceHeight / currentSize.height) * 100}%` : "100%",
      "max-width": "none",
      "object-fit": "fill",
      transform: `translate(-50%, -50%) rotate(${rotation()}deg)`,
    };
  };

  const cropStyle = (): JSX.CSSProperties => {
    const currentCrop = crop();
    if (!currentCrop) return {};
    return {
      left: `${currentCrop.x * 100}%`,
      top: `${currentCrop.y * 100}%`,
      width: `${currentCrop.width * 100}%`,
      height: `${currentCrop.height * 100}%`,
      "box-shadow": "0 0 0 9999px rgba(0,0,0,.42)",
    };
  };

  const showResizeHandles = () => previewShape() !== "circle";

  return (
    <div class={`k2b-image-cropper ${props.class ?? ""}`}>
      <div class="k2b-image-cropper__stage">
        <Show when={!loading()} fallback={<small>{messages().preparingImage}</small>}>
          <Show when={!error()} fallback={<small class="k2b-image-cropper__error">{error()}</small>}>
            <Show when={preview() && crop()}>
              <div ref={frame} class="k2b-image-cropper__frame" style={previewFrameStyle()}>
                <img src={preview()!.url} alt={messages().cropPreview} draggable={false} style={previewImageStyle()} />
                <div
                  class="k2b-image-cropper__selection"
                  data-shape={previewShape()}
                  style={cropStyle()}
                  role="group"
                  tabIndex={disabled() ? undefined : 0}
                  aria-label={messages().cropArea}
                  onPointerDown={(event) => startDrag("move", event)}
                  onKeyDown={(event) => nudgeCrop("move", event)}
                >
                  <Show when={showResizeHandles()}>
                    <For each={["nw", "ne", "sw", "se"] as const}>
                      {(handle) => (
                        <button
                          type="button"
                          class="k2b-image-cropper__handle"
                          data-handle={handle}
                          aria-label={messages().resizeCrop({ handle })}
                          disabled={disabled()}
                          onPointerDown={(event) => startDrag(handle, event)}
                          onKeyDown={(event) => nudgeCrop(handle, event)}
                        />
                      )}
                    </For>
                  </Show>
                </div>
                <button
                  type="button"
                  class="k2b-image-cropper__rotate"
                  title={messages().rotateRight}
                  aria-label={messages().rotateRight}
                  disabled={disabled() || !crop() || Boolean(error())}
                  onClick={rotateRight}
                >
                  <i class="ti ti-rotate-clockwise" aria-hidden="true" />
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
