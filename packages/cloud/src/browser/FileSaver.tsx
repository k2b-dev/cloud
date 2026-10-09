import { text } from "@k2b/stdlib";
import { Button, createCollectionSelection, FileGrid, Format, PanelDialog, Placeholder, ProgressBar, TextInput, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, createUniqueId, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { FILE_PROVIDER_NAME_CONFLICT } from "../contracts/file-provider";
import { entryIcon, type FileProviderList, localTimeZone } from "./FileChooser";
import { fileChooserMessages } from "./file-chooser-messages";
import {
  eachLimited,
  type FileProviderCaller,
  FileProviderError,
  type FileProviderSource,
  isSaveableName,
  nextFreeName,
  readSaveSource,
  type SavedProviderFile,
  type SaveFileSource,
  saveableName,
  saveProviderFile,
} from "./file-providers";
import { createProviderFolder, FolderContents, FolderToolbar } from "./provider-folder";

/** At most this many files are read and saved at the same time. */
const PARALLEL_SAVES = 2;

/** A file the person saved, with the app it went to and the provider's link to it. */
export type SavedFile = { name: string; app: string; href?: string };

type Problem = "size" | "source" | "access" | "offline" | "failed";
type Item = {
  source: SaveFileSource;
  /** The name it is saved under; a conflict asks for another. */
  name: string;
  /** Idempotency key for this name in this folder: a retry never creates a second file, a new name gets a new key. */
  key: string;
  /** The provider opened a write stream under `key`, so bytes may have arrived and a retry must keep the key. */
  streamed: boolean;
  state: "waiting" | "loading" | "done" | "conflict" | "error";
  progress: number;
  draft: string;
  problem?: Problem;
};

const problemOf = (cause: unknown): Problem => {
  if (!(cause instanceof FileProviderError)) return "failed";
  if (cause.code === "FILE_TOO_LARGE" || cause.status === 413) return "size";
  if (cause.code === "SOURCE_UNAVAILABLE") return cause.status === 0 ? "offline" : "source";
  if (cause.status === 0) return "offline";
  if (cause.status === 403 || cause.status === 404) return "access";
  return "failed";
};

/**
 * The shared save dialog: the person picks a provider that stores files and one of its folders, then every file is
 * read from the consumer and created there through the provider's `save`. Saving never replaces: a taken name asks
 * for another, prefilled as `Name (2).ext`. `saved` collects every created file, however the dialog closes, and
 * `running` holds each round of transfers, which settles soon after the dialog closed and stopped them.
 */
export function FileSaver(props: {
  files: readonly SaveFileSource[];
  providers: () => FileProviderList;
  retryProviders: () => void;
  caller: () => FileProviderCaller;
  saved: SavedFile[];
  running: Set<Promise<void>>;
  close: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => fileChooserMessages.resolve([locale()]).t;
  let root: HTMLDivElement | undefined;

  const savers = createMemo(() => {
    const list = props.providers();
    return list.state === "ready" ? list.providers.filter((provider) => provider.save) : [];
  });
  /** With one provider, the dialog opens straight into it and the path starts there. */
  const single = () => props.providers().state === "ready" && savers().length === 1;

  const refocus = () => {
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && root?.contains(active) && active.isConnected && active.tagName !== "DIALOG") return;
      const first = folder.location() ? folder.items()[0]?.id : sourceRows()[0]?.appId;
      if (first) (folder.location() ? selection : sourceSelection).focus(first);
    });
  };
  const folder = createProviderFolder({ caller: props.caller, t, settled: refocus });
  const sourceRows = createMemo(() => {
    const needle = folder.filter().trim().toLocaleLowerCase();
    return needle ? savers().filter((provider) => provider.name.toLocaleLowerCase().includes(needle)) : savers();
  });
  createEffect(
    on(single, (only) => {
      if (only && !folder.location()) folder.openProvider(savers()[0]!);
    }),
  );

  const sourceSelection = createCollectionSelection({
    ids: () => sourceRows().map((provider) => provider.appId),
    multiple: false,
    checklist: true,
  });
  // Files stay visible, so the person sees which names are taken, but only folders open.
  const selection = createCollectionSelection({
    ids: () => folder.items().map((entry) => entry.id),
    isDisabled: (id) => folder.items().some((entry) => entry.id === id && entry.kind === "file"),
    multiple: false,
    checklist: true,
  });

  const [items, setItems] = createStore<Item[]>(
    props.files.map((source) => ({
      source,
      name: saveableName(source.name),
      key: "",
      streamed: false,
      state: "waiting",
      progress: 0,
      draft: "",
    })),
  );
  const [target, setTarget] = createSignal<{ provider: FileProviderSource; parent: string } | null>(null);
  const [running, setRunning] = createSignal(0);
  let transfer: AbortController | undefined;
  onCleanup(() => transfer?.abort());

  const parent = () => folder.location()?.trail.at(-1)?.id;
  const canSave = () => Boolean(folder.location() && parent() && folder.writable() && folder.status() === "ready");
  const limit = () => target()?.provider.save?.maxBytes ?? folder.location()?.provider.save?.maxBytes ?? Number.POSITIVE_INFINITY;
  const done = () => items.filter((item) => item.state === "done").length;
  const attention = () => items.filter((item) => item.state === "error" || item.state === "conflict").length;

  const saveItems = async (indexes: number[]) => {
    const where = target();
    if (!where || indexes.length === 0) return;
    transfer ??= new AbortController();
    const signal = transfer.signal;
    for (const index of indexes) setItems(index, { state: "waiting", progress: 0, problem: undefined });
    setRunning((count) => count + indexes.length);
    const round = eachLimited(indexes, PARALLEL_SAVES, async (index) => {
      const item = items[index]!;
      // A URL is read first and then sent, so each half of the bar is one direction; a Blob is only sent.
      const share = typeof item.source.content === "string" ? 0.5 : 0;
      try {
        if (signal.aborted) return;
        setItems(index, { state: "loading", progress: 0 });
        const body = await readSaveSource(item.source, {
          maxBytes: limit(),
          signal,
          fetch: props.caller().fetch,
          onProgress: (loaded, total) => setItems(index, "progress", total ? (loaded / total) * share : 0),
        });
        const file: SavedProviderFile = await saveProviderFile(
          where.provider,
          { parent: where.parent, name: item.name, body, idempotencyKey: item.key },
          {
            ...props.caller(),
            signal,
            onStream: () => setItems(index, "streamed", true),
            onProgress: (loaded, total) => setItems(index, "progress", share + (total ? loaded / total : 1) * (1 - share)),
          },
        );
        // The file exists even when Cancel came with its receipt.
        props.saved.push({ name: file.name, app: where.provider.name, ...(file.href ? { href: file.href } : {}) });
        if (signal.aborted) return;
        setItems(index, { state: "done", progress: 1 });
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof FileProviderError && cause.code === FILE_PROVIDER_NAME_CONFLICT)
          setItems(index, { state: "conflict", draft: nextFreeName(item.name) });
        else setItems(index, { state: "error", problem: problemOf(cause) });
      } finally {
        setRunning((count) => count - 1);
      }
    });
    props.running.add(round);
    await round;
    if (signal.aborted) return;
    if (items.every((item) => item.state === "done")) props.close();
    else if (running() === 0) {
      // The first row that needs the person takes focus: a name to change, or Save to try failed files again.
      queueMicrotask(() =>
        (
          root?.querySelector<HTMLElement>(".cloud-file-saver__rename input") ?? root?.querySelector<HTMLElement>("[data-file-saver-save]")
        )?.focus(),
      );
    }
  };

  const start = () => {
    const current = folder.location();
    const into = parent();
    if (!current || !into || !canSave()) return;
    batch(() => {
      setTarget({ provider: current.provider, parent: into });
      items.forEach((_, index) => setItems(index, { key: crypto.randomUUID(), streamed: false }));
    });
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>("[data-file-saver-cancel]")?.focus());
    void saveItems(items.map((_, index) => index));
  };
  const retry = () => {
    const failed = items.flatMap((item, index) => (item.state === "error" ? [index] : []));
    // Without a stream no byte was sent, so a new key cannot create a second file. Core may have frozen the old one
    // after an Action whose outcome it does not know. With a stream, the same key replays it and finds a committed file.
    for (const index of failed) if (!items[index]!.streamed) setItems(index, "key", crypto.randomUUID());
    void saveItems(failed);
  };
  /** A new name waits until the files still running are done, so no more than two ever transfer at once. */
  const canRename = (item: Item) => running() === 0 && isSaveableName(item.draft) && item.draft !== item.name;
  const rename = (index: number) => {
    const item = items[index]!;
    if (!canRename(item)) return;
    setItems(index, { name: item.draft, key: crypto.randomUUID(), streamed: false });
    void saveItems([index]);
  };

  const problemText = (problem: Problem | undefined) => {
    if (problem === "size") return t().tooLarge({ limit: text.pprintBytes(limit(), { locale: locale() }) });
    if (problem === "source") return t().sourceFailed;
    if (problem === "access") return t().saveForbidden;
    if (problem === "offline") return t().offlineShort;
    return t().saveFailed;
  };

  const title = () => t().saveTitle({ name: items[0]?.name ?? "", count: items.length });
  const saving = () => target() !== null;

  return (
    <PanelDialog>
      {/* `display: contents`, so header, body, and footer stay the panel's own rows. */}
      <div ref={root} class="cloud-file-chooser">
        <PanelDialog.Header title={title()} close={props.close} />
        <FolderToolbar folder={folder} t={t} disabled={saving()} sources={!single()} />
        <PanelDialog.Body>
          <Switch>
            <Match when={saving()}>
              <ul class="cloud-file-chooser__downloads" aria-label={t().saving({ done: done(), total: items.length, failed: attention() })}>
                <For each={items}>
                  {(item, index) => {
                    const stateId = createUniqueId();
                    return (
                      <li>
                        <div class="cloud-file-chooser__download-line">
                          <span class="cloud-file-chooser__download-name" title={item.name}>
                            {item.name}
                          </span>
                          <span
                            id={stateId}
                            class="cloud-file-chooser__download-state"
                            data-state={item.state === "conflict" ? "error" : item.state}
                          >
                            <Switch fallback={<Format.Percent value={item.progress} clamp />}>
                              <Match when={item.state === "waiting"}>{t().waiting}</Match>
                              <Match when={item.state === "done"}>{t().saved}</Match>
                              <Match when={item.state === "conflict" && !isSaveableName(item.draft)}>{t().invalidName}</Match>
                              <Match when={item.state === "conflict"}>{t().nameTaken}</Match>
                              <Match when={item.state === "error"}>{problemText(item.problem)}</Match>
                            </Switch>
                          </span>
                        </div>
                        {/* Every row keeps room for a name field, so a taken name never moves the rows below it. */}
                        <div class="cloud-file-saver__slot">
                          <Show
                            when={item.state === "conflict"}
                            fallback={
                              <ProgressBar
                                size="xs"
                                tone={item.state === "error" ? "danger" : item.state === "done" ? "success" : "info"}
                                value={item.progress * 100}
                                label={t().saveProgress({ name: item.name })}
                              />
                            }
                          >
                            <div class="cloud-file-saver__rename">
                              <TextInput
                                aria-label={t().newName({ name: item.name })}
                                maxLength={255}
                                value={() => item.draft}
                                onValueChange={(value) => setItems(index(), "draft", value)}
                                onSubmit={() => rename(index())}
                                aria-describedby={stateId}
                              />
                              <Button variant="secondary" disabled={!canRename(item)} onClick={() => rename(index())}>
                                {t().save}
                              </Button>
                            </div>
                          </Show>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Match>
            <Match when={!folder.location()}>
              <Switch>
                <Match when={props.providers().state === "loading"}>
                  <Placeholder state="loading" variant="panel" class="cloud-file-chooser__state" description={t().saveProvidersLoading} />
                </Match>
                <Match when={props.providers().state === "error"}>
                  <Placeholder
                    state="error"
                    variant="panel"
                    class="cloud-file-chooser__state"
                    description={t().saveProvidersFailed}
                    action={
                      <Button size="sm" variant="secondary" onClick={props.retryProviders}>
                        {t().retry}
                      </Button>
                    }
                  />
                </Match>
                <Match when={savers().length === 0}>
                  <Placeholder
                    variant="panel"
                    class="cloud-file-chooser__state"
                    icon="ti ti-folder-off"
                    title={t().noSaveProviders}
                    description={t().noSaveProvidersHint}
                  />
                </Match>
                <Match when={true}>
                  <FileGrid
                    rows={sourceRows()}
                    getRowId={(provider) => provider.appId}
                    selection={sourceSelection}
                    label={t().saveSourceList}
                    layout="list"
                    renderPreview={(provider) => <i class={`${provider.icon} cloud-file-chooser__icon`} aria-hidden="true" />}
                    renderLabel={(provider) => provider.name}
                    onRowClick={(provider) => {
                      sourceSelection.clear();
                      folder.openProvider(provider);
                    }}
                    onOpen={(provider) => {
                      sourceSelection.clear();
                      folder.openProvider(provider);
                    }}
                  />
                </Match>
              </Switch>
            </Match>
            <Match when={true}>
              <FolderContents folder={folder} t={t}>
                <FileGrid
                  rows={folder.items()}
                  getRowId={(entry) => entry.id}
                  selection={selection}
                  label={t().entries({ folder: folder.folderName() })}
                  layout="list"
                  renderPreview={(entry) => <i class={`${entryIcon(entry)} cloud-file-chooser__icon`} aria-hidden="true" />}
                  renderLabel={(entry) => <span title={entry.name}>{entry.name}</span>}
                  renderMeta={(entry) =>
                    entry.kind === "file" ? (
                      <span class="cloud-file-chooser__meta">
                        <Format.Bytes value={entry.size} />
                        <Show when={entry.updatedAt}>
                          {(updated) => (
                            <>
                              <span aria-hidden="true">·</span>
                              <Format.Date value={updated()} timeZone={localTimeZone()} />
                            </>
                          )}
                        </Show>
                      </span>
                    ) : null
                  }
                  onRowClick={(entry) => {
                    if (entry.kind === "folder") folder.openFolder(entry);
                  }}
                  onOpen={(entry) => {
                    if (entry.kind === "folder") folder.openFolder(entry);
                  }}
                />
              </FolderContents>
            </Match>
          </Switch>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span class="cloud-file-chooser__status" role="status">
            <Switch>
              <Match when={saving()}>{t().saving({ done: done(), total: items.length, failed: attention() })}</Match>
              <Match when={!folder.location() || folder.status() !== "ready"}>{null}</Match>
              <Match when={!parent()}>{t().chooseFolder}</Match>
              <Match when={!folder.writable()}>{t().notWritable}</Match>
              <Match when={true}>{t().savesInto({ folder: folder.folderName() })}</Match>
            </Switch>
          </span>
          {/* Labels never change, so the buttons keep their place. Cancel stops what is still running; Save tries failed files again. */}
          <div class="cloud-file-chooser__actions">
            <Button variant="ghost" data-file-saver-cancel onClick={props.close}>
              {t().cancel}
            </Button>
            <Button
              variant="primary"
              data-file-saver-save
              disabled={saving() ? running() > 0 || !items.some((item) => item.state === "error") : !canSave()}
              onClick={() => (saving() ? retry() : start())}
            >
              {t().save}
            </Button>
          </div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}
