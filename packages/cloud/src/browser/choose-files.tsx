import { showFileDialog } from "@k2b/stdlib/browser";
import { dialogCore, panelDialogWorkspaceOptions } from "@k2b/ui";
import { createSignal } from "solid-js";
import { type ChooseFilesOptions, FileChooser, type FileProviderList } from "./FileChooser";
import type { FileProviderCaller } from "./file-providers";
import type { ProviderList } from "./provider-list";

/**
 * One page's file choosing over its provider list. `caller` carries the locale and, in tests, the transport.
 */
export const createFileChoosing = (
  list: ProviderList,
  caller: () => FileProviderCaller = () => ({ locale: document.documentElement.lang || "en" }),
) => {
  const chooseFiles = (options: ChooseFilesOptions = {}): Promise<File[]> => {
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve([]);
    const known = list.known();
    if (known?.length === 0) {
      // Synchronous on purpose: the native dialog needs the caller's user activation.
      const picked = options.multiple
        ? showFileDialog({ accept: options.accept, multiple: true })
        : showFileDialog({ accept: options.accept }).then((file) => [file]);
      // Only a refusal leaves no request behind; asking again now lets the next choice find a renewed session's apps.
      if (!list.requested()) list.prefetch();
      // The page cannot close a native dialog; an abort resolves `[]` at once and a later pick is dropped.
      return new Promise((resolve) => {
        const abort = () => resolve([]);
        signal?.addEventListener("abort", abort, { once: true });
        picked.then(resolve, () => resolve([])).finally(() => signal?.removeEventListener("abort", abort));
      });
    }
    const [providers, setProviders] = createSignal<FileProviderList>(known ? { state: "ready", providers: known } : { state: "loading" });
    const load = () => {
      setProviders({ state: "loading" });
      list.providers().then(
        (value) => setProviders({ state: "ready", providers: value }),
        () => setProviders({ state: "error" }),
      );
    };
    if (!known) load();
    return dialogCore
      .open<File[]>(
        (close) => <FileChooser options={options} providers={providers} retryProviders={load} caller={caller} close={close} />,
        {
          ...panelDialogWorkspaceOptions,
          panelClassName: `${panelDialogWorkspaceOptions.panelClassName} cloud-file-chooser-dialog`,
          initialFocus: (dialog) => dialog.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]'),
          signal: options.signal,
          history: true,
        },
      )
      .then((files) => files ?? []);
  };

  return chooseFiles;
};
