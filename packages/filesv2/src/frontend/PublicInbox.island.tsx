import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import { mutation } from "@k2b/stdlib/solid";
import { Button, FileDropzone, Format, InlineGuidance, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { PublicShare } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { publicClient } from "./public-client";

const transfer = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "omit" }), { preconnect: fetch.preconnect }) as typeof fetch;

/** Anonymous uploads: Cloud opens a session per file, the browser streams to Filegate, Cloud commits. */
export default function PublicInbox(props: { token: string; share: PublicShare }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const param = { token: props.token };
  const [progress, setProgress] = createSignal<{ done: number; total: number; name: string; percent: number } | null>(null);
  const [names, setNames] = createSignal(props.share.uploadedNames);
  const [next, setNext] = createSignal(props.share.next);
  const [namesLoading, setNamesLoading] = createSignal(false);
  const namesController = new AbortController();
  onCleanup(() => namesController.abort());
  const loadNames = async (append = false) => {
    if (!props.share.showUploadNames || namesLoading()) return;
    setNamesLoading(true);
    try {
      const response = await publicClient.inbox[":token"].api.$get({ param, query: { path: "", ...(append && next() ? { after: next()! } : {}) } }, { init: { signal: namesController.signal } });
      if (!response.ok) await apiFailure(response, b().publicLinkUnavailableDescription);
      const page = await response.json();
      setNames((current) => append ? [...current, ...page.uploadedNames] : page.uploadedNames);
      setNext(page.next);
    } catch (error) { if (!namesController.signal.aborted) toast.error(error instanceof Error ? error.message : b().publicLinkUnavailableDescription); }
    finally { setNamesLoading(false); }
  };
  const [uploaded, setUploaded] = createSignal<string[]>([]);
  const upload = mutation.create({
    mutation: async (files: readonly File[], { abortSignal }) => {
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        const report = (bytes: number) => setProgress({ done: index, total: files.length, name: file.name, percent: file.size ? Math.floor((bytes / file.size) * 100) : 100 });
        if (file.size > props.share.maxFileSize) { toast.error(b().uploadTooLarge); continue; }
        report(0);
        abortSignal.throwIfAborted();
        try {
          const opened = await publicClient.inbox[":token"].api.uploads.$post({ param, json: { name: file.name, size: file.size } }, { init: { signal: abortSignal } });
          if (!opened.ok) await apiFailure(opened, b().uploadFailed(file.name));
          const session = await opened.json();
          let leaseUrl = session.url;
          try {
            for (let renewals = 0; ; renewals++) {
              try {
                await new DirectSession(leaseUrl, transfer).upload(file, { signal: abortSignal, onProgress: report });
                break;
              } catch (error) {
                if (renewals >= 2 || !(error instanceof FilegateError && (error.status === 401 || error.status === 403))) throw error;
                const renewed = await publicClient.inbox[":token"].api.uploads[":id"].lease.$post({ param: { ...param, id: session.id } }, { init: { signal: abortSignal } });
                if (!renewed.ok) await apiFailure(renewed, b().uploadFailed(file.name));
                leaseUrl = (await renewed.json()).url;
              }
            }
            const committed = await publicClient.inbox[":token"].api.uploads[":id"].commit.$post({ param: { ...param, id: session.id } }, { init: { signal: abortSignal } });
            if (!committed.ok) await apiFailure(committed, b().uploadFailed(file.name));
            const result = await committed.json();
            setUploaded((current) => [...current, result.name]);
            if (props.share.showUploadNames) await loadNames();
          } catch (error) {
            void publicClient.inbox[":token"].api.uploads[":id"].abort.$post({ param: { ...param, id: session.id } }).catch(() => {});
            throw error;
          }
        } catch (error) {
          if (abortSignal.aborted) {
            setProgress(null);
            throw error;
          }
          toast.error(error instanceof Error ? error.message : b().uploadFailed(file.name));
        }
      }
      setProgress(null);
    },
  });
  onCleanup(() => upload.abort());
  return (
    <div class="flex flex-col gap-3">
      <InlineGuidance icon="ti ti-info-circle">
        {b().publicFileLimit}: <Format.Bytes value={props.share.maxFileSize} /> · {b().publicTotalBudget}: <Format.Bytes value={props.share.maxTotalSize} />
      </InlineGuidance>
      <Show when={!props.share.showUploadNames}><InlineGuidance icon="ti ti-lock">{b().privateInboxHint}</InlineGuidance></Show>
      <FileDropzone label={b().upload} hint={b().publicInboxHint} multiple busy={upload.loading()} onDrop={(files) => void upload.mutate(files)} />
      <Show when={progress()}>
        {(state) => (
          <InlineGuidance loading role="status">
            {b().uploading(state())}{" "}
            <Button size="xs" variant="text" onClick={() => upload.abort()}>
              {b().cancel}
            </Button>
          </InlineGuidance>
        )}
      </Show>
      <Show when={props.share.showUploadNames}>
        <section class="flex flex-col gap-2" aria-label={b().publicUploadNames}>
          <h2 class="text-sm font-medium">{b().publicUploadNames}</h2>
          <ul class="flex flex-col gap-1 text-sm"><For each={names()}>{(name) => <li class="break-words">{name}</li>}</For></ul>
          <Show when={next()}><Button variant="secondary" loading={namesLoading()} onClick={() => void loadNames(true)}>{b().moreShares}</Button></Show>
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
