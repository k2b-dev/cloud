import { clipboard as browserClipboard, files as fileTools, type ImgData, images as imageTools } from "@k2b/stdlib/browser";
import { mutation } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  Checkbox,
  ColorInput,
  DetailPanel,
  FileDropTarget,
  FileDropzone,
  IconButton,
  NoticeCard,
  NumberInput,
  ProgressBar,
  prompts,
  ScrollArea,
  SegmentedControl,
  Slider,
  SplitButton,
  Tooltip,
  toast,
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

import { IMAGE_ACCEPT } from "./image-intake/formats";
import { disposeHeifDecoder, ImageIntakeError, type ImageIntakeFailure, type ImageIntakeStage, prepareImage } from "./image-intake/intake";
import { imageIntakeMessages } from "./image-intake/messages";

export type ImageConverterEntry = {
  id: string;
  file: File;
  source: Blob;
  previewUrl: string;
  width: number;
  height: number;
  rotation: ImageConverterRotation;
  selected: boolean;
};

export type ImageConverterItem =
  | ({ status: "ready" } & ImageConverterEntry)
  | { status: "loading"; id: string; file: File; stage: ImageIntakeStage }
  | { status: "failed"; id: string; file: File; reason: ImageIntakeFailure["reason"] };

type ImageConverterViewProps = {
  readonly initialImages?: readonly (Omit<ImageConverterEntry, "source"> & { source?: Blob })[];
  readonly initialItems?: readonly ImageConverterItem[];
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
  const mimeFormat = file.type.startsWith("image/") ? file.type.slice(6).replace("svg+xml", "svg") : "";
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
  const intakeT = () => imageIntakeMessages.resolve([locale()]).t;
  const [items, setItems] = createSignal<ImageConverterItem[]>(
    props.initialItems
      ? [...props.initialItems]
      : (props.initialImages ?? []).map((image) => ({ ...image, status: "ready", source: image.source ?? image.file })),
  );
  const images = createMemo(() => items().filter((item): item is ImageConverterEntry & { status: "ready" } => item.status === "ready"));
  const loading = createMemo(() => items().some((item) => item.status === "loading"));
  const failedCount = createMemo(() => items().filter((item) => item.status === "failed").length);
  const loadingCount = createMemo(() => items().filter((item) => item.status === "loading").length);
  const intakeController = new AbortController();
  let processing = false;
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

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    const signal = intakeController.signal;
    try {
      while (!signal.aborted) {
        const item = items().find((item) => item.status === "loading");
        if (!item) break;
        try {
          const prepared = await prepareImage(item.file, {
            signal,
            onStage: (stage) => {
              if (!signal.aborted)
                setItems((current) =>
                  current.map((entry) => (entry.id === item.id && entry.status === "loading" ? { ...entry, stage } : entry)),
                );
            },
          });
          signal.throwIfAborted();
          const previewUrl = URL.createObjectURL(prepared.source);
          managedPreviewUrls.add(previewUrl);
          setItems((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? {
                    status: "ready",
                    id: item.id,
                    file: item.file,
                    ...prepared,
                    previewUrl,
                    rotation: 0,
                    selected: false,
                  }
                : entry,
            ),
          );
        } catch (cause) {
          if (signal.aborted) break;
          const reason = cause instanceof ImageIntakeError ? cause.reason : "decode-failed";
          setItems((current) =>
            current.map((entry) => (entry.id === item.id ? { status: "failed", id: item.id, file: item.file, reason } : entry)),
          );
        }
      }
    } finally {
      processing = false;
    }
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (exportLocked()) {
      setError(t().waitForExport);
      return;
    }
    setError("");
    setSuccess("");
    setItems((current) => [
      ...current,
      ...files.map((file) => ({ status: "loading" as const, id: imageId(), file, stage: "waiting" as const })),
    ]);
    void processQueue();
  };

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
    const image = items().find((entry) => entry.id === id);
    if (image?.status === "loading") return;
    if (image?.status === "ready") releasePreview(image.previewUrl);
    setItems((current) => current.filter((entry) => entry.id !== id));
  };

  const clearImages = async () => {
    const confirmed = await prompts.confirm(t().clearConfirm({ count: items().length }), {
      title: t().clearConfirmTitle,
      icon: "ti ti-trash",
      confirmText: t().clearConfirmAction,
      variant: "danger",
    });
    if (!confirmed || loading() || exportLocked()) return;
    for (const image of images()) releasePreview(image.previewUrl);
    setItems([]);
    setError("");
    setSuccess("");
  };

  const toggleImage = (id: string, selected: boolean) =>
    setItems((current) => current.map((image) => (image.status === "ready" && image.id === id ? { ...image, selected } : image)));

  const toggleAll = (selected: boolean) =>
    setItems((current) => current.map((image) => (image.status === "ready" ? { ...image, selected } : image)));

  const rotateClockwise = (id: string) =>
    setItems((current) =>
      current.map((image) =>
        image.status === "ready" && image.id === id ? { ...image, rotation: nextClockwiseRotation(image.rotation) } : image,
      ),
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
    let data = await imageTools.create(entry.source);
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
    if (!loading() && !exportMutation.loading()) void exportMutation.mutate({ scope, destination });
  };

  onCleanup(() => {
    intakeController.abort();
    disposeHeifDecoder();
    exportMutation.abort();
    for (const previewUrl of managedPreviewUrls) URL.revokeObjectURL(previewUrl);
    managedPreviewUrls.clear();
  });

  return (
    <>
      <AppWorkspace.Main class="tools-main" scroll={false}>
        <section
          class="tools-image-converter relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ui-surface)]"
          aria-label={t().workspaceLabel}
        >
          <FileDropTarget label={t().dropToAdd} accept={IMAGE_ACCEPT} onDrop={addFiles} />
          <header class="flex flex-none flex-wrap items-center justify-between gap-3 px-[var(--ui-space-shell)] py-[var(--ui-space-section)]">
            <div class="min-w-0">
              <h1 class="text-base font-semibold text-primary">{t().heading}</h1>
              <p class="text-xs text-dimmed">
                {items().length === 0
                  ? t().emptySubtitle
                  : [
                      t().imageCount({ count: images().length }),
                      ...(loadingCount() > 0 ? [t().preparing({ count: loadingCount() })] : []),
                      ...(failedCount() > 0 ? [t().notAdded({ count: failedCount() })] : []),
                    ].join(" · ")}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <Show when={items().length > 0}>
                <Button variant="secondary" size="sm" onClick={selectFiles} disabled={exportMutation.loading()}>
                  <i class="ti ti-photo-plus" aria-hidden="true" /> {t().addImages}
                </Button>
                <Button variant="ghost" size="sm" onClick={clearImages} disabled={loading() || exportMutation.loading()}>
                  {t().clearAll}
                </Button>
              </Show>
            </div>
          </header>

          <Show
            when={items().length > 0}
            fallback={
              <div class="flex min-h-80 flex-1 items-center justify-center p-[var(--ui-space-shell)]">
                <FileDropzone
                  class="w-full max-w-xl"
                  aria-label={t().dropzoneLabel}
                  accept={IMAGE_ACCEPT}
                  multiple
                  busy={loading() || exportLocked()}
                  title={t().dropzoneTitle}
                  subtitle={t().dropzoneSubtitle}
                  hint={t().dropzoneHint}
                  icon="ti ti-photo-plus"
                  dropLabel={t().dropToAdd}
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
                disabled={loading() || exportMutation.loading()}
                onValueChange={toggleAll}
              />
              <Show when={hasSelection()}>
                <span class="text-xs tabular-nums text-dimmed">{t().selectedCount({ count: selectedCount() })}</span>
              </Show>
            </div>

            <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-shell)]">
              <div
                class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-[var(--ui-space-section)]"
                role="list"
                aria-label={t().listLabel}
              >
                <For each={items().map((item) => item.id)}>
                  {(id) => {
                    // A removed card can read the list once more before it is disposed.
                    const item = createMemo(() => items().find((item) => item.id === id));
                    const file = () => item()?.file;
                    const ready = () => {
                      const value = item();
                      return value?.status === "ready" ? value : undefined;
                    };
                    const failed = () => {
                      const value = item();
                      return value?.status === "failed" ? value : undefined;
                    };
                    const stage = () => {
                      const value = item();
                      return value?.status === "loading" ? intakeT()[value.stage] : "";
                    };
                    const dimensions = () => {
                      const image = ready();
                      return image ? rotatedDimensions(image.width, image.height, image.rotation) : null;
                    };
                    return (
                      <article
                        class="tools-image-converter-card group min-w-0 overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]"
                        role="listitem"
                        data-status={item()?.status}
                        data-selected={ready()?.selected ? "true" : undefined}
                        data-selection-active={hasSelection() ? "true" : undefined}
                      >
                        <div class="tools-image-converter-card__preview relative aspect-square overflow-hidden bg-[var(--ui-surface)] p-3">
                          <Show when={ready()}>
                            {(image) => (
                              <>
                                <img
                                  src={image().previewUrl}
                                  alt={t().previewAlt({ name: image().file.name })}
                                  class="h-full w-full object-contain transition-transform"
                                  style={{ transform: `rotate(${image().rotation}deg)` }}
                                  draggable={false}
                                />
                                <div class="tools-image-converter-card__selection absolute left-2 top-2">
                                  <Checkbox
                                    aria-label={t().selectImage({ name: image().file.name })}
                                    value={image().selected}
                                    disabled={loading() || exportMutation.loading()}
                                    onValueChange={(selected) => toggleImage(id, selected)}
                                  />
                                </div>
                                <div class="tools-image-converter-card__actions absolute right-2 top-2 flex gap-1">
                                  <Tooltip.Anchor content={t().rotateClockwise}>
                                    <IconButton
                                      label={t().rotateImageClockwise({ name: image().file.name })}
                                      size="sm"
                                      onClick={() => rotateClockwise(id)}
                                      disabled={loading() || exportMutation.loading()}
                                    >
                                      <i class="ti ti-rotate-clockwise" aria-hidden="true" />
                                    </IconButton>
                                  </Tooltip.Anchor>
                                  <Tooltip.Anchor content={t().removeImage}>
                                    <IconButton
                                      label={t().removeNamed({ name: image().file.name })}
                                      size="sm"
                                      class="text-red-600 dark:text-red-400"
                                      onClick={() => removeImage(id)}
                                      disabled={loading() || exportMutation.loading()}
                                    >
                                      <i class="ti ti-trash" aria-hidden="true" />
                                    </IconButton>
                                  </Tooltip.Anchor>
                                </div>
                              </>
                            )}
                          </Show>
                          <Show when={item()?.status === "loading"}>
                            <div class="flex h-full items-center justify-center text-dimmed">
                              <i class="ti ti-loader-2 animate-spin text-2xl" aria-hidden="true" />
                            </div>
                          </Show>
                          <Show when={failed()}>
                            {(image) => (
                              <>
                                <div class="tools-image-converter-card__failure flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
                                  <span class="tools-image-converter-card__failure-icon mb-1.5" aria-hidden="true">
                                    <i class="ti ti-photo-x" />
                                  </span>
                                  <p class="text-sm font-medium text-primary">{intakeT()[`${image().reason}Title`]}</p>
                                  <p class="text-xs text-dimmed">{intakeT()[`${image().reason}Hint`]}</p>
                                </div>
                                <div class="tools-image-converter-card__actions absolute right-2 top-2 flex gap-1">
                                  <Tooltip.Anchor content={t().removeImage}>
                                    <IconButton
                                      label={t().removeNamed({ name: image().file.name })}
                                      size="sm"
                                      class="text-red-600 dark:text-red-400"
                                      onClick={() => removeImage(id)}
                                      disabled={exportMutation.loading()}
                                    >
                                      <i class="ti ti-trash" aria-hidden="true" />
                                    </IconButton>
                                  </Tooltip.Anchor>
                                </div>
                              </>
                            )}
                          </Show>
                        </div>
                        <div class="min-w-0 border-t border-[var(--ui-border)] px-3 py-2">
                          <p class="truncate text-sm font-medium text-primary" title={file()?.name}>
                            {file()?.name}
                          </p>
                          <p class="truncate text-xs tabular-nums text-dimmed">
                            <Show
                              when={ready()}
                              fallback={
                                <span aria-live="polite">
                                  {stage() || (file() ? `${sourceFormat(file()!)} · ${formatBytes(file()!.size)}` : "")}
                                </span>
                              }
                            >
                              {(image) => (
                                <>
                                  {sourceFormat(image().file)} · {dimensions()?.width} × {dimensions()?.height} px ·{" "}
                                  {formatBytes(image().file.size)}
                                </>
                              )}
                            </Show>
                          </p>
                        </div>
                      </article>
                    );
                  }}
                </For>
              </div>
            </ScrollArea>
          </Show>
        </section>
      </AppWorkspace.Main>

      <AppWorkspace.Detail
        id="image-converter-settings"
        // Open from the drop on, so the cards do not move when the first image is ready; a batch of only failed files
        // keeps them closed, because on a phone the settings would cover the cards that say what went wrong.
        open={items().some((item) => item.status !== "failed")}
        width="md"
        minWidth={288}
        viewTransitionName="tools-image-converter-settings"
      >
        <DetailPanel>
          <DetailPanel.Header
            icon="ti ti-arrows-exchange"
            title={t().panelTitle}
            subtitle={images().length > 0 ? t().imagesReady({ count: images().length }) : loading() ? t().panelPreparing : t().panelEmpty}
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
                  disabled={loading()}
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
                disabled={loading()}
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
