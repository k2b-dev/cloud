import { Button, FileDropTarget, FileDropzone, Format, InlineGuidance, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { PublicShare, UploadSession } from "../contracts";
import {
  transferUpload,
  UPLOAD_COMMIT_DEADLINE_MS,
  uploadFailureAction,
  uploadRequestFailure,
  uploadResponseFailure,
} from "../upload-transfer";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { publicClient } from "./public-client";
import { UploadSurface } from "./UploadPanel";
import { browserUploadKey } from "./upload-key";
import { uploadFailureReason, useUploadMessages } from "./upload-messages";
import { createUploadQueue } from "./upload-queue";

/** Anonymous uploads: Cloud opens a session per file, the browser streams to Filegate, Cloud commits. */
export default function PublicInbox(props: { token: string; share: PublicShare }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const u = useUploadMessages();
  const param = { token: props.token };
  const [names, setNames] = createSignal(props.share.uploadedNames);
  const [next, setNext] = createSignal(props.share.next);
  const [namesLoading, setNamesLoading] = createSignal(false);
  const namesController = new AbortController();
  onCleanup(() => namesController.abort());
  // A refresh asked for during another read runs after it, so names committed meanwhile are not lost.
  let refreshPending = false;
  const loadNames = async (append = false) => {
    if (!props.share.showUploadNames) return;
    if (namesLoading()) {
      if (!append) refreshPending = true;
      return;
    }
    setNamesLoading(true);
    try {
      const response = await publicClient.inbox[":token"].api.$get(
        { param, query: { path: "", ...(append && next() ? { after: next()! } : {}) } },
        { init: { signal: namesController.signal } },
      );
      if (!response.ok) await apiFailure(response, b().publicLinkUnavailableDescription);
      const page = await response.json();
      setNames((current) => (append ? [...current, ...page.uploadedNames] : page.uploadedNames));
      setNext(page.next);
    } catch (error) {
      if (!namesController.signal.aborted) toast.error(error instanceof Error ? error.message : b().publicLinkUnavailableDescription);
    } finally {
      setNamesLoading(false);
      if (refreshPending && !namesController.signal.aborted) {
        refreshPending = false;
        void loadNames();
      }
    }
  };
  const [uploaded, setUploaded] = createSignal<string[]>([]);
  // The same queue and panel as in the workspace: one batch, byte-weighted progress, failed files retried in place.
  const uploads = createUploadQueue<null>({
    reason: (error) => uploadFailureReason(error, u()),
    upload: async (_, { file }, { signal, onProgress, onPhase, alive }) => {
      const start = await browserUploadKey(["public", props.token], file);
      let session: UploadSession | undefined;
      let committing = false;
      try {
        const opened = await publicClient.inbox[":token"].api.uploads.$post(
          { param, json: { name: file.name, size: file.size, idempotencyKey: start.idempotencyKey } },
          { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) } },
        );
        if (!opened.ok) throw await uploadResponseFailure(opened, u().failed);
        alive();
        session = await opened.json();
        if (session.state === "aborted" || session.state === "expired") start.finish();
        await transferUpload(file, session, {
          signal,
          failure: u().failed,
          onProgress,
          renew: async (id, renewSignal) => {
            try {
              const renewed = await publicClient.inbox[":token"].api.uploads[":id"].lease.$post(
                { param: { ...param, id } },
                { init: { signal: renewSignal } },
              );
              if (!renewed.ok) throw await uploadResponseFailure(renewed, u().failed);
              return await renewed.json();
            } catch (error) {
              throw uploadRequestFailure(error, u().failed, signal);
            }
          },
        });
        signal.throwIfAborted();
        committing = true;
        onPhase("finishing");
        const committed = await publicClient.inbox[":token"].api.uploads[":id"].commit.$post(
          { param: { ...param, id: session.id } },
          { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_COMMIT_DEADLINE_MS)]) } },
        );
        if (!committed.ok) throw await uploadResponseFailure(committed, u().failed);
        const result = await committed.json();
        start.finish();
        setUploaded((current) => [...current, result.name]);
        return { status: "uploaded", path: result.name };
      } catch (caught) {
        const error = signal.aborted ? caught : uploadRequestFailure(caught, u().failed, signal);
        const action = uploadFailureAction(error, { session, committing, cancelled: signal.aborted });
        if (action === "drop") start.finish();
        if (action === "abort" && session)
          await publicClient.inbox[":token"].api.uploads[":id"].abort
            .$post({ param: { ...param, id: session.id } }, { init: { signal: AbortSignal.timeout(5_000) } })
            .then(async (response) => {
              if (!response.ok) throw await uploadResponseFailure(response, u().failed);
              start.finish();
            })
            .catch(() => {});
        throw error;
      }
    },
  });
  // One name refresh per drained batch: a refresh per file would spend the link's page budget and hold up the queue.
  onCleanup(uploads.onSettled(() => void loadNames()));
  const upload = (files: File[]) => {
    if (!files.length) return;
    // A file over the limit can never be uploaded, so it is named once instead of becoming a row to retry.
    const tooLarge = files.filter((file) => file.size > props.share.maxFileSize);
    if (tooLarge.length) toast.error(b().uploadTooLarge(tooLarge.map((file) => file.name)));
    uploads.add(
      null,
      { key: "inbox", label: props.share.title },
      files.filter((file) => file.size <= props.share.maxFileSize).map((file) => ({ file, path: file.name })),
    );
  };
  return (
    <div class="flex flex-col gap-3">
      {/* The page exists to receive files: they can be dropped anywhere on it. */}
      <FileDropTarget label={b().dropInto({ name: props.share.title })} onDrop={upload} />
      <InlineGuidance icon="ti ti-info-circle">
        {b().publicFileLimit}: <Format.Bytes value={props.share.maxFileSize} /> · {b().publicTotalBudget}:{" "}
        <Format.Bytes value={props.share.maxTotalSize} />
      </InlineGuidance>
      <Show when={!props.share.showUploadNames}>
        <InlineGuidance icon="ti ti-lock">{b().privateInboxHint}</InlineGuidance>
      </Show>
      <FileDropzone
        label={b().upload}
        hint={b().publicInboxHint}
        dropLabel={b().dropInto({ name: props.share.title })}
        multiple
        onDrop={upload}
      />
      <UploadSurface queue={uploads} />
      <Show when={props.share.showUploadNames}>
        <section class="flex flex-col gap-2" aria-label={b().publicUploadNames}>
          <h2 class="text-sm font-medium">{b().publicUploadNames}</h2>
          <ul class="flex flex-col gap-1 text-sm">
            <For each={names()}>{(name) => <li class="break-words">{name}</li>}</For>
          </ul>
          <Show when={next()}>
            <Button variant="secondary" loading={namesLoading()} onClick={() => void loadNames(true)}>
              {b().moreShares}
            </Button>
          </Show>
        </section>
      </Show>
      <Show when={uploaded().length}>
        <ul class="flex flex-col gap-1 text-sm" aria-label={t().files}>
          <For each={uploaded()}>
            {(name) => (
              <li class="flex items-center gap-2">
                <i class="ti ti-circle-check text-success" aria-hidden="true" />
                {b().publicUploaded(name)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
