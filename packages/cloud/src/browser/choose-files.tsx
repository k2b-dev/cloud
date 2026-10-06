import { showFileDialog } from "@k2b/stdlib/browser";
import { dialogCore, panelDialogWorkspaceOptions } from "@k2b/ui";
import { createSignal } from "solid-js";
import { type ChooseFilesOptions, FileChooser, type FileProviderList } from "./FileChooser";
import type { FileProviderCaller, FileProviderSource } from "./file-providers";

/**
 * One page's file choosing: the provider list is loaded once and kept; a failed load is tried again on the next
 * request. `caller` carries the locale and, in tests, the transport.
 */
export const createFileChoosing = (
  loadProviders: () => Promise<FileProviderSource[]>,
  caller: () => FileProviderCaller = () => ({ locale: document.documentElement.lang || "en" }),
) => {
  let request: Promise<readonly FileProviderSource[]> | undefined;
  let known: readonly FileProviderSource[] | undefined;
  const providers = (): Promise<readonly FileProviderSource[]> => {
    request ??= loadProviders().then(
      (list) => {
        known = list;
        return list;
      },
      (error: unknown) => {
        request = undefined;
        throw error;
      },
    );
    return request;
  };

  const chooseFiles = (options: ChooseFilesOptions = {}): Promise<File[]> => {
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve([]);
    if (known?.length === 0) {
      // Synchronous on purpose: the native dialog needs the caller's user activation.
      const picked = options.multiple
        ? showFileDialog({ accept: options.accept, multiple: true })
        : showFileDialog({ accept: options.accept }).then((file) => [file]);
      // The page cannot close a native dialog; an abort resolves `[]` at once and a later pick is dropped.
      return new Promise((resolve) => {
        const abort = () => resolve([]);
        signal?.addEventListener("abort", abort, { once: true });
        picked.then(resolve, () => resolve([])).finally(() => signal?.removeEventListener("abort", abort));
      });
    }
    const [list, setList] = createSignal<FileProviderList>(known ? { state: "ready", providers: known } : { state: "loading" });
    const load = () => {
      setList({ state: "loading" });
      providers().then(
        (value) => setList({ state: "ready", providers: value }),
        () => setList({ state: "error" }),
      );
    };
    if (!known) load();
    return dialogCore
      .open<File[]>((close) => <FileChooser options={options} providers={list} retryProviders={load} caller={caller} close={close} />, {
        ...panelDialogWorkspaceOptions,
        panelClassName: `${panelDialogWorkspaceOptions.panelClassName} cloud-file-chooser-dialog`,
        initialFocus: (dialog) => dialog.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]'),
        signal: options.signal,
        history: true,
      })
      .then((files) => files ?? []);
  };

  return {
    chooseFiles,
    prefetch: () => void providers().catch(() => undefined),
  };
};
