import { onBeforeLeave } from "@k2b/ssr/nav";
import { Button, Dropdown, ImageEditor, type ImageEditorSaveActions, Placeholder, prompts, toast } from "@k2b/ui";
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
  onSaved: (result: EntryResult) => void;
  onBack: () => void;
  setGuard: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const t = useImageMessages();
  const [loaded, setLoaded] = createSignal<Awaited<ReturnType<typeof loadImageForEditing>>>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [dirty, setDirty] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [retryUpload, setRetryUpload] = createSignal<() => Promise<void>>();
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
  let confirmation: Promise<boolean> | undefined;
  props.setGuard(async () => {
    if (busy()) return false;
    if (!dirty()) return true;
    confirmation ??= prompts
      .confirm(t().discard, { variant: "danger" })
      .then(Boolean)
      .finally(() => {
        confirmation = undefined;
      });
    return confirmation;
  });
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
    props.setGuard(null);
  });
  const saveActions = (actions: ImageEditorSaveActions) => {
    createEffect(() => setBusy(actions.busy));
    const versionFormat = () => {
      const image = loaded();
      const format = image && imageOriginalFormat(image.entry);
      return image?.base.managed && image.base.versioningEnabled && format && actions.formats.includes(format) ? format : undefined;
    };
    const save = (copy: boolean) =>
      actions.save(
        async (result) => {
          const image = loaded();
          if (!image || (!copy && !versionFormat()) || (copy && !props.canCreate)) throw new Error(t().saveFailed);
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
                  reject(new Error(failure.code === "write_conflict" ? t().changed : failure.message));
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
    return (
      <div class="filesv2-image-save-actions">
        <Show
          when={retryUpload()}
          fallback={
            <Dropdown.Root
              items={[
                ...(versionFormat() ? [{ label: t().version, action: () => void save(false) }] : []),
                ...(props.canCreate ? [{ label: t().copy, action: () => void save(true) }] : []),
              ]}
            >
              <Dropdown.Trigger size="sm" variant="primary" disabled={actions.busy || (!versionFormat() && !props.canCreate)}>
                {t().save}
              </Dropdown.Trigger>
            </Dropdown.Root>
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
            maxOutputMegapixels="device"
            features={filesImageFeatures}
            saveActions={saveActions}
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
