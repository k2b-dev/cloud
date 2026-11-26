import { clipboard as browserClipboard, files as fileTools, type ImgData, images as imageTools } from "@k2b/stdlib/browser";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Choice,
  Dialog,
  Empty,
  Field,
  Input,
  List,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  Progress,
  Row,
  Section,
  StatusRow,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolColors } from "../tools-colors";
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

const FORMATS: readonly ImageConverterFormat[] = ["jpeg", "png", "webp"];
/** A limit in pixels from a field: empty is no limit, a whole positive number a limit, anything else not valid. */
const pixels = (value: string): number | null | undefined => {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};
/** A quality in percent from a field, 10 to 100, or not valid. */
const percent = (value: string): number | undefined => {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) && number >= 10 && number <= 100 ? number / 100 : undefined;
};
/** A hex colour from a field, the short form written out (#fff is #ffffff), or not valid. */
const hexColor = (value: string): string | undefined => {
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((digit) => digit + digit).join("")}`;
  return undefined;
};

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
  const toast = useToast();
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
  // One lookup per update, so every card finds its item without scanning the whole batch.
  const itemsById = createMemo(() => new Map(items().map((item) => [item.id, item])));
  const intakeController = new AbortController();
  let processing = false;
  const [format, setFormat] = createSignal<ImageConverterFormat>("webp");
  // The fields keep what was typed; a value that is not valid says so at its field and holds the export.
  const [qualityText, setQualityText] = createSignal("85");
  const [backgroundText, setBackgroundText] = createSignal("#ffffff");
  const [widthText, setWidthText] = createSignal("");
  const [heightText, setHeightText] = createSignal("");
  const quality = () => percent(qualityText()) ?? 0.85;
  const jpegBackground = () => hexColor(backgroundText()) ?? "#ffffff";
  const maxWidth = () => pixels(widthText()) ?? null;
  const maxHeight = () => pixels(heightText()) ?? null;
  const qualityError = () => (format() !== "png" && percent(qualityText()) === undefined ? t().qualityInvalid : undefined);
  const backgroundError = () => (format() === "jpeg" && hexColor(backgroundText()) === undefined ? t().colorInvalid : undefined);
  const widthError = () => (pixels(widthText()) === undefined ? t().pixelsInvalid : undefined);
  const heightError = () => (pixels(heightText()) === undefined ? t().pixelsInvalid : undefined);
  const settingsInvalid = () => Boolean(qualityError() || backgroundError() || widthError() || heightError());
  const [progress, setProgress] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
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
    const confirmed = await Dialog.confirm({
      title: t().clearConfirmTitle,
      description: t().clearConfirm({ count: items().length }),
      confirm: t().clearConfirmAction,
      cancel: t().cancel,
    });
    if (!confirmed || loading() || exportLocked()) return;
    for (const image of images()) releasePreview(image.previewUrl);
    setItems([]);
    setError("");
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
    },
    onSuccess: ({ destination }) => toast(destination === "clipboard" ? t().copiedShort : t().downloadedShort, { status: "ok" }),
    onError: (cause) => setError(cause.message),
    onFinally: () => setExportLocked(false),
  });

  const startExport = (scope: ExportScope, destination: ExportDestination) => {
    if (!loading() && !exportMutation.loading() && !settingsInvalid()) void exportMutation.mutate({ scope, destination });
  };

  onCleanup(() => {
    intakeController.abort();
    disposeHeifDecoder();
    exportMutation.abort();
    for (const previewUrl of managedPreviewUrls) URL.revokeObjectURL(previewUrl);
    managedPreviewUrls.clear();
  });

  // k2b-ui gap: v2 has no file drop target; the page takes dropped images itself and the status row says so.
  const [dragging, setDragging] = createSignal(false);
  onMount(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const dropped = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(files);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", dropped);
    onCleanup(() => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", dropped);
    });
  });
  const busy = () => loading() || exportMutation.loading();
  const scope = (): ExportScope => (hasSelection() ? "selected" : "all");
  const exportWord = () => (hasSelection() ? t().exportSelected({ count: selectedCount() }) : t().exportAll({ count: images().length }));
  const copyWord = () =>
    hasSelection() ? t().copySelectedBase64({ count: selectedCount() }) : t().copyAllBase64({ count: images().length });
  const lead = () =>
    dragging()
      ? t().dropToAdd
      : items().length === 0
        ? t().emptySubtitle
        : [
            t().imageCount({ count: images().length }),
            ...(loadingCount() > 0 ? [t().preparing({ count: loadingCount() })] : []),
            ...(failedCount() > 0 ? [t().notAdded({ count: failedCount() })] : []),
          ].join(" · ");
  const lineOf = (item: ImageConverterItem) => {
    if (item.status === "loading") return intakeT()[item.stage];
    if (item.status === "failed") return intakeT()[`${item.reason}Hint`];
    const size = rotatedDimensions(item.width, item.height, item.rotation);
    return `${sourceFormat(item.file)} · ${size.width} × ${size.height} px · ${formatBytes(item.file.size)}${
      item.rotation ? ` · ${item.rotation}°` : ""
    }`;
  };
  const selectedOf = (item: ImageConverterItem) => item.status === "ready" && item.selected;
  const deedsOf = (item: ImageConverterItem): MenuEntry[] => [
    ...(item.status === "ready"
      ? [
          // a selection starts here or with the box of the status row; while it runs every row has its box
          { label: t().selectImage({ name: item.file.name }), icon: "square-check", onClick: () => toggleImage(item.id, true) },
          { label: t().rotateImageClockwise({ name: item.file.name }), icon: "rotate-clockwise", onClick: () => rotateClockwise(item.id) },
        ]
      : []),
    {
      label: t().removeNamed({ name: item.file.name }),
      icon: "trash",
      danger: true,
      disabled: item.status === "loading" || exportMutation.loading(),
      onClick: () => removeImage(item.id),
    },
  ];

  return (
    <ToolsScreen
      tool="image-converter"
      primary={{ label: t().addImages, icon: "photo-plus", onClick: () => void selectFiles(), disabled: exportMutation.loading() }}
      end={
        <>
          <Button icon="photo-plus" onClick={() => void selectFiles()} disabled={exportMutation.loading()}>
            {t().addImages}
          </Button>
          <Show when={items().length > 0}>
            <Menu
              label={t().moreExportAll}
              items={[{ label: t().clearAll, icon: "trash", danger: true, disabled: busy(), onClick: () => void clearImages() }]}
            />
          </Show>
        </>
      }
    >
      <Pane.Split>
        <Pane
          label={t().listLabel}
          scrollKey="tools-image-converter"
          status={
            <StatusRow
              lead={lead()}
              loading={loading()}
              select={
                images().length > 0
                  ? {
                      label: t().selectAll,
                      checked: allSelected() ? true : hasSelection() ? "mixed" : false,
                      onChange: (checked) => {
                        if (!busy()) toggleAll(checked);
                      },
                    }
                  : undefined
              }
              selection={
                hasSelection()
                  ? {
                      count: t().selectedCount({ count: selectedCount() }),
                      actions: [
                        {
                          label: exportWord(),
                          icon: "download",
                          onClick: () => startExport("selected", "download"),
                          disabled: busy() || settingsInvalid(),
                        },
                        {
                          label: copyWord(),
                          icon: "copy",
                          onClick: () => startExport("selected", "clipboard"),
                          disabled: busy() || settingsInvalid(),
                        },
                      ],
                      clear: { label: t().clearSelection, onClick: () => toggleAll(false) },
                    }
                  : undefined
              }
            />
          }
        >
          <Show
            when={items().length > 0}
            fallback={
              <Empty
                icon="photo-plus"
                text={t().dropzoneHint}
                action={{ label: t().addImages, icon: "photo-plus", onClick: () => void selectFiles() }}
              />
            }
          >
            {/* k2b-ui gap: no thumbnail in a v2 row on this branch (Row mark, #4208, which conflicts with the virtual list of
                #4211 until one of them lands); each image shows its type sign in the image colour. */}
            {/* Every file is a row, in drop order: one that could not be added says why and how to go on in its own row. */}
            <List
              label={t().listLabel}
              items={items()}
              rowKey={(item) => item.id}
              row={(item) => {
                // the list makes a row once per item; the current state of the item comes from the lookup
                const current = createMemo(() => itemsById().get(item.id) ?? item);
                const failure = () => {
                  const value = current();
                  return value.status === "failed" ? value : undefined;
                };
                return (
                  <Show
                    when={!failure()}
                    fallback={
                      <Row
                        icon="photo-off"
                        color="var(--k2-bad)"
                        lines={[current().file.name, failure() ? intakeT()[`${failure()!.reason}Title`] : "", lineOf(current())]}
                        end={
                          <Button
                            variant="ghost"
                            icon="x"
                            label={t().removeNamed({ name: current().file.name })}
                            disabled={exportMutation.loading()}
                            onClick={() => removeImage(item.id)}
                          />
                        }
                      />
                    }
                  >
                    <Menu.Context items={deedsOf(current())}>
                      <Row
                        icon="photo"
                        color={toolColors.image}
                        lines={[current().file.name, lineOf(current())]}
                        select={
                          current().status === "ready" && hasSelection()
                            ? { selected: selectedOf(current()), onChange: (selected) => toggleImage(item.id, selected) }
                            : undefined
                        }
                        end={<Menu label={t().imageActions({ name: current().file.name })} items={deedsOf(current())} />}
                      />
                    </Menu.Context>
                  </Show>
                );
              }}
            />
          </Show>
          <Band>
            <Text type="meta" muted>
              {t().dropzoneSubtitle}
            </Text>
          </Band>
        </Pane>
        <Show when={items().some((item) => item.status !== "failed")}>
          <Pane label={t().panelTitle} width={{ min: 288, default: 340 }} scrollKey="tools-image-converter-settings">
            <Show when={progress() !== null}>
              <Bar start={<Progress value={Math.round(progress() ?? 0)} of={100} label={t().exportProgress} />} />
            </Show>
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" title={t().conversionFailed}>
                  {message()}
                </Notice>
              )}
            </Show>
            <Section icon="file-export" title={t().sectionFormat}>
              <Field label={t().targetFormat}>
                <Choice
                  name="image-converter-format"
                  value={format()}
                  disabled={exportMutation.loading()}
                  onChange={(value) => setFormat(FORMATS.find((each) => each === value) ?? "webp")}
                  options={[
                    { value: "jpeg", label: "JPEG" },
                    { value: "png", label: "PNG" },
                    { value: "webp", label: "WebP" },
                  ]}
                />
              </Field>
              <Show when={format() !== "png"}>
                {/* k2b-ui gap: no v2 slider (lane Y, #4191); the quality is a number in percent. */}
                <Field label={t().quality} optional="%" error={qualityError()}>
                  <Input
                    type="number"
                    min={10}
                    max={100}
                    value={qualityText()}
                    disabled={exportMutation.loading()}
                    onInput={setQualityText}
                  />
                </Field>
              </Show>
              <Show when={format() === "jpeg"}>
                {/* k2b-ui gap: no v2 colour picker (lane Y, #4191); the background is a hex colour. */}
                <Field label={t().transparencyBackground} hint={t().transparencyDescription} error={backgroundError()}>
                  <Input value={backgroundText()} spellcheck={false} disabled={exportMutation.loading()} onInput={setBackgroundText} />
                </Field>
              </Show>
            </Section>
            <Section icon="dimensions" title={t().maxDimensions} summary={t().maxDimensionsDescription}>
              <Field.Row>
                <Field label={t().maxWidth} optional="px" error={widthError()}>
                  <Input
                    type="number"
                    min={1}
                    placeholder={t().original}
                    value={widthText()}
                    disabled={exportMutation.loading()}
                    onInput={setWidthText}
                  />
                </Field>
                <Field label={t().maxHeight} optional="px" error={heightError()}>
                  <Input
                    type="number"
                    min={1}
                    placeholder={t().original}
                    value={heightText()}
                    disabled={exportMutation.loading()}
                    onInput={setHeightText}
                  />
                </Field>
              </Field.Row>
            </Section>
            <Show when={images().length > 0}>
              <Bar
                end={
                  <>
                    <Button icon="copy" disabled={loading() || settingsInvalid()} onClick={() => startExport(scope(), "clipboard")}>
                      {hasSelection() ? copyWord() : t().copyShort}
                    </Button>
                    <Button
                      variant="primary"
                      icon="download"
                      busy={exportMutation.loading()}
                      disabled={loading() || settingsInvalid()}
                      onClick={() => startExport(scope(), "download")}
                    >
                      {exportWord()}
                    </Button>
                  </>
                }
              />
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
    </ToolsScreen>
  );
}

export default function ImageConverter() {
  return <ImageConverterView />;
}
