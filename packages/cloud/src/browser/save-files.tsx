import { dialogCore, IconButton, type IconButtonProps, panelDialogWorkspaceOptions, toast, useLocale } from "@k2b/ui";
import { createSignal, type JSX, splitProps } from "solid-js";
import type { FileProviderList } from "./FileChooser";
import { FileSaver, type SavedFile } from "./FileSaver";
import { fileChooserMessages } from "./file-chooser-messages";
import type { FileProviderCaller, SaveFileSource } from "./file-providers";
import type { ProviderList } from "./provider-list";

export type { SavedFile } from "./FileSaver";
export type { SaveFileSource } from "./file-providers";

export type SaveFilesOptions = {
  /** Closes the dialog and stops what is still running; files saved before stay saved. */
  signal?: AbortSignal;
};

/** The icon of the save action, for menus that show it beside other actions. */
export const SAVE_FILES_ICON = "ti ti-folder-down";

/**
 * One page's saving into file providers, over the same provider list as choosing. `caller` carries the locale and,
 * in tests, the transport.
 */
export const createFileSaving = (
  list: ProviderList,
  caller: () => FileProviderCaller = () => ({ locale: document.documentElement.lang || "en" }),
) => {
  const saveFiles = async (files: readonly SaveFileSource[], options: SaveFilesOptions = {}): Promise<SavedFile[]> => {
    if (files.length === 0 || options.signal?.aborted) return [];
    // Only a refusal leaves an empty list without a request; asking again lets a renewed session find its apps.
    const known = list.known()?.length === 0 && !list.requested() ? undefined : list.known();
    const [providers, setProviders] = createSignal<FileProviderList>(known ? { state: "ready", providers: known } : { state: "loading" });
    const load = () => {
      setProviders({ state: "loading" });
      list.providers().then(
        (value) => setProviders({ state: "ready", providers: value }),
        () => setProviders({ state: "error" }),
      );
    };
    if (!known) load();
    const saved: SavedFile[] = [];
    const running = new Set<Promise<void>>();
    await dialogCore.open<void>(
      (close) => (
        <FileSaver
          files={files}
          providers={providers}
          retryProviders={load}
          caller={caller}
          saved={saved}
          running={running}
          close={() => close()}
        />
      ),
      {
        ...panelDialogWorkspaceOptions,
        panelClassName: `${panelDialogWorkspaceOptions.panelClassName} cloud-file-chooser-dialog`,
        // While the folder still loads, the dialog itself holds focus; its first row takes it once it arrives.
        initialFocus: (dialog) => dialog.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]') ?? dialog,
        signal: options.signal,
        history: true,
      },
    );
    // Closing stops the transfers; a receipt that was already on its way still counts.
    await Promise.all(running);
    const first = saved[0];
    if (first) {
      const t = fileChooserMessages.resolve([caller().locale]).t;
      toast.success(
        saved.length === 1 && files.length === 1
          ? t.savedOne({ name: first.name, app: first.app })
          : t.savedMany({ count: saved.length, total: files.length, app: first.app }),
        first.href ? { action: { label: t.showIn({ app: first.app }), href: first.href } } : undefined,
      );
    }
    return saved;
  };

  /**
   * The save action's label: "Save to Files" once one provider that stores files is known, otherwise "Save to…".
   * With `name` it names one file; with `all` it saves every file of a list.
   */
  const label = (locale: string, options: { name?: string; all?: boolean } = {}): string => {
    const t = fileChooserMessages.resolve([locale]).t;
    const savers = list.known()?.filter((provider) => provider.save) ?? [];
    const app = savers.length === 1 ? savers[0]!.name : undefined;
    if (options.all) return app ? t.saveAllTo({ app }) : t.saveAllToAny;
    if (options.name) return app ? t.saveNamedTo({ name: options.name, app }) : t.saveNamedToAny({ name: options.name });
    return app ? t.saveTo({ app }) : t.saveToAny;
  };

  /** An icon button that saves `files()` when activated; its label and tooltip name the file or say "all". */
  function SaveFilesButton(
    props: Omit<IconButtonProps, "children" | "label" | "onClick"> & { files: () => readonly SaveFileSource[]; all?: boolean },
  ): JSX.Element {
    const locale = useLocale();
    const [local, rest] = splitProps(props, ["files", "all"]);
    const name = () => (local.all ? undefined : local.files()[0]?.name);
    return (
      <IconButton {...rest} label={label(locale(), { name: name(), all: local.all })} onClick={() => void saveFiles(local.files())}>
        <i class={SAVE_FILES_ICON} aria-hidden="true" />
      </IconButton>
    );
  }

  return { saveFiles, label, SaveFilesButton };
};
