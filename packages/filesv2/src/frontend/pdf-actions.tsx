import { Button, PdfThumbnails, prompts, SortableList, TextInput } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { EntryResult, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure, readPreview } from "./file-preview";

export type PdfOperationRequest =
  | { operation: "merge"; paths: string[]; name: string }
  | { operation: "extract"; paths: string[]; pages: number[]; name: string };

/** A failure the server attributed, such as a password-protected source; `path` names that source when known. */
export class PdfOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "PdfOperationError";
  }
}

type PdfEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; result: EntryResult }
  | { type: "error"; code: string; message: string; path?: string };

/**
 * Runs one PDF action on the server and reports its honest progress while it reads, joins and saves. Aborting the
 * signal stops the work there too; the originals are never changed.
 */
export async function runPdfOperation(
  baseId: string,
  request: PdfOperationRequest,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
  fallback: string,
): Promise<EntryResult> {
  const response = await apiClient.bases[":baseId"].pdf.$post({ param: { baseId }, json: request }, { init: { signal } });
  if (!response.ok) return apiFailure(response, fallback);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error(fallback);
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const event = JSON.parse(line) as PdfEvent;
        if (event.type === "progress") onProgress(event.done, event.total);
        else if (event.type === "done") return event.result;
        else throw new PdfOperationError(event.code, event.message, event.path);
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(fallback);
}

const stem = (name: string) => name.replace(/\.[^./]+$/, "");
const pdfName = (value: string) => /^[^/\\]+\.pdf$/i.test(value.trim()) && value.trim() !== ".pdf";

/** Loads the bytes of each file once for its page pictures; a file that cannot be read says so in its row. */
function usePdfBytes(baseId: string, files: readonly FileEntry[], fallback: string) {
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const [bytes, setBytes] = createSignal<ReadonlyMap<string, Blob | null>>(new Map());
  for (const file of files)
    void readPreview(baseId, file, abort.signal, fallback).then(
      (blob) => setBytes((all) => new Map(all).set(file.path, blob)),
      () => {
        if (!abort.signal.aborted) setBytes((all) => new Map(all).set(file.path, null));
      },
    );
  return bytes;
}

/**
 * Merge asks only for the order and the new name: each file shows its first pages, the grip or the arrow keys move it,
 * and the footer counts the pages of the result. Resolves with the request, or nothing when cancelled.
 */
export const openPdfMergeDialog = (options: { baseId: string; files: readonly FileEntry[]; title: string }) =>
  prompts.dialog<PdfDialogResult>((close) => <MergeDialog {...options} close={(value) => close(value)} />, {
    title: options.title,
    icon: "ti ti-stack-2",
  });

/** What a dialog asks for, and how many pages the new PDF will have. */
export type PdfDialogResult = { request: PdfOperationRequest; pages: number };

function MergeDialog(props: { baseId: string; files: readonly FileEntry[]; close: (value?: PdfDialogResult) => void }) {
  const b = useBrowserMessages();
  const [order, setOrder] = createSignal<readonly FileEntry[]>(props.files);
  const [name, setName] = createSignal(`${stem(props.files[0]!.name)}-komplett.pdf`);
  const [pages, setPages] = createSignal<ReadonlyMap<string, number>>(new Map());
  const bytes = usePdfBytes(props.baseId, props.files, b().pdfFileUnreadable);
  const total = () => order().reduce((sum, file) => sum + (pages().get(file.path) ?? 0), 0);
  const counted = () => order().every((file) => pages().has(file.path));
  const move = (path: string, index: number) =>
    setOrder((all) => {
      const next = all.filter((file) => file.path !== path);
      next.splice(index, 0, all.find((file) => file.path === path)!);
      return next;
    });
  const valid = () => pdfName(name());
  return (
    <form
      class="filesv2-pdf-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid())
          props.close({
            request: { operation: "merge", paths: order().map((file) => file.path), name: name().trim() },
            pages: total(),
          });
      }}
    >
      <p class="filesv2-pdf-dialog__hint">{b().pdfMergeHint}</p>
      <SortableList
        class="filesv2-pdf-order"
        items={order()}
        itemKey={(file) => file.path}
        itemLabel={(file) => file.name}
        label={b().pdfMergeHint}
        onMove={move}
      >
        {(file, handle) => (
          <div class="filesv2-pdf-order__row">
            {handle}
            <span class="filesv2-pdf-order__number" aria-hidden="true">
              {order().indexOf(file()) + 1}
            </span>
            <div class="filesv2-pdf-order__main">
              <span class="filesv2-pdf-order__name" title={file().name}>
                {file().name}
              </span>
              <Show
                when={bytes().get(file().path) !== null}
                fallback={<span class="filesv2-pdf-order__failed">{b().pdfFileUnreadable}</span>}
              >
                <PdfThumbnails
                  data={bytes().get(file().path) ?? null}
                  title={file().name}
                  limit={6}
                  onPages={(count) => setPages((all) => new Map(all).set(file().path, count))}
                />
              </Show>
            </div>
            <span class="filesv2-pdf-order__pages">
              <Show when={pages().get(file().path)}>{(count) => b().pdfPages(count())}</Show>
            </span>
          </div>
        )}
      </SortableList>
      <TextInput
        label={b().pdfNewName}
        value={name}
        onValueChange={setName}
        error={valid() ? undefined : b().pdfNameInvalid}
        description={b().pdfOriginalsStay}
        autocomplete="off"
        spellcheck={false}
      />
      <div class="filesv2-pdf-dialog__footer">
        <span class="filesv2-pdf-dialog__count" aria-live="polite">
          {counted() ? b().pdfPages(total()) : ""}
        </span>
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {b().cancel}
        </Button>
        <Button type="submit" disabled={!valid()}>
          {b().pdfMerge}
        </Button>
      </div>
    </form>
  );
}

/**
 * Taking out pages asks which pages: every page of each file is a toggle, numbered in the order the new PDF takes.
 * The new file is named after the first file. Resolves with the request, or nothing when cancelled.
 */
export const openPdfExtractDialog = (options: { baseId: string; files: readonly FileEntry[]; title: string }) =>
  prompts.dialog<PdfDialogResult>((close) => <ExtractDialog {...options} close={(value) => close(value)} />, {
    title: options.title,
    icon: "ti ti-files",
  });

function ExtractDialog(props: { baseId: string; files: readonly FileEntry[]; close: (value?: PdfDialogResult) => void }) {
  const b = useBrowserMessages();
  const [counts, setCounts] = createSignal<ReadonlyMap<string, number>>(new Map());
  // Chosen pages per file, zero-based.
  const [chosen, setChosen] = createSignal<ReadonlyMap<string, ReadonlySet<number>>>(new Map());
  const bytes = usePdfBytes(props.baseId, props.files, b().pdfFileUnreadable);
  const toggle = (path: string, index: number) =>
    setChosen((all) => {
      const pages = new Set(all.get(path) ?? []);
      if (pages.has(index)) pages.delete(index);
      else pages.add(index);
      return new Map(all).set(path, pages);
    });
  const amount = () => [...chosen().values()].reduce((sum, pages) => sum + pages.size, 0);
  const ready = () => props.files.every((file) => counts().has(file.path));
  /** Page numbers over all files in order, 1-based, as the server joins them. */
  const pages = () => {
    let offset = 0;
    const out: number[] = [];
    for (const file of props.files) {
      const selected = [...(chosen().get(file.path) ?? [])].sort((a, b) => a - b);
      for (const index of selected) out.push(offset + index + 1);
      offset += counts().get(file.path) ?? 0;
    }
    return out;
  };
  return (
    <form
      class="filesv2-pdf-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        if (!amount() || !ready()) return;
        props.close({
          request: {
            operation: "extract",
            paths: props.files.map((file) => file.path),
            pages: pages(),
            name: `${stem(props.files[0]!.name)}-Auszug.pdf`,
          },
          pages: amount(),
        });
      }}
    >
      <p class="filesv2-pdf-dialog__hint">{b().pdfExtractHint(props.files.length > 1)}</p>
      <div class="filesv2-pdf-pick">
        <For each={props.files}>
          {(file) => (
            <section class="filesv2-pdf-pick__file" aria-label={file.name}>
              <Show when={props.files.length > 1}>
                <h3 class="filesv2-pdf-pick__name" title={file.name}>
                  {file.name}
                </h3>
              </Show>
              <Show when={bytes().get(file.path) !== null} fallback={<p class="filesv2-pdf-order__failed">{b().pdfFileUnreadable}</p>}>
                <PdfThumbnails
                  data={bytes().get(file.path) ?? null}
                  title={file.name}
                  size="md"
                  selected={chosen().get(file.path) ?? new Set()}
                  onToggle={(index) => toggle(file.path, index)}
                  onPages={(count) => setCounts((all) => new Map(all).set(file.path, count))}
                />
              </Show>
            </section>
          )}
        </For>
      </div>
      <div class="filesv2-pdf-dialog__footer">
        <span class="filesv2-pdf-dialog__count" aria-live="polite">
          {b().pdfPagesChosen(amount())}
        </span>
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {b().cancel}
        </Button>
        <Button type="submit" disabled={!amount() || !ready()}>
          {b().pdfExtractSave}
        </Button>
      </div>
    </form>
  );
}
