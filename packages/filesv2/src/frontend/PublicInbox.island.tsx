import { Button, FileDropTarget, FileDropzone, Format, InlineGuidance, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { PublicShare } from "../contracts";
import { transferUpload } from "../upload-transfer";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { publicClient } from "./public-client";
import { UploadSurface } from "./UploadPanel";
import { browserUploadKey } from "./upload-key";
import { useUploadMessages } from "./upload-messages";
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
  const loadNames = async (append = false) => {
    if (!props.share.showUploadNames || namesLoading()) return;
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
    }
  };
  const [uploaded, setUploaded] = createSignal<string[]>([]);
  // The same queue and panel as in the workspace: one batch, byte-weighted progress, failed files retried in place.
  const uploads = createUploadQueue<null>({
    reason: (error) => (error instanceof Error && error.message ? error.message : u().failed),
    upload: async (_, { file }, { signal, onProgress }) => {
      const start = await browserUploadKey(["public", props.token], file);
      const opened = await publicClient.inbox[":token"].api.uploads.$post(
        { param, json: { name: file.name, size: file.size, idempotencyKey: start.idempotencyKey } },
        { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) } },
      );
      if (!opened.ok) await apiFailure(opened, u().failed);
      const session = await opened.json();
      let committing = false;
      try {
        if (session.state === "aborted" || session.state === "expired") start.finish();
        await transferUpload(file, session, {
          signal,
          failure: u().failed,
          onProgress,
          renew: async (id, renewSignal) => {
            const renewed = await publicClient.inbox[":token"].api.uploads[":id"].lease.$post(
              { param: { ...param, id } },
              { init: { signal: renewSignal } },
            );
            if (!renewed.ok) return apiFailure(renewed, u().failed);
            return renewed.json();
          },
        });
        signal.throwIfAborted();
        committing = true;
        const committed = await publicClient.inbox[":token"].api.uploads[":id"].commit.$post(
          { param: { ...param, id: session.id } },
          { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) } },
        );
        if (!committed.ok) await apiFailure(committed, u().failed);
        const result = await committed.json();
        start.finish();
        setUploaded((current) => [...current, result.name]);
        if (props.share.showUploadNames) await loadNames();
        return { status: "uploaded", path: result.name };
      } catch (error) {
        if (session.state === "open" && !committing)
          await publicClient.inbox[":token"].api.uploads[":id"].abort
            .$post({ param: { ...param, id: session.id } }, { init: { signal: AbortSignal.timeout(5_000) } })
            .then((response) => {
              if (response.ok) start.finish();
            })
            .catch(() => {});
        throw error;
      }
    },
  });
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
