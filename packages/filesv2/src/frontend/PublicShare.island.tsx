import { downloadArchive } from "@k2b/filegate/utils";
import { fileIcons } from "@k2b/stdlib";
import { Button, Format, InlineGuidance, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { ErrorSchema, type PublicShare } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { publicClient } from "./public-client";

/** Visitors download single files through short leases or everything as one signed archive. */
export default function PublicShareList(props: { token: string; share: PublicShare }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [busy, setBusy] = createSignal<string | null>(null);
  const param = { token: props.token };
  const [page, setPage] = createSignal(props.share);
  const [history, setHistory] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [resetNotice, setResetNotice] = createSignal(false);
  const [browseFailure, setBrowseFailure] = createSignal<string | null>(null);
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  const browse = async (path: string, append = false, back = false) => {
    controller?.abort();
    const pending = new AbortController();
    controller = pending;
    setLoading(true);
    setBrowseFailure(null);
    try {
      let response = await publicClient.s[":token"].api.$get(
        { param, query: { path, ...(append && page().next ? { after: page().next! } : {}) } },
        { init: { signal: pending.signal } },
      );
      let restarted = false;
      if (!response.ok && append) {
        const error = ErrorSchema.safeParse(await response.clone().json());
        if (error.success && error.data.code === "cursor_invalid" && !pending.signal.aborted) {
          restarted = true;
          setPage((current) => ({ ...current, items: [], next: null }));
          setResetNotice(true);
          response = await publicClient.s[":token"].api.$get({ param, query: { path } }, { init: { signal: pending.signal } });
        }
      }
      if (!response.ok) await apiFailure(response, b().publicLinkUnavailableDescription);
      const result = await response.json();
      if (pending.signal.aborted) return;
      if (!append && path !== page().path) setHistory((current) => (back ? current.slice(0, -1) : [...current, page().path]));
      setPage((current) => (append && !restarted ? { ...result, items: [...current.items, ...result.items] } : result));
    } catch (error) {
      if (!pending.signal.aborted) setBrowseFailure(error instanceof Error ? error.message : b().publicLinkUnavailableDescription);
    } finally {
      if (!pending.signal.aborted) setLoading(false);
    }
  };
  const download = async (path: string) => {
    setBusy(path);
    try {
      const response = await publicClient.s[":token"].api.download.$post({ param, json: { path } });
      if (!response.ok) await apiFailure(response, t().downloadFailed);
      const lease = await response.json();
      const link = document.createElement("a");
      link.href = lease.url;
      link.download = path.split("/").at(-1)!;
      link.rel = "noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().downloadFailed);
    } finally {
      setBusy(null);
    }
  };
  const downloadAll = async () => {
    setBusy("*");
    try {
      const response = await publicClient.s[":token"].api.archive.$post({ param });
      if (!response.ok) await apiFailure(response, t().downloadFailed);
      downloadArchive(await response.json());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().downloadFailed);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="flex flex-col gap-3">
      <Show when={resetNotice()}>
        <InlineGuidance tone="info">{b().cursorReset}</InlineGuidance>
      </Show>
      <Show when={browseFailure()}>
        {(message) => (
          <InlineGuidance tone="danger">
            {message()}{" "}
            <Button variant="text" onClick={() => void browse(page().path)}>
              {b().retry}
            </Button>
          </InlineGuidance>
        )}
      </Show>
      <Show when={history().length}>
        <Button variant="ghost" onClick={() => void browse(history().at(-1) ?? "", false, true)}>
          <i class="ti ti-arrow-left" aria-hidden="true" />
          {b().publicBack}
        </Button>
      </Show>
      <ul aria-busy={loading()} class="flex flex-col gap-1" role="list">
        <For each={page().items}>
          {(item) => (
            <li class="flex items-center gap-3 rounded-md px-2 py-1.5 even:bg-[var(--k2b-surface-muted)]" role="listitem">
              <i
                class={`ti ${fileIcons.getFileIcon({ name: item.name, type: item.directory ? "directory" : "file" })} text-lg`}
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <span class="text-xs text-dimmed tabular-nums">{item.directory ? b().folder : <Format.Bytes value={item.size} />}</span>
              <Button
                size="xs"
                variant="secondary"
                loading={busy() === item.path}
                disabled={loading()}
                onClick={() => (item.directory ? void browse(item.path) : void download(item.path))}
              >
                <i class={item.directory ? "ti ti-folder-open" : "ti ti-download"} aria-hidden="true" />
                {item.directory ? b().publicBrowse : t().download}
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={page().next}>
        <Button variant="secondary" loading={loading()} onClick={() => void browse(page().path, true)}>
          {b().moreShares}
        </Button>
      </Show>
      <div>
        <Button variant="primary" loading={busy() === "*"} onClick={() => void downloadAll()}>
          <i class="ti ti-file-zip" aria-hidden="true" />
          {b().publicDownloadAll}
        </Button>
      </div>
    </div>
  );
}
