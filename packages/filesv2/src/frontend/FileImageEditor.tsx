import { onBeforeLeave } from "@k2b/ssr/nav";
import { files } from "@k2b/stdlib/browser";
import {
  Button,
  ImageEditor,
  type ImageEditorItem,
  type ImageEditorProps,
  type ImageEditorSaveActions,
  Placeholder,
  SplitButton,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { EntryResult } from "../contracts";
import { markdownRevision } from "../document-assets";
import { isUnresolvedUploadFailure, UploadTransferError } from "../upload-transfer";
import { filesImageFeatures, imageCopyPath, imageOriginalFormat, loadImageForEditing } from "./image-editing";
import { useImageMessages } from "./image-messages";
import { UploadConflict, uploadFile } from "./uploads";

/** Files owns persistence; the shared editor owns the captured history and bounded preview. */
export default function FileImageEditor(props: {
  baseId: string;
  path: string;
  canCreate: boolean;
  /** Without write access the person may still edit and download; saving a version is locked with its reason. */
  canWrite: boolean;
  /** The other images of the folder, shown in the editor's strip. */
  items?: readonly ImageEditorItem[];
  onSelectItem?: (path: string) => void;
  onSaved: (result: EntryResult) => void;
  onBack: () => void;
  /** The dialog guards closing across every open image with this. */
  onStatus: (status: { dirty: boolean; busy: boolean }) => void;
}) {
  const t = useImageMessages();
  const [loaded, setLoaded] = createSignal<Awaited<ReturnType<typeof loadImageForEditing>>>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [dirty, setDirty] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [retryUpload, setRetryUpload] = createSignal<() => Promise<void>>();
  const [versionConflict, setVersionConflict] = createSignal(false);
  const [saveErrorAction, setSaveErrorAction] = createSignal<ImageEditorProps["saveErrorAction"]>();
  let revision: string | undefined;
  let copyNumber = 1;
  const lifetime = new AbortController();
  let loadRequest: AbortController | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  let uncertainNotice: ReturnType<typeof toast> | undefined;
  const load = async () => {
    if (busy()) return;
    loadRequest?.abort();
    loadRequest = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, loadRequest.signal, AbortSignal.timeout(30_000)]);
    setLoading(true);
    setError("");
    try {
      const image = await loadImageForEditing(props.baseId, props.path, signal, t());
      signal.throwIfAborted();
      revision = image.revision;
      setLoaded(image);
    } catch (failure) {
      if (!lifetime.signal.aborted) setError(failure instanceof Error ? failure.message : t().failed);
    } finally {
      if (!lifetime.signal.aborted) setLoading(false);
    }
  };
  createEffect(() => props.onStatus({ dirty: dirty(), busy: busy() }));
  onBeforeLeave((event) => {
    if (busy()) event.preventDefault();
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (busy()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  onMount(() => {
    void load();
    window.addEventListener("beforeunload", beforeUnload);
  });
  onCleanup(() => {
    lifetime.abort();
    uncertainNotice?.dismiss();
    loadRequest?.abort();
    rejectPending?.(new DOMException("Editor closed", "AbortError"));
    window.removeEventListener("beforeunload", beforeUnload);
    props.onStatus({ dirty: false, busy: false });
  });
  const saveActions = (actions: ImageEditorSaveActions) => {
    createEffect(() => setBusy(actions.busy));
    const versionFormat = () => {
      const image = loaded();
      const format = image && imageOriginalFormat(image.entry);
      return image?.base.managed && image.base.versioningEnabled && format && actions.formats.includes(format) ? format : undefined;
    };
    const save = (copy: boolean) => {
      setSaveErrorAction(undefined);
      return actions.save(
        async (result) => {
          const image = loaded();
          if (!image || (!copy && (!versionFormat() || versionConflict())) || (copy && !props.canCreate)) throw new Error(t().saveFailed);
          const path = copy ? imageCopyPath(props.path, result.type, t().edited, copyNumber) : props.path;
          // This promise stays attached to the captured editor entry until its exact upload is known.
          // A manual check reuses the same Blob, destination, revision and durable upload key.
          await new Promise<void>((resolve, reject) => {
            rejectPending = reject;
            let unresolved = false;
            const attempt = async () => {
              if (checking() || lifetime.signal.aborted) return;
              setChecking(true);
              try {
                const saved = await uploadFile(props.baseId, path, result.blob, {
                  onConflict: copy ? "error" : "overwrite",
                  expectedRevision: copy ? undefined : revision,
                  signal: lifetime.signal,
                  fallback: t().saveFailed,
                });
                if (copy) copyNumber++;
                else revision = markdownRevision(saved.entry);
                setRetryUpload(undefined);
                uncertainNotice?.dismiss();
                uncertainNotice = undefined;
                rejectPending = undefined;
                try {
                  props.onSaved(saved);
                } catch {
                  toast.error(t().refreshFailed);
                }
                toast.success(t().saved);
                resolve();
              } catch (failure) {
                if (lifetime.signal.aborted) {
                  reject(failure);
                  return;
                }
                if (failure instanceof UploadConflict) {
                  copyNumber++;
                  setSaveErrorAction({ label: t().copy, onClick: () => void save(true) });
                  setRetryUpload(undefined);
                  uncertainNotice?.dismiss();
                  uncertainNotice = undefined;
                  rejectPending = undefined;
                  reject(new Error(t().copyConflict));
                } else if (
                  failure instanceof UploadTransferError &&
                  failure.kind === "final" &&
                  !isUnresolvedUploadFailure(failure) &&
                  !(unresolved && failure.code === "upload_preflight")
                ) {
                  setRetryUpload(undefined);
                  uncertainNotice?.dismiss();
                  uncertainNotice = undefined;
                  rejectPending = undefined;
                  if (failure.code === "write_conflict") {
                    setVersionConflict(true);
                    setSaveErrorAction(
                      props.canCreate ? { label: t().copy, onClick: () => void save(true) } : { label: t().download, onClick: download },
                    );
                  }
                  reject(
                    new Error(failure.code === "write_conflict" ? (props.canCreate ? t().changed : t().changedDownload) : failure.message),
                  );
                } else {
                  // A later preflight failure cannot settle an earlier ambiguous publication.
                  unresolved = true;
                  // Unknown or transient transport outcomes must reconcile before another write.
                  setRetryUpload(() => attempt);
                  uncertainNotice ??= toast(t().uncertain, {
                    duration: 0,
                    action: { label: t().check, onClick: () => void attempt() },
                  });
                }
              } finally {
                setChecking(false);
              }
            };
            void attempt();
          });
        },
        copy ? undefined : { format: versionFormat() },
      );
    };
    const download = () =>
      void actions.save(async (result) => {
        const name = props.path.split("/").at(-1) ?? "image";
        const extension = result.type === "image/png" ? "png" : result.type === "image/webp" ? "webp" : "jpg";
        files.downloadFileFromContent(result.blob, `${name.replace(/\.[^.]+$/u, "")}.${extension}`, result.type);
      });
    // A new version is the main action where it is possible; a copy, then a download, otherwise.
    const primary = () =>
      props.canWrite && versionFormat() && !versionConflict()
        ? { label: t().save, run: () => void save(false) }
        : props.canCreate
          ? { label: t().copy, run: () => void save(true) }
          : { label: t().download, run: download, icon: "ti ti-download" };
    const menu = () => [
      ...(!props.canWrite ? [{ label: t().version, description: t().noWrite, disabled: true, action: () => {} }] : []),
      ...(props.canWrite && versionFormat() && props.canCreate && !versionConflict()
        ? [{ label: t().copy, description: t().copyDescription, icon: "ti ti-copy", action: () => void save(true) }]
        : []),
      ...(primary().label !== t().download
        ? [{ label: t().download, description: t().downloadDescription, icon: "ti ti-download", action: download }]
        : []),
    ];
    return (
      <div class="filesv2-image-save-actions">
        <Show
          when={retryUpload()}
          fallback={
            <Show
              when={menu().length}
              fallback={
                <Button disabled={actions.busy} loading={actions.busy} onClick={primary().run}>
                  <Show when={primary().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                  {primary().label}
                </Button>
              }
            >
              <SplitButton
                disabled={actions.busy}
                loading={actions.busy}
                menuLabel={t().moreSaving}
                menuPosition="top-right"
                items={menu()}
                onClick={primary().run}
              >
                <Show when={primary().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                {primary().label}
              </SplitButton>
            </Show>
          }
        >
          <span class="k2b-sr-only" role="status">
            {t().uncertain}
          </span>
          <Button
            size="sm"
            variant="secondary"
            title={t().uncertain}
            disabled={checking()}
            loading={checking()}
            onClick={() => void retryUpload()?.()}
          >
            {t().check}
          </Button>
        </Show>
      </div>
    );
  };
  return (
    <div class="filesv2-image-editing">
      <Show
        when={loaded()}
        fallback={
          <Placeholder
            state={loading() ? "loading" : "error"}
            title={loading() ? t().loading : error()}
            action={!loading() ? <Button onClick={() => void load()}>{t().retry}</Button> : undefined}
          />
        }
      >
        {(image) => (
          <ImageEditor
            source={image().source}
            title={props.path.split("/").at(-1)}
            facts={props.canWrite ? undefined : [{ label: t().readOnly, icon: "ti ti-lock", tooltip: t().noWrite }]}
            notice={props.canWrite ? undefined : t().readOnlyNotice}
            redactionNotice={image().base.managed && image().base.versioningEnabled ? t().redactionVersions : undefined}
            items={props.items}
            currentItem={props.path}
            onSelectItem={props.onSelectItem}
            maxOutputMegapixels="device"
            features={filesImageFeatures}
            saveActions={saveActions}
            saveErrorAction={saveErrorAction()}
            onDirtyChange={setDirty}
            onCancel={() => {
              if (!busy()) props.onBack();
            }}
          />
        )}
      </Show>
    </div>
  );
}
