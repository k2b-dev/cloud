import { fileIcons, text } from "@k2b/stdlib";
import {
  Button,
  createCollectionSelection,
  FileDropTarget,
  FileDropzone,
  FileGrid,
  Format,
  ProgressBar,
  StatusBadge,
  type StatusTone,
  useLocale,
} from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import type { FileProviderContext, FileProviderEntry, FileProviderTag } from "../contracts/file-provider";
import { deviceFilesProblem } from "./choice-limits";
import { fileChooserMessages } from "./file-chooser-messages";
import { FileDialogFrame, type FileDialogSource, FileDialogSources } from "./file-dialog";
import {
  type EntryProblem,
  eachLimited,
  entryProblem,
  FILE_PROVIDER_PARALLEL_READS,
  type FileProviderCaller,
  FileProviderError,
  type FileProviderSource,
  providerIcon,
  readProviderFile,
} from "./file-providers";
import { createProviderFolder, FolderContents, FolderToolbar } from "./provider-folder";

export type ChooseFilesOptions = {
  /** `<input accept>` syntax, for example `"image/*,.pdf"`. */
  accept?: string;
  /** Allow choosing several files. Defaults to `false`. */
  multiple?: boolean;
  /** The largest single file the consumer takes from a provider. The provider's own read limit applies as well. */
  maxBytes?: number;
  /** The most files one choice may hold, for example the attachments a draft can still take. */
  maxFiles?: number;
  /**
   * The most bytes the chosen provider files may hold together, for example a mail's attachment limit. It also bounds
   * what the browser holds while it reads them. Without it, only the limit per file applies.
   */
  maxTotalBytes?: number;
  /**
   * What the person is working on, as resource refs, for providers that understand it. Only providers whose `list`
   * accepts `context` receive it; others list as before. A function runs only when the person opens such a provider,
   * at most once per chooser, and again after it failed. Refs are hints, never access.
   */
  context?: FileProviderContext | ((signal: AbortSignal) => Promise<FileProviderContext>);
  /** The empty root title for a provider that received context. Defaults to the chooser's "No matching files". */
  noMatchingFiles?: string;
  /** Closes the chooser, or stops waiting for the device's dialog, and resolves `[]` when aborted. */
  signal?: AbortSignal;
};

export type FileProviderList = { state: "loading" } | { state: "ready"; providers: readonly FileProviderSource[] } | { state: "error" };

type FileEntry = Extract<FileProviderEntry, { kind: "file" }>;
type SourceRow = FileDialogSource & { provider?: FileProviderSource };
type Download = {
  entry: FileEntry;
  loaded: number;
  total: number;
  state: "waiting" | "loading" | "done" | "error";
  file?: File;
  /** Why a read was refused: the file changed after it was listed and no longer fits, alone or with the others. */
  reason?: EntryProblem | "total";
};

const DEVICE = "device";

const TAG_TONES: Record<NonNullable<FileProviderTag["tone"]>, StatusTone> = {
  neutral: "neutral",
  info: "info",
  success: "ok",
  warning: "warning",
  danger: "error",
};

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const entryIcon = (entry: FileProviderEntry) =>
  providerIcon(entry.icon, `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.kind === "folder" ? "directory" : "file" })}`);

/** The neutral tile of a file or folder row; only the folder glyph carries a colour. */
export const EntryTile = (props: { entry: FileProviderEntry }): JSX.Element => (
  <span class="cloud-file-dialog__tile" data-kind={props.entry.kind} aria-hidden="true">
    <i class={entryIcon(props.entry)} />
  </span>
);

/** "1.2 MB · 28/10/2026" for a file, "Folder · 28/10/2026" for a folder. */
export const EntryFacts = (props: { entry: FileProviderEntry; folder: string }): JSX.Element => (
  <>
    {props.entry.kind === "file" ? <Format.Bytes value={props.entry.size} /> : props.folder}
    <Show when={props.entry.updatedAt}>
      {(updated) => (
        <>
          <span aria-hidden="true"> · </span>
          <Format.Date value={updated()} timeZone={localTimeZone()} />
        </>
      )}
    </Show>
  </>
);

/**
 * The shared file chooser: the sources on the left, "This device" first and open; inside a provider, its folders
 * page by page. It resolves the chosen files, read through the providers' streams, or `[]`.
 */
export function FileChooser(props: {
  options: ChooseFilesOptions;
  providers: () => FileProviderList;
  retryProviders: () => void;
  caller: () => FileProviderCaller;
  close: (files: File[]) => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => fileChooserMessages.resolve([locale()]).t;
  const multiple = props.options.multiple ?? false;
  const bytes = (value: number) => text.pprintBytes(value, { locale: locale() });
  let deviceInput: HTMLInputElement | undefined;
  let root: HTMLDivElement | undefined;

  /** After navigation the activated row is gone; give focus to the first row so the keyboard continues there. */
  const refocus = () => {
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && root?.contains(active) && active.isConnected && active.tagName !== "DIALOG") return;
      const first = items()[0]?.id;
      if (location() && first) selection.focus(first);
      else root?.querySelector<HTMLElement>('.cloud-file-dialog__source[aria-current="true"]')?.focus();
    });
  };
  /** Providers that answered 403 or 404 at their root; they leave the list for this dialog. */
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const [goneNote, setGoneNote] = createSignal<string>();
  const folder = createProviderFolder({
    caller: props.caller,
    t,
    settled: refocus,
    context: props.options.context,
    gone: (provider) => {
      setGone(new Set([...gone(), provider.appId]));
      setGoneNote(t().sourceGone({ app: provider.name }));
    },
  });
  const { location, items, openFolder } = folder;
  const [downloads, setDownloads] = createStore<Download[]>([]);
  const [downloading, setDownloading] = createSignal(false);
  let transfer: AbortController | undefined;
  // Closing stops every read and lets go of the bytes already read.
  onCleanup(() => {
    transfer?.abort();
    setDownloads([]);
  });

  const maxFiles = props.options.maxFiles;
  const maxTotal = props.options.maxTotalBytes;
  /** The largest single file: the consumer's limits or the provider's read limit, whichever is smallest. */
  const limit = () =>
    Math.min(
      props.options.maxBytes ?? Number.POSITIVE_INFINITY,
      maxTotal ?? Number.POSITIVE_INFINITY,
      location()?.provider.maxBytes ?? Number.POSITIVE_INFINITY,
    );
  const problem = (entry: FileProviderEntry): EntryProblem | undefined => entryProblem(entry, props.options.accept, limit());

  // Rows keep their identity by app, so a refreshed catalog does not re-create the row that has focus.
  const device = createMemo<SourceRow>(() => ({ id: DEVICE, name: t().device, icon: "ti ti-device-laptop" }));
  const providerRows = new Map<string, SourceRow>();
  const providerRow = (provider: FileProviderSource): SourceRow => {
    const id = `app:${provider.appId}`;
    const kept = providerRows.get(id);
    if (kept && kept.name === provider.name && kept.icon === provider.icon) {
      kept.provider = provider;
      return kept;
    }
    const row = { id, name: provider.name, icon: provider.icon, provider };
    providerRows.set(id, row);
    return row;
  };
  const sources = createMemo<SourceRow[]>(() => {
    const list = props.providers();
    const providers = list.state === "ready" ? list.providers.filter((provider) => !gone().has(provider.appId)) : [];
    return [device(), ...providers.map(providerRow)];
  });
  const current = () => {
    const open = location();
    return open ? `app:${open.provider.appId}` : DEVICE;
  };

  // Files that do not fit stay in focus order, so the keyboard and screen readers reach the reason, but cannot be chosen.
  const blocked = createMemo(() => new Set(items().flatMap((entry) => (problem(entry) ? [entry.id] : []))));
  const selection = createCollectionSelection({
    ids: () => items().map((entry) => entry.id),
    isDisabled: (id) => blocked().has(id),
    multiple,
    checklist: true,
  });
  const chosen = createMemo(() =>
    items().filter((entry): entry is FileEntry => entry.kind === "file" && selection.selected().has(entry.id)),
  );
  const total = () => chosen().reduce((sum, entry) => sum + entry.size, 0);
  /** Why the selection cannot be added, or `undefined` when it fits. */
  const overLimit = () => {
    const most = multiple ? maxFiles : 1;
    if (most !== undefined && chosen().length > most) return t().tooMany({ count: most });
    if (maxTotal !== undefined && total() > maxTotal) return t().tooLargeTogether({ limit: bytes(maxTotal) });
    return undefined;
  };
  /** The consumer's limits in one line, for the drop zone and the status before anything is chosen. */
  const limits = () =>
    [
      props.options.maxBytes !== undefined ? t().limitPerFile({ limit: bytes(props.options.maxBytes) }) : "",
      multiple && maxFiles !== undefined ? t().limitFiles({ count: maxFiles }) : "",
      maxTotal !== undefined ? t().limitTotal({ limit: bytes(maxTotal) }) : "",
    ]
      .filter(Boolean)
      .join(", ");

  /** Files from this device, picked or dropped, meet the same limits; the status says why they do not. */
  const [deviceNote, setDeviceNote] = createSignal<string>();
  const takeDevice = (files: File[]) => {
    if (files.length === 0) return;
    const why = deviceFilesProblem(files, props.options, locale());
    if (why) setDeviceNote(why);
    else props.close(files);
  };
  createEffect(on(chosen, () => setDeviceNote(undefined), { defer: true }));

  const openSource = (row: SourceRow) => {
    setGoneNote(undefined);
    setDeviceNote(undefined);
    const open = location();
    // A second click on the open source, such as the rest of a double-click, keeps its root as it is.
    if (row.provider && open?.provider.appId === row.provider.appId && open.trail.length === 1) return;
    if (row.provider) return folder.openProvider(row.provider);
    if (location()) folder.navigate(null);
    // The click or key press on the row is the user activation the native picker needs.
    deviceInput?.click();
  };

  const add = async () => {
    const files = chosen();
    if (files.length === 0 || overLimit() || (downloading() && !failed())) return;
    const open = location();
    if (!open) return;
    transfer?.abort();
    const pending = new AbortController();
    transfer = pending;
    // Only a retry of this transfer finds earlier downloads: Cancel clears them, and the location cannot change
    // while a transfer is shown, so a finished file never stands in for another provider's file with the same ID.
    const previous = new Map(downloads.filter((item) => item.state === "done").map((item) => [item.entry.id, item]));
    setDownloads(files.map((entry) => previous.get(entry.id) ?? { entry, loaded: 0, total: entry.size, state: "waiting" }));
    setDownloading(true);
    // One budget for the whole transfer: each read takes the size it announces, which may be more than was listed.
    let used = downloads.reduce((sum, item) => sum + (item.file?.size ?? 0), 0);
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>("[data-file-chooser-cancel]")?.focus());
    await eachLimited(
      downloads.map((_, index) => index),
      FILE_PROVIDER_PARALLEL_READS,
      async (index) => {
        if (pending.signal.aborted || downloads[index]!.state === "done") return;
        setDownloads(index, { state: "loading", loaded: 0 });
        let reserved = 0;
        let overTotal = false;
        try {
          const file = await readProviderFile(open.provider, downloads[index]!.entry, {
            ...props.caller(),
            maxBytes: limit(),
            accept: props.options.accept,
            signal: pending.signal,
            reserve: (size) => {
              overTotal = maxTotal !== undefined && used + size > maxTotal;
              if (overTotal) return false;
              used += size;
              reserved = size;
              return true;
            },
            onProgress: (loaded, size) => {
              if (!pending.signal.aborted) setDownloads(index, { loaded, total: size });
            },
          });
          if (!pending.signal.aborted) setDownloads(index, { state: "done", file });
        } catch (cause) {
          used -= reserved;
          const code = cause instanceof FileProviderError ? cause.code : "";
          const reason = overTotal ? "total" : code === "FILE_TOO_LARGE" ? "size" : code === "UNSUPPORTED_MEDIA_TYPE" ? "type" : undefined;
          if (!pending.signal.aborted) setDownloads(index, { state: "error", reason });
        }
      },
    );
    if (pending.signal.aborted) return;
    if (downloads.every((item) => item.state === "done")) props.close(downloads.map((item) => item.file!));
  };
  const stop = () => {
    transfer?.abort();
    batch(() => {
      setDownloading(false);
      setDownloads([]);
    });
    queueMicrotask(() => {
      const first = chosen()[0]?.id;
      if (first) selection.focus(first);
    });
  };
  const failures = () => downloads.filter((item) => item.state === "error").length;
  const failed = () => failures() > 0;
  const ready = () => downloads.filter((item) => item.state === "done").length;
  const progress = () => t().downloading({ done: ready(), total: downloads.length, failed: failures() });

  const reason = (entry: FileProviderEntry) => {
    const why = problem(entry);
    if (!why) return undefined;
    return why === "size"
      ? { long: t().tooLarge({ limit: bytes(limit()) }), short: t().tooLargeShort({ limit: bytes(limit()) }) }
      : { long: t().wrongType, short: t().wrongTypeShort };
  };

  return (
    <FileDialogFrame
      ref={(element) => {
        root = element;
      }}
      title={t().title({ multiple })}
      close={() => props.close([])}
      overlay={
        // Files dropped anywhere on the open chooser are taken like files picked from this device.
        <FileDropTarget
          label={t().dropToChoose({ multiple })}
          accept={props.options.accept}
          multiple={multiple}
          disabled={downloading()}
          onDrop={(files) => {
            takeDevice(files);
          }}
        />
      }
      sources={
        <FileDialogSources
          label={t().sourceList}
          rows={sources()}
          current={current()}
          state={props.providers().state}
          loading={t().providersLoading}
          failed={t().providersFailed}
          retry={t().retry}
          disabled={downloading()}
          onOpen={openSource}
          onRetry={props.retryProviders}
        />
      }
      toolbar={location() ? <FolderToolbar folder={folder} t={t} disabled={downloading()} /> : undefined}
      status={
        <Switch>
          <Match when={downloading()}>{progress()}</Match>
          <Match when={deviceNote()}>{deviceNote()}</Match>
          <Match when={goneNote()}>{goneNote()}</Match>
          <Match when={!location()}>{null}</Match>
          <Match when={overLimit()}>{overLimit()}</Match>
          <Match when={chosen().length > 0}>{t().selected({ count: chosen().length })}</Match>
          <Match when={limits()}>{`${t().selectHint({ multiple })} · ${limits()}`}</Match>
          <Match when={true}>{t().selectHint({ multiple })}</Match>
        </Switch>
      }
      statusError={(!downloading() && Boolean(deviceNote() || (location() && overLimit()))) || (downloading() && failed())}
      actions={
        <>
          {/* Cancel stops a transfer first; Add tries failed files again. Add keeps one width for every count. */}
          <Button variant="secondary" data-file-chooser-cancel onClick={() => (downloading() ? stop() : props.close([]))}>
            {t().cancel}
          </Button>
          <Button
            class="cloud-file-chooser__add"
            variant="primary"
            disabled={!location() || chosen().length === 0 || Boolean(overLimit()) || (downloading() && !failed())}
            onClick={() => void add()}
          >
            {location() && chosen().length > 0 ? t().addCount({ count: chosen().length }) : t().add}
          </Button>
        </>
      }
    >
      <input
        ref={deviceInput}
        type="file"
        hidden
        accept={props.options.accept}
        multiple={multiple}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          takeDevice(files);
        }}
      />
      <Switch>
        <Match when={downloading()}>
          <ul class="cloud-file-chooser__downloads" aria-label={progress()}>
            <For each={downloads}>
              {(item) => (
                <li>
                  <div class="cloud-file-chooser__download-line">
                    <span class="cloud-file-chooser__download-name" title={item.entry.name}>
                      {item.entry.name}
                    </span>
                    <span class="cloud-file-chooser__download-state" data-state={item.state}>
                      <Switch fallback={<Format.Percent value={item.total ? item.loaded / item.total : 0} clamp />}>
                        <Match when={item.state === "waiting"}>{t().waiting}</Match>
                        <Match when={item.state === "done"}>{t().ready}</Match>
                        <Match when={item.state === "error" && item.reason === "size"}>{t().tooLarge({ limit: bytes(limit()) })}</Match>
                        <Match when={item.state === "error" && item.reason === "total" && maxTotal !== undefined}>
                          {t().tooLargeTogether({ limit: bytes(maxTotal ?? 0) })}
                        </Match>
                        <Match when={item.state === "error" && item.reason === "type"}>{t().wrongType}</Match>
                        <Match when={item.state === "error"}>{t().readFailed}</Match>
                      </Switch>
                    </span>
                  </div>
                  <ProgressBar
                    size="xs"
                    tone={item.state === "error" ? "danger" : item.state === "done" ? "success" : "info"}
                    value={item.state === "done" || item.state === "error" ? 100 : item.total ? (item.loaded / item.total) * 100 : 0}
                    label={t().downloadProgress({ name: item.entry.name })}
                  />
                </li>
              )}
            </For>
          </ul>
        </Match>
        <Match when={!location()}>
          <div class="cloud-file-dialog__device">
            <FileDropzone
              label={t().deviceLabel({ multiple })}
              icon="ti ti-upload"
              title={t().deviceTitle({ multiple })}
              subtitle={
                <>
                  <span class="cloud-file-dialog__wide">{t().deviceSubtitle}</span>
                  <span class="cloud-file-dialog__narrow">{t().deviceSubtitlePhone}</span>
                </>
              }
              hint={limits() ? `${limits().charAt(0).toLocaleUpperCase(locale())}${limits().slice(1)}` : undefined}
              accept={props.options.accept}
              multiple={multiple}
              dropLabel={t().dropToChoose({ multiple })}
              onDrop={(files) => {
                takeDevice(files);
              }}
            />
          </div>
        </Match>
        <Match when={true}>
          <FolderContents folder={folder} t={t} noMatchingFiles={props.options.noMatchingFiles}>
            <FileGrid
              rows={items()}
              getRowId={(entry) => entry.id}
              selection={selection}
              checks={(entry) => entry.kind === "file"}
              label={t().entries({ folder: folder.folderName() })}
              layout="list"
              renderPreview={(entry) => <EntryTile entry={entry} />}
              renderLabel={(entry) => (
                <span class="cloud-file-dialog__name-line">
                  <span class="cloud-file-dialog__name" title={entry.name}>
                    {entry.name}
                  </span>
                  <For each={entry.tags ?? []}>
                    {(tag) => (
                      <StatusBadge tone={TAG_TONES[tag.tone ?? "neutral"]} icon={null} label={tag.label} class="cloud-file-chooser__tag" />
                    )}
                  </For>
                </span>
              )}
              renderMeta={(entry) => (
                <span class="cloud-file-chooser__meta">
                  <Show when={reason(entry)} fallback={<EntryFacts entry={entry} folder={t().folder} />}>
                    {(why) => (
                      <>
                        <i class="ti ti-ban" aria-hidden="true" />
                        <span class="cloud-file-dialog__wide">{why().long}</span>
                        <span class="cloud-file-dialog__narrow">{why().short}</span>
                      </>
                    )}
                  </Show>
                </span>
              )}
              renderActions={(entry) =>
                entry.kind === "folder" ? <i class="ti ti-chevron-right cloud-file-dialog__chevron" aria-hidden="true" /> : null
              }
              onRowClick={(entry) => {
                if (entry.kind === "folder") openFolder(entry);
              }}
              onOpen={(entry) => {
                if (entry.kind === "folder") return openFolder(entry);
                if (!selection.selected().has(entry.id)) selection.toggle(entry.id);
                void add();
              }}
            />
          </FolderContents>
        </Match>
      </Switch>
    </FileDialogFrame>
  );
}
