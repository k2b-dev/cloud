import { chooseFiles } from "@k2b/cloud/browser/files";
import { files } from "@k2b/stdlib/browser";
import {
  Button,
  FileDropTarget,
  FileDropzone,
  ImageEditor,
  type ImageEditorFeatures,
  type ImageEditorResult,
  type ImageEditorSaveActions,
  NoticeCard,
  Select,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { IMAGE_ACCEPT, isHeif } from "./image-intake/formats";
import { disposeHeifDecoder, ImageIntakeError, type ImageIntakeFailure, type ImageIntakeStage, prepareImage } from "./image-intake/intake";
import { imageIntakeMessages } from "./image-intake/messages";
import { photoEditorMessages } from "./image-processor/photo-editor-messages";

export const TOOLS_IMAGE_EDITOR_FEATURES = {
  crop: { aspects: ["free", "original", "1:1", "4:5", "3:2", "4:3", "16:9", "9:16"] },
  rotate: true,
  straighten: true,
  adjust: true,
  filters: true,
  annotate: true,
  redact: true,
  export: { formats: ["image/jpeg", "image/png", "image/webp"], quality: true, resize: true },
} satisfies ImageEditorFeatures;

type Photo = { id: number; file: File; source: Blob; sourceSize?: { width: number; height: number; type: string } };
type LoadFailure = { file: File; reason: ImageIntakeFailure["reason"] };
export type ImageProcessorViewProps = { initialImages?: readonly Photo[]; initialLoadFailures?: readonly LoadFailure[] };

export function imageEditorOutputName(name: string, result: Pick<ImageEditorResult, "type">): string {
  const stem = name.replace(/\.[^.]+$/u, "");
  const extension = result.type === "image/jpeg" ? "jpg" : result.type === "image/png" ? "png" : "webp";
  return `${stem}.${extension}`;
}

/** Tools owns file intake and destinations. All image edits belong to the public editor. */
export function ImageProcessorView(props: ImageProcessorViewProps = {}) {
  const locale = useLocale();
  const t = () => photoEditorMessages.resolve([locale()]).t;
  const intake = () => imageIntakeMessages.resolve([locale()]).t;
  const [photos, setPhotos] = createSignal<Photo[]>([...(props.initialImages ?? [])]);
  const [active, setActive] = createSignal(props.initialImages?.[0]?.id);
  const [visited, setVisited] = createSignal(
    new Set(
      photos()
        .slice(0, 1)
        .map((photo) => photo.id),
    ),
  );
  const [loading, setLoading] = createSignal(false);
  const [stage, setStage] = createSignal<{ name: string; stage: ImageIntakeStage; index: number; count: number }>();
  const [failures, setFailures] = createSignal<LoadFailure[]>([...(props.initialLoadFailures ?? [])]);
  const [error, setError] = createSignal("");
  const [archiving, setArchiving] = createSignal(false);
  const controls = new Map<number, ImageEditorSaveActions>();
  const ready = new Map<number, (actions: ImageEditorSaveActions | undefined) => void>();
  const controllers = new Set<AbortController>();
  let nextId = Math.max(0, ...photos().map((photo) => photo.id));
  let alive = true;
  let queue: File[] = [];
  let loadingAbort: AbortController | undefined;
  const choose = () => chooseFiles({ accept: IMAGE_ACCEPT, multiple: true });
  const addFiles = (incoming: File[]) => {
    queue.push(...incoming);
    if (loading()) return;
    const abort = new AbortController();
    loadingAbort = abort;
    controllers.add(abort);
    setLoading(true);
    setError("");
    void (async () => {
      let index = 0;
      while (queue.length) {
        const file = queue.shift();
        if (!file) continue;
        abort.signal.throwIfAborted();
        index++;
        setStage({ name: file.name, stage: "waiting", index, count: index + queue.length });
        try {
          // Native images go straight to the editor's bounded preview loader. Keep Tools' HEIF fallback.
          const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
          abort.signal.throwIfAborted();
          const prepared = isHeif(file, head)
            ? await prepareImage(file, {
                signal: abort.signal,
                onStage: (stage) => {
                  if (!abort.signal.aborted) setStage({ name: file.name, stage, index, count: index + queue.length });
                },
              })
            : undefined;
          abort.signal.throwIfAborted();
          const photo: Photo = {
            id: ++nextId,
            file,
            source: prepared?.source ?? file,
            sourceSize: prepared ? { width: prepared.width, height: prepared.height, type: prepared.source.type } : undefined,
          };
          setPhotos((current) => [...current, photo]);
          setActive((current) => {
            if (current !== undefined) return current;
            setVisited((ids) => new Set([...ids, photo.id]));
            return photo.id;
          });
        } catch (failure) {
          if (abort.signal.aborted) throw failure;
          const reason = failure instanceof ImageIntakeError ? failure.reason : "decode-failed";
          setFailures((current) => [...current, { file, reason }]);
        }
      }
    })()
      .catch(() => {
        if (alive && !abort.signal.aborted) setError(t().loadFailed);
      })
      .finally(() => {
        controllers.delete(abort);
        if (alive && loadingAbort === abort) {
          setLoading(false);
          setStage(undefined);
        }
      });
  };
  const remove = (photo: Photo) => {
    controls.delete(photo.id);
    const next = photos().filter((item) => item !== photo);
    setPhotos(next);
    setActive(next[0]?.id);
    if (next[0]) setVisited((ids) => new Set([...ids, next[0]!.id]));
  };
  const downloadAll = async () => {
    if (archiving() || loading()) return;
    setArchiving(true);
    setError("");
    const selected = [...photos()];
    let failedPhoto: Photo | undefined;
    let archive: { filename: string; source: Blob }[] = [];
    const saveNext = async (index: number): Promise<void> => {
      const photo = selected[index];
      let actions = photo ? controls.get(photo.id) : undefined;
      if (photo && !actions) {
        const pending = new Promise<ImageEditorSaveActions | undefined>((resolve) => ready.set(photo.id, resolve));
        setVisited((ids) => new Set([...ids, photo.id]));
        actions = await pending;
      } else if (photo && actions?.busy) {
        actions = await new Promise<ImageEditorSaveActions | undefined>((resolve) => ready.set(photo.id, resolve));
      }
      if (!photo || !actions) throw new Error(t().exportFailed);
      let accepted = false;
      await actions.save(async (result) => {
        if (!alive) throw new DOMException("Aborted", "AbortError");
        archive = archive.slice(0, index);
        const names = new Set(archive.map((entry) => entry.filename));
        const filename = imageEditorOutputName(photo.file.name, result);
        let unique = filename;
        let suffix = 1;
        while (names.has(unique)) unique = filename.replace(/(\.[^.]+)$/u, ` (${++suffix})$1`);
        names.add(unique);
        archive.push({ filename: unique, source: result.blob });
        // Export one original at a time. Every captured entry stays dirty until the single archive succeeds.
        if (index + 1 < selected.length) await saveNext(index + 1);
        else await files.downloadAsZip(archive, "photos.zip");
        accepted = true;
      });
      if (!accepted) {
        failedPhoto ??= photo;
        setActive(failedPhoto.id);
        throw new Error(t().exportFailed);
      }
    };
    try {
      await saveNext(0);
    } catch (failure) {
      if (alive) setError(failure instanceof Error ? failure.message : t().exportFailed);
    } finally {
      if (alive) setArchiving(false);
    }
  };
  const paste = (event: ClipboardEvent) => {
    if ((event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (images.length) {
      event.preventDefault();
      addFiles(images);
    }
  };
  onCleanup(() => {
    alive = false;
    queue = [];
    for (const abort of controllers) abort.abort();
    controls.clear();
    for (const resolve of ready.values()) resolve(undefined);
    ready.clear();
    disposeHeifDecoder();
  });

  return (
    <>
      <FileDropTarget accept={IMAGE_ACCEPT} multiple onDrop={addFiles} label={t().dropToAdd} disabled={archiving()} />
      <div class="flex min-h-0 flex-1 flex-col" onPaste={paste}>
        <Show
          when={photos().length}
          fallback={
            <div class="flex min-h-80 flex-1 items-center justify-center p-[var(--ui-space-shell)]">
              <FileDropzone
                class="w-full max-w-xl"
                accept={IMAGE_ACCEPT}
                multiple
                busy={loading()}
                choose={choose}
                onDrop={addFiles}
                title={t().open}
                subtitle={t().intakeHint}
                hint={t().local}
                icon="ti ti-photo-plus"
              />
            </div>
          }
        >
          <div class="flex flex-wrap items-end gap-3 px-[var(--ui-space-shell)] py-2">
            <div class="min-w-0 flex-1">
              <Select
                label={t().photo}
                value={String(active())}
                options={photos().map((photo) => ({ id: String(photo.id), label: photo.file.name }))}
                disabled={archiving()}
                onValueChange={(value) => {
                  const photo = photos().find((item) => String(item.id) === value);
                  if (photo) {
                    setVisited((ids) => new Set([...ids, photo.id]));
                    setActive(photo.id);
                  }
                }}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={loading() || archiving()}
              onClick={() => {
                void choose()
                  .then((selected) => addFiles([...selected]))
                  .catch(() => setError(t().pickerFailed));
              }}
            >
              {t().add}
            </Button>
            <Show when={photos().length > 1}>
              <Button
                variant="secondary"
                size="sm"
                disabled={loading() || archiving()}
                loading={archiving()}
                onClick={() => void downloadAll()}
              >
                {t().downloadAll}
              </Button>
            </Show>
          </div>
          <For each={photos()}>
            {(photo) => (
              <div hidden={active() !== photo.id} class="min-h-0 flex-1">
                <Show when={visited().has(photo.id)}>
                  <ImageEditor
                    source={photo.source}
                    sourceSize={photo.sourceSize}
                    features={TOOLS_IMAGE_EDITOR_FEATURES}
                    onCancel={() => remove(photo)}
                    saveActions={(actions) => {
                      controls.set(photo.id, actions);
                      createEffect(() => {
                        if (!actions.busy) {
                          ready.get(photo.id)?.(actions);
                          ready.delete(photo.id);
                        }
                      });
                      onCleanup(() => {
                        controls.delete(photo.id);
                        ready.get(photo.id)?.(undefined);
                        ready.delete(photo.id);
                      });
                      return (
                        <Button
                          size="sm"
                          disabled={actions.busy || loading() || archiving()}
                          loading={actions.busy}
                          onClick={() =>
                            void actions.save(async (result) => {
                              files.downloadFileFromContent(result.blob, imageEditorOutputName(photo.file.name, result), result.type);
                            })
                          }
                        >
                          <i class="ti ti-download" aria-hidden="true" />
                          {t().download}
                        </Button>
                      );
                    }}
                  />
                </Show>
              </div>
            )}
          </For>
        </Show>
        <div class="min-h-12 px-[var(--ui-space-shell)] py-2" aria-live="polite">
          <Show when={loading() && stage()}>
            {(current) => <p>{intake().loadingFile({ ...current(), stage: intake()[current().stage] })}</p>}
          </Show>
          <Show when={error()}>
            <NoticeCard tone="danger" icon title={error()} />
          </Show>
          <Show when={failures().length}>
            <section aria-label={intake().failuresLabel}>
              <For each={failures()}>
                {(failure) => (
                  <NoticeCard tone="danger" title={failure.file.name} detail={intake()[`${failure.reason}Title`]}>
                    <p>{intake()[`${failure.reason}Hint`]}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setFailures((all) => all.filter((item) => item !== failure));
                        addFiles([failure.file]);
                      }}
                    >
                      {t().retry}
                    </Button>
                  </NoticeCard>
                )}
              </For>
              <Button variant="ghost" size="sm" onClick={() => setFailures([])}>
                {intake().dismissFailures}
              </Button>
            </section>
          </Show>
        </div>
      </div>
    </>
  );
}
export default function ImageProcessor() {
  return <ImageProcessorView />;
}
