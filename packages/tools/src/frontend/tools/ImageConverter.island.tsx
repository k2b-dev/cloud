import { clipboard as browserClipboard, files as fileTools, images as imageTools, type ImgData } from "@k2b/stdlib/browser";
import { dropzone, mutation } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  Checkbox,
  ColorInput,
  DetailPanel,
  FileDropzone,
  IconButton,
  NoticeCard,
  NumberInput,
  ProgressBar,
  prompts,
  SegmentedControl,
  Slider,
  SplitButton,
  toast,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  buildBase64ImageTag,
  fitWithin,
  type ImageConverterFormat,
  type ImageConverterRotation,
  nextClockwiseRotation,
  rotatedDimensions,
  uniqueOutputNames,
} from "./image-converter/image-converter";
import { imageConverterMessages } from "./image-converter/messages";

const IMAGE_ACCEPT = "image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg,.avif,.heic,.heif";

export type ImageConverterEntry = {
  id: string;
  file: File;
  previewUrl: string;
  width: number;
  height: number;
  rotation: ImageConverterRotation;
  selected: boolean;
};

type ImageConverterViewProps = {
  readonly initialImages?: readonly ImageConverterEntry[];
};

type ExportScope = "all" | "selected";
type ExportDestination = "download" | "clipboard";
type ExportRequest = { scope: ExportScope; destination: ExportDestination };
type ExportResult = { destination: ExportDestination; message: string };

let nextImageId = 0;
const imageId = () => `image-converter-${++nextImageId}`;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const sourceFormat = (file: File): string => {
  const mimeFormat = file.type.replace(/^image\//u, "").replace("svg+xml", "svg");
  if (mimeFormat) return mimeFormat.toUpperCase();
  return file.name.split(".").at(-1)?.toUpperCase() || "IMAGE";
};

const rotateImage = (data: ImgData, rotation: ImageConverterRotation): Promise<ImgData> => {
  if (rotation === 0) return Promise.resolve(data);
  return imageTools.rotate(rotation)(data);
};

/** @internal Render seam for focused SSR tests; the route-facing island remains zero-prop. */
export function ImageConverterView(props: ImageConverterViewProps = {}) {
  const locale = useLocale();
  const t = () => imageConverterMessages.resolve([locale()]).t;
  const [images, setImages] = createSignal<ImageConverterEntry[]>([...(props.initialImages ?? [])]);
  const [format, setFormat] = createSignal<ImageConverterFormat>("webp");
  const [quality, setQuality] = createSignal(0.85);
  const [jpegBackground, setJpegBackground] = createSignal("#ffffff");
  const [maxWidth, setMaxWidth] = createSignal<number | null>(null);
  const [maxHeight, setMaxHeight] = createSignal<number | null>(null);
  const [progress, setProgress] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [exportLocked, setExportLocked] = createSignal(false);
  const managedPreviewUrls = new Set<string>();

  const selectedCount = createMemo(() => images().filter((image) => image.selected).length);
  const hasSelection = createMemo(() => selectedCount() > 0);
  const allSelected = createMemo(() => images().length > 0 && selectedCount() === images().length);

  const loadImage = async (file: File): Promise<ImageConverterEntry> => {
    const previewUrl = URL.createObjectURL(file);
    managedPreviewUrls.add(previewUrl);
    const preview = new Image();
    preview.decoding = "async";

    try {
      await new Promise<void>((resolve, reject) => {
        preview.onload = () => resolve();
        preview.onerror = () => reject(new Error(t().decodeFailed));
        preview.src = previewUrl;
      });
      if (preview.naturalWidth < 1 || preview.naturalHeight < 1) throw new Error(t().noDimensions);
      return {
        id: imageId(),
        file,
        previewUrl,
        width: preview.naturalWidth,
        height: preview.naturalHeight,
        rotation: 0,
        selected: false,
      };
    } catch (cause) {
      managedPreviewUrls.delete(previewUrl);
      URL.revokeObjectURL(previewUrl);
      throw cause;
    }
  };

  const loadMutation = mutation.create<void, File[]>({
    mutation: async (files, { abortSignal }) => {
      const loaded: ImageConverterEntry[] = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          loaded.push(await loadImage(file));
          abortSignal.throwIfAborted();
        } catch (cause) {
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : t().loadFallback}`);
        }
      }

      abortSignal.throwIfAborted();
      if (loaded.length > 0) setImages((current) => [...current, ...loaded]);
      if (failures.length > 0) {
        setError(`${t().imagesSkipped({ count: failures.length })} ${failures[0]}`);
      }
      if (loaded.length === 0 && failures.length > 0) throw new Error(failures[0]);
    },
    onBefore: () => {
      setError("");
      setSuccess("");
    },
    onError: (cause) => setError(cause.message),
  });

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (loadMutation.loading()) {
      setError(t().waitForLoading);
      return;
    }
    if (exportLocked()) {
      setError(t().waitForExport);
      return;
    }
    void loadMutation.mutate(files);
  };

  const workspaceDropzone = dropzone.create({ accept: IMAGE_ACCEPT, onDrop: addFiles });

  const selectFiles = async () => {
    try {
      const selected = await fileTools.showFileDialog({ accept: IMAGE_ACCEPT, multiple: true });
      addFiles(selected);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "File dialog cancelled") return;
      setError(cause instanceof Error ? cause.message : t().pickerFailed);
    }
  };

  const releasePreview = (previewUrl: string) => {
    if (!managedPreviewUrls.delete(previewUrl)) return;
    URL.revokeObjectURL(previewUrl);
  };

  const removeImage = (id: string) => {
    const image = images().find((entry) => entry.id === id);
    if (image) releasePreview(image.previewUrl);
    setImages((current) => current.filter((entry) => entry.id !== id));
  };

  const clearImages = async () => {
    const confirmed = await prompts.confirm(t().clearConfirm({ count: images().length }), {
      title: t().clearConfirmTitle,
      icon: "ti ti-trash",
      confirmText: t().clearConfirmAction,
      variant: "danger",
    });
    if (!confirmed) return;
    for (const image of images()) releasePreview(image.previewUrl);
    setImages([]);
    setError("");
    setSuccess("");
  };

  const toggleImage = (id: string, selected: boolean) =>
    setImages((current) => current.map((image) => (image.id === id ? { ...image, selected } : image)));

  const toggleAll = (selected: boolean) => setImages((current) => current.map((image) => ({ ...image, selected })));

  const rotateClockwise = (id: string) =>
    setImages((current) =>
      current.map((image) => (image.id === id ? { ...image, rotation: nextClockwiseRotation(image.rotation) } : image)),
    );

  const processImage = async (
    entry: ImageConverterEntry,
    outputFormat: ImageConverterFormat,
    outputQuality: number,
    outputBackground: string,
    widthLimit: number | null,
    heightLimit: number | null,
    destination: ExportDestination,
  ): Promise<{ data: ImgData; blob?: Blob; dataUrl?: string }> => {
    let data = await imageTools.create(entry.file);
    data = await rotateImage(data, entry.rotation);
    const fitted = fitWithin(data.width, data.height, widthLimit, heightLimit);
    if (fitted.width !== data.width || fitted.height !== data.height) {
      data = await imageTools.resize(fitted.width, fitted.height, "fill")(data);
    }
    if (outputFormat === "jpeg") {
      data = await imageTools.resize(data.width, data.height, "contain", outputBackground)(data);
    }

    if (destination === "clipboard") {
      return { data, dataUrl: await imageTools.toBase64(outputFormat, outputQuality)(data) };
    }
    return { data, blob: await imageTools.toBlob(outputFormat, outputQuality)(data) };
  };

  const exportMutation = mutation.create<ExportResult, ExportRequest>({
    mutation: async ({ scope, destination }, { abortSignal }) => {
      const targets = scope === "selected" ? images().filter((image) => image.selected) : images();
      if (targets.length === 0) throw new Error(t().selectAtLeastOne);

      const outputFormat = format();
      const outputQuality = quality();
      const outputBackground = jpegBackground();
      const widthLimit = maxWidth();
      const heightLimit = maxHeight();
      const outputNames = uniqueOutputNames(
        targets.map((image) => image.file.name),
        outputFormat,
      );
      const blobs: { filename: string; source: Blob }[] = [];
      const tags: string[] = [];

      setProgress(0);
      for (let index = 0; index < targets.length; index += 1) {
        abortSignal.throwIfAborted();
        const target = targets[index]!;
        const result = await processImage(target, outputFormat, outputQuality, outputBackground, widthLimit, heightLimit, destination);
        abortSignal.throwIfAborted();
        if (destination === "clipboard") {
          if (!result.dataUrl) throw new Error(t().encodeFailed({ name: target.file.name }));
          tags.push(buildBase64ImageTag(result.dataUrl, target.file.name, result.data));
        } else {
          if (!result.blob) throw new Error(t().convertFailed({ name: target.file.name }));
          blobs.push({ filename: outputNames[index]!, source: result.blob });
        }
        setProgress(((index + 1) / targets.length) * (targets.length > 1 && destination === "download" ? 80 : 100));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      abortSignal.throwIfAborted();
      if (destination === "clipboard") {
        await browserClipboard.copy(tags.join("\n"));
        setProgress(100);
        return {
          destination,
          message: t().copiedTags({ count: targets.length }),
        };
      }

      if (blobs.length === 1) {
        const output = blobs[0]!;
        fileTools.downloadFileFromContent(output.source, output.filename, output.source.type);
      } else {
        await fileTools.downloadAsZip(blobs, "converted-images.zip", {
          onProgress: ({ percent }) => setProgress(80 + percent * 20),
        });
      }
      setProgress(100);
      return {
        destination,
        message: t().downloadedImages({ count: targets.length }),
      };
    },
    onBefore: () => {
      setExportLocked(true);
      setProgress(null);
      setError("");
      setSuccess("");
    },
    onSuccess: ({ destination, message }) => {
      if (destination === "clipboard") {
        toast.success(message, { title: t().copiedToClipboard });
        return;
      }
      setSuccess(message);
    },
    onError: (cause) => setError(cause.message),
    onFinally: () => setExportLocked(false),
  });

  const startExport = (scope: ExportScope, destination: ExportDestination) => {
    if (!loadMutation.loading() && !exportMutation.loading()) void exportMutation.mutate({ scope, destination });
  };

  onCleanup(() => {
    loadMutation.abort();
    exportMutation.abort();
    for (const previewUrl of managedPreviewUrls) URL.revokeObjectURL(previewUrl);
    managedPreviewUrls.clear();
  });

  return (
    <>
      <AppWorkspace.Main class="tools-main" scroll={false}>
        <section
          class="tools-image-converter relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ui-surface)]"
          data-dragging={workspaceDropzone.isDragging() ? "true" : undefined}
          data-invalid-drag={workspaceDropzone.invalidDrag() ? "true" : undefined}
          aria-label={t().workspaceLabel}
          {...workspaceDropzone.handlers}
        >
          <header class="flex flex-none flex-wrap items-center justify-between gap-3 px-[var(--ui-space-shell)] py-[var(--ui-space-section)]">
            <div class="min-w-0">
              <h1 class="text-base font-semibold text-primary">{t().heading}</h1>
              <p class="text-xs text-dimmed">
                {images().length === 0 ? t().emptySubtitle : t().imageCount({ count: images().length })}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <Show when={images().length > 0}>
                <Button variant="secondary" size="sm" onClick={selectFiles} disabled={loadMutation.loading() || exportMutation.loading()}>
                  <i class="ti ti-photo-plus" aria-hidden="true" /> {t().addImages}
                </Button>
                <Button variant="ghost" size="sm" onClick={clearImages} disabled={loadMutation.loading() || exportMutation.loading()}>
                  {t().clearAll}
                </Button>
              </Show>
            </div>
          </header>

          <Show
            when={images().length > 0}
            fallback={
              <div class="flex min-h-80 flex-1 items-center justify-center p-[var(--ui-space-shell)]">
                <FileDropzone
                  class="w-full max-w-xl"
                  aria-label={t().dropzoneLabel}
                  accept={IMAGE_ACCEPT}
                  multiple
                  busy={loadMutation.loading() || exportLocked()}
                  title={t().dropzoneTitle}
                  subtitle={t().dropzoneSubtitle}
                  hint={t().dropzoneHint}
                  icon="ti ti-photo-plus"
                  onDrop={addFiles}
                />
              </div>
            }
          >
            <div class="flex flex-none items-center justify-between gap-3 px-[var(--ui-space-shell)] py-2">
              <Checkbox
                label={t().selectAll}
                value={allSelected}
                indeterminate={hasSelection() && !allSelected()}
                disabled={loadMutation.loading() || exportMutation.loading()}
                onValueChange={toggleAll}
              />
              <Show when={hasSelection()}>
                <span class="text-xs tabular-nums text-dimmed">{t().selectedCount({ count: selectedCount() })}</span>
              </Show>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto p-[var(--ui-space-shell)]">
              <div
                class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-[var(--ui-space-section)]"
                role="list"
                aria-label={t().listLabel}
              >
                <For each={images()}>
                  {(image) => {
                    const dimensions = () => rotatedDimensions(image.width, image.height, image.rotation);
                    return (
                      <article
                        class="tools-image-converter-card group min-w-0 overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]"
                        role="listitem"
                        data-selected={image.selected ? "true" : undefined}
                        data-selection-active={hasSelection() ? "true" : undefined}
                      >
                        <div class="tools-image-converter-card__preview relative aspect-square overflow-hidden bg-[var(--ui-surface)] p-3">
                          <img
                            src={image.previewUrl}
                            alt={t().previewAlt({ name: image.file.name })}
                            class="h-full w-full object-contain transition-transform"
                            style={{ transform: `rotate(${image.rotation}deg)` }}
                            draggable={false}
                          />
                          <div class="tools-image-converter-card__selection absolute left-2 top-2">
                            <Checkbox
                              aria-label={t().selectImage({ name: image.file.name })}
                              value={image.selected}
                              disabled={loadMutation.loading() || exportMutation.loading()}
                              onValueChange={(selected) => toggleImage(image.id, selected)}
                            />
                          </div>
                          <div class="tools-image-converter-card__actions absolute right-2 top-2 flex gap-1">
                            <Tooltip.Anchor content={t().rotateClockwise}>
                              <IconButton
                                label={t().rotateImageClockwise({ name: image.file.name })}
                                size="sm"
                                onClick={() => rotateClockwise(image.id)}
                                disabled={loadMutation.loading() || exportMutation.loading()}
                              >
                                <i class="ti ti-rotate-clockwise" aria-hidden="true" />
                              </IconButton>
                            </Tooltip.Anchor>
                            <Tooltip.Anchor content={t().removeImage}>
                              <IconButton
                                label={t().removeNamed({ name: image.file.name })}
                                size="sm"
                                class="text-red-600 dark:text-red-400"
                                onClick={() => removeImage(image.id)}
                                disabled={loadMutation.loading() || exportMutation.loading()}
                              >
                                <i class="ti ti-trash" aria-hidden="true" />
                              </IconButton>
                            </Tooltip.Anchor>
                          </div>
                        </div>
                        <div class="min-w-0 border-t border-[var(--ui-border)] px-3 py-2">
                          <p class="truncate text-sm font-medium text-primary" title={image.file.name}>
                            {image.file.name}
                          </p>
                          <p class="truncate text-xs tabular-nums text-dimmed">
                            {sourceFormat(image.file)} · {dimensions().width} × {dimensions().height} px · {formatBytes(image.file.size)}
                          </p>
                        </div>
                      </article>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>

          <Show when={workspaceDropzone.isDragging()}>
            <div
              class="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-[var(--ui-radius-surface)] border-2 border-dashed border-[var(--app-accent)] bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--ui-surface))]"
              role="status"
            >
              <div class="flex flex-col items-center gap-2 text-center app-accent-text">
                <i class={workspaceDropzone.invalidDrag() ? "ti ti-file-x text-3xl" : "ti ti-photo-plus text-3xl"} aria-hidden="true" />
                <strong>{workspaceDropzone.invalidDrag() ? t().invalidDrag : t().dropToAdd}</strong>
              </div>
            </div>
          </Show>
        </section>
      </AppWorkspace.Main>

      <AppWorkspace.Detail
        id="image-converter-settings"
        open={images().length > 0}
        width="md"
        minWidth={288}
        viewTransitionName="tools-image-converter-settings"
      >
        <DetailPanel>
          <DetailPanel.Header
            icon="ti ti-arrows-exchange"
            title={t().panelTitle}
            subtitle={images().length > 0 ? t().imagesReady({ count: images().length }) : t().panelEmpty}
          />

          <DetailPanel.Body scrollPreserveKey="image-converter-settings">
            <DetailPanel.Group label={t().groupOutput}>
              <DetailPanel.Section title={t().sectionFormat} icon="ti ti-photo" tone="neutral">
                <SegmentedControl<ImageConverterFormat>
                  options={[
                    { value: "jpeg", label: "JPEG" },
                    { value: "png", label: "PNG" },
                    { value: "webp", label: "WebP" },
                  ]}
                  value={format}
                  onValueChange={setFormat}
                  ariaLabel={t().targetFormat}
                  disabled={exportMutation.loading()}
                />
                <Show when={format() !== "png"}>
                  <div class="mt-3">
                    <Slider
                      label={t().quality}
                      value={quality}
                      onValueChange={setQuality}
                      min={0.1}
                      max={1}
                      step={0.05}
                      formatValue={(value) => `${Math.round(value * 100)}%`}
                      disabled={exportMutation.loading()}
                    />
                  </div>
                </Show>
                <Show when={format() === "jpeg"}>
                  <div class="mt-3">
                    <ColorInput
                      label={t().transparencyBackground}
                      description={t().transparencyDescription}
                      value={jpegBackground}
                      onValueChange={setJpegBackground}
                      disabled={exportMutation.loading()}
                    />
                  </div>
                </Show>
              </DetailPanel.Section>
            </DetailPanel.Group>

            <DetailPanel.Group label={t().groupSize}>
              <DetailPanel.Section
                title={t().maxDimensions}
                icon="ti ti-arrows-maximize"
                tone="neutral"
                description={t().maxDimensionsDescription}
              >
                <div class="grid grid-cols-2 gap-2">
                  <NumberInput
                    name="image-converter-max-width"
                    label={t().maxWidth}
                    placeholder={t().original}
                    suffix="px"
                    value={maxWidth}
                    onValueChange={setMaxWidth}
                    min={1}
                    allowNegative={false}
                    showSteppers={false}
                    clearable
                    disabled={exportMutation.loading()}
                  />
                  <NumberInput
                    name="image-converter-max-height"
                    label={t().maxHeight}
                    placeholder={t().original}
                    suffix="px"
                    value={maxHeight}
                    onValueChange={setMaxHeight}
                    min={1}
                    allowNegative={false}
                    showSteppers={false}
                    clearable
                    disabled={exportMutation.loading()}
                  />
                </div>
              </DetailPanel.Section>
            </DetailPanel.Group>

            <Show when={error()}>
              <NoticeCard tone="danger" title={t().conversionFailed} detail={error()} />
            </Show>
            <Show when={success()}>
              <NoticeCard tone="success" title={success()} />
            </Show>
            <Show when={progress() !== null}>
              <ProgressBar value={progress() ?? 0} label={t().exportProgress} size="sm" showValue />
            </Show>
          </DetailPanel.Body>

          <Show when={images().length > 0}>
            <footer class="tools-image-converter-export flex flex-none flex-col gap-2">
              <Show when={hasSelection()}>
                <SplitButton
                  variant="secondary"
                  size="sm"
                  onClick={() => startExport("all", "download")}
                  items={[
                    {
                      label: t().copyAllBase64({ count: images().length }),
                      icon: "ti ti-copy",
                      action: () => startExport("all", "clipboard"),
                    },
                  ]}
                  menuLabel={t().moreExportAll}
                  disabled={loadMutation.loading()}
                  loading={exportMutation.loading()}
                  loadingLabel={t().exporting}
                >
                  <i class="ti ti-download" aria-hidden="true" /> {t().exportAll({ count: images().length })}
                </SplitButton>
              </Show>
              <SplitButton
                size="sm"
                onClick={() => startExport(hasSelection() ? "selected" : "all", "download")}
                items={[
                  {
                    label: hasSelection()
                      ? t().copySelectedBase64({ count: selectedCount() })
                      : t().copyAllBase64({ count: images().length }),
                    icon: "ti ti-copy",
                    action: () => startExport(hasSelection() ? "selected" : "all", "clipboard"),
                  },
                ]}
                menuLabel={hasSelection() ? t().moreExportSelected : t().moreExportAll}
                disabled={loadMutation.loading()}
                loading={exportMutation.loading()}
                loadingLabel={t().exporting}
              >
                <i class="ti ti-download" aria-hidden="true" />
                {hasSelection() ? t().exportSelected({ count: selectedCount() }) : t().exportAll({ count: images().length })}
              </SplitButton>
            </footer>
          </Show>
        </DetailPanel>
      </AppWorkspace.Detail>
    </>
  );
}

export default function ImageConverter() {
  return <ImageConverterView />;
}
