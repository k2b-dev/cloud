import { fileIcons, text } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import {
  announce,
  Button,
  createCollectionSelection,
  FileDropTarget,
  FileGrid,
  Format,
  IconButton,
  PanelDialog,
  Placeholder,
  ProgressBar,
  StatusBadge,
  type StatusTone,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { batch, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import type { FileProviderEntry, FileProviderTag } from "../contracts/file-provider";
import { fileChooserMessages } from "./file-chooser-messages";
import {
  type EntryProblem,
  eachLimited,
  entryProblem,
  FILE_PROVIDER_PARALLEL_READS,
  type FileProviderCaller,
  FileProviderError,
  type FileProviderSource,
  listProviderFolder,
  providerIcon,
  readProviderFile,
} from "./file-providers";

export type ChooseFilesOptions = {
  /** `<input accept>` syntax, for example `"image/*,.pdf"`. */
  accept?: string;
  /** Allow choosing several files. Defaults to `false`. */
  multiple?: boolean;
  /**
   * The most bytes the consumer takes from providers in one choice: no single file and no selection together goes
   * above it, so it also bounds what the browser holds. The provider's own read limit applies to each file as well.
   */
  maxBytes?: number;
  /** Closes the chooser, or stops waiting for the device's dialog, and resolves `[]` when aborted. */
  signal?: AbortSignal;
};

export type FileProviderList = { state: "loading" } | { state: "ready"; providers: readonly FileProviderSource[] } | { state: "error" };

type FileEntry = Extract<FileProviderEntry, { kind: "file" }>;
type Crumb = { id?: string; name: string };
type Location = { provider: FileProviderSource; trail: readonly Crumb[] } | null;
type SourceRow = { id: string; name: string; icon: string; provider?: FileProviderSource };
type Download = {
  entry: FileEntry;
  loaded: number;
  total: number;
  state: "waiting" | "loading" | "done" | "error";
  file?: File;
  /** Why a read was refused: the file changed after it was listed and no longer fits. */
  reason?: EntryProblem;
};

/** Empty pages may still continue; the chooser follows at most this many of them before it shows "Load more". */
const EMPTY_PAGES_FOLLOWED = 5;

const TAG_TONES: Record<NonNullable<FileProviderTag["tone"]>, StatusTone> = {
  neutral: "neutral",
  info: "info",
  success: "ok",
  warning: "warning",
  danger: "error",
};

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const entryIcon = (entry: FileProviderEntry) =>
  providerIcon(entry.icon, `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.kind === "folder" ? "directory" : "file" })}`);

/**
 * The shared file chooser: "This device" first, then every provider; inside a provider, its folders page by page.
 * It resolves the chosen files, read through the providers' streams, or `[]`.
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
  let deviceInput: HTMLInputElement | undefined;
  let root: HTMLDivElement | undefined;

  const [location, setLocation] = createSignal<Location>(null);
  const [filter, setFilter] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<FileProviderEntry[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "more" | "error">("ready");
  const [error, setError] = createSignal<FileProviderError | null>(null);
  const [downloads, setDownloads] = createStore<Download[]>([]);
  const [downloading, setDownloading] = createSignal(false);
  let request: AbortController | undefined;
  let transfer: AbortController | undefined;
  onCleanup(() => {
    request?.abort();
    transfer?.abort();
  });

  const budget = props.options.maxBytes ?? Number.POSITIVE_INFINITY;
  /** The largest single file: the consumer's budget or the provider's read limit, whichever is smaller. */
  const limit = () => Math.min(budget, location()?.provider.maxBytes ?? Number.POSITIVE_INFINITY);
  const problem = (entry: FileProviderEntry): EntryProblem | undefined => entryProblem(entry, props.options.accept, limit());

  // Rows keep their identity, so providers that arrive later do not re-create the row that has focus.
  const device = createMemo<SourceRow>(() => ({ id: "device", name: t().device, icon: "ti ti-device-laptop" }));
  const providerRows = new Map<FileProviderSource, SourceRow>();
  const providerRow = (provider: FileProviderSource): SourceRow => {
    const row = providerRows.get(provider) ?? { id: `app:${provider.appId}`, name: provider.name, icon: provider.icon, provider };
    providerRows.set(provider, row);
    return row;
  };
  const sources = createMemo<SourceRow[]>(() => {
    const list = props.providers();
    const rows = [device(), ...(list.state === "ready" ? list.providers.map(providerRow) : [])];
    const needle = filter().trim().toLocaleLowerCase();
    return needle ? rows.filter((row) => row.name.toLocaleLowerCase().includes(needle)) : rows;
  });
  // Sources open on activation and keep no selection, so Escape always closes the chooser from here.
  const sourceSelection = createCollectionSelection({ ids: () => sources().map((row) => row.id), multiple: false, checklist: true });
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
  const overBudget = () => chosen().reduce((sum, entry) => sum + entry.size, 0) > budget;

  const folderName = () => location()?.trail.at(-1)?.name ?? t().sources;

  const load = async (more = false) => {
    const current = location();
    if (!current) return;
    request?.abort();
    const pending = new AbortController();
    request = pending;
    if (!more) {
      batch(() => {
        setItems([]);
        setNext(null);
      });
    }
    setStatus(more ? "more" : "loading");
    setError(null);
    try {
      let cursor = more ? (next() ?? undefined) : undefined;
      let followed = 0;
      for (;;) {
        const page = await listProviderFolder(
          current.provider,
          { parent: current.trail.at(-1)?.id, query: query() || undefined, cursor },
          props.caller(),
          pending.signal,
        );
        if (pending.signal.aborted) return;
        batch(() => {
          setItems((previous) => [...previous, ...page.items]);
          setNext(page.next);
        });
        if (items().length > 0 || !page.next || ++followed >= EMPTY_PAGES_FOLLOWED) break;
        cursor = page.next;
      }
      setStatus("ready");
      if (!more) {
        announce(t().folderAnnounced({ folder: folderName(), count: items().length, more: Boolean(next()) }));
        refocus();
      }
    } catch (cause) {
      if (pending.signal.aborted) return;
      setError(
        cause instanceof FileProviderError ? cause : new FileProviderError("INTERNAL", cause instanceof Error ? cause.message : "", 500),
      );
      setStatus(more ? "ready" : "error");
    }
  };

  /** After navigation the activated row is gone; give focus to the first row so the keyboard continues there. */
  const refocus = () => {
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && root?.contains(active) && active.isConnected && active.tagName !== "DIALOG") return;
      const first = location() ? items()[0]?.id : sources()[0]?.id;
      if (first) (location() ? selection : sourceSelection).focus(first);
    });
  };

  const applyQuery = (value: string) => {
    setQuery(value.trim());
    void load();
  };
  const { debouncedFn: applyFilter, cancel: cancelFilter } = timed.debounce(applyQuery, 250);
  const clearFilter = () => {
    cancelFilter();
    setFilter("");
    if (location() && query()) applyQuery("");
  };

  const navigate = (next: Location) => {
    cancelFilter();
    request?.abort();
    batch(() => {
      setFilter("");
      setQuery("");
      setLocation(next);
      setItems([]);
      setNext(null);
      setError(null);
      setStatus(next ? "loading" : "ready");
    });
    if (next) void load();
    else refocus();
  };
  const openProvider = (provider: FileProviderSource) => navigate({ provider, trail: [{ name: provider.name }] });
  const openFolder = (entry: FileProviderEntry) => {
    const current = location();
    if (current) navigate({ provider: current.provider, trail: [...current.trail, { id: entry.id, name: entry.name }] });
  };
  const up = () => {
    const current = location();
    if (!current) return;
    navigate(current.trail.length > 1 ? { provider: current.provider, trail: current.trail.slice(0, -1) } : null);
  };

  const openSource = (row: SourceRow) => {
    sourceSelection.clear();
    // A click or key press on the row is the user activation the native picker needs.
    if (!row.provider) deviceInput?.click();
    else openProvider(row.provider);
  };

  const add = async () => {
    const files = chosen();
    if (files.length === 0 || overBudget() || (downloading() && !failed())) return;
    const current = location();
    if (!current) return;
    transfer?.abort();
    const pending = new AbortController();
    transfer = pending;
    // Only a retry of this transfer finds earlier downloads: Cancel clears them, and the location cannot change
    // while a transfer is shown, so a finished file never stands in for another provider's file with the same ID.
    const previous = new Map(downloads.filter((item) => item.state === "done").map((item) => [item.entry.id, item]));
    setDownloads(files.map((entry) => previous.get(entry.id) ?? { entry, loaded: 0, total: entry.size, state: "waiting" }));
    setDownloading(true);
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>("[data-file-chooser-cancel]")?.focus());
    await eachLimited(
      downloads.map((_, index) => index),
      FILE_PROVIDER_PARALLEL_READS,
      async (index) => {
        if (pending.signal.aborted || downloads[index]!.state === "done") return;
        setDownloads(index, { state: "loading", loaded: 0 });
        try {
          const file = await readProviderFile(current.provider, downloads[index]!.entry, {
            ...props.caller(),
            maxBytes: limit(),
            accept: props.options.accept,
            signal: pending.signal,
            onProgress: (loaded, total) => setDownloads(index, { loaded, total }),
          });
          if (!pending.signal.aborted) setDownloads(index, { state: "done", file });
        } catch (cause) {
          const code = cause instanceof FileProviderError ? cause.code : "";
          const reason = code === "FILE_TOO_LARGE" ? "size" : code === "UNSUPPORTED_MEDIA_TYPE" ? "type" : undefined;
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

  const errorView = createMemo(() => {
    const value = error();
    if (!value) return null;
    const app = location()?.provider.name ?? "";
    if (value.status === 0) return { title: t().offline, description: t().offlineHint, retry: true };
    if (value.status === 403) return { title: t().noAccess, description: t().backHint, retry: false };
    if (value.status === 404) return { title: t().notFound, description: t().backHint, retry: false };
    if (value.status >= 502 || value.code === "APP_UNAVAILABLE")
      return { title: t().unavailable({ app }), description: t().unavailableHint, retry: true };
    return { title: t().loadFailed, description: value.message || undefined, retry: true };
  });

  const renderTags = (tags: readonly FileProviderTag[] | undefined) => (
    <For each={tags ?? []}>
      {(tag) => <StatusBadge tone={TAG_TONES[tag.tone ?? "neutral"]} icon={null} label={tag.label} class="cloud-file-chooser__tag" />}
    </For>
  );

  return (
    <PanelDialog>
      {/* `display: contents`, so header, body, and footer stay the panel's own rows. */}
      <div ref={root} class="cloud-file-chooser">
        <PanelDialog.Header title={t().title({ multiple })} close={() => props.close([])} />
        {/* Files dropped anywhere on the open chooser are taken like files picked from this device. */}
        <FileDropTarget
          label={t().dropToChoose({ multiple })}
          accept={props.options.accept}
          multiple={multiple}
          disabled={downloading()}
          onDrop={(files) => {
            if (files.length > 0) props.close(files);
          }}
        />
        <div class="cloud-file-chooser__toolbar">
          <nav class="cloud-file-chooser__crumbs" aria-label={t().breadcrumbs}>
            <IconButton size="sm" variant="ghost" label={t().up} disabled={!location() || downloading()} onClick={up}>
              <i class="ti ti-arrow-up" aria-hidden="true" />
            </IconButton>
            <ol>
              <li>
                <Button
                  size="sm"
                  variant={location() ? "text" : "subtle"}
                  aria-current={location() ? undefined : "location"}
                  disabled={downloading()}
                  onClick={() => navigate(null)}
                >
                  {t().sources}
                </Button>
              </li>
              <For each={location()?.trail ?? []}>
                {(crumb, index) => {
                  const last = () => index() === (location()?.trail.length ?? 0) - 1;
                  return (
                    <li>
                      <span aria-hidden="true">/</span>
                      <Button
                        size="sm"
                        variant={last() ? "subtle" : "text"}
                        aria-current={last() ? "location" : undefined}
                        disabled={downloading()}
                        onClick={() => {
                          const current = location();
                          if (current && !last()) navigate({ provider: current.provider, trail: current.trail.slice(0, index() + 1) });
                        }}
                      >
                        {crumb.name}
                      </Button>
                    </li>
                  );
                }}
              </For>
            </ol>
          </nav>
          <TextInput
            class="cloud-file-chooser__filter"
            type="search"
            icon="ti ti-filter"
            aria-label={t().filter}
            placeholder={t().filter}
            maxLength={200}
            disabled={downloading()}
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              if (location()) applyFilter(value);
            }}
            clearable
            onClear={clearFilter}
          />
        </div>
        <PanelDialog.Body>
          <input
            ref={deviceInput}
            type="file"
            hidden
            accept={props.options.accept}
            multiple={multiple}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length > 0) props.close(files);
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
                            <Match when={item.state === "error" && item.reason === "size"}>
                              {t().tooLarge({ limit: text.pprintBytes(limit(), { locale: locale() }) })}
                            </Match>
                            <Match when={item.state === "error" && item.reason === "type"}>{t().wrongType}</Match>
                            <Match when={item.state === "error"}>{t().readFailed}</Match>
                          </Switch>
                        </span>
                      </div>
                      <ProgressBar
                        size="xs"
                        tone={item.state === "error" ? "danger" : item.state === "done" ? "success" : "info"}
                        value={item.state === "done" ? 100 : item.total ? (item.loaded / item.total) * 100 : 0}
                        label={t().downloadProgress({ name: item.entry.name })}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Match>
            <Match when={!location()}>
              <FileGrid
                rows={sources()}
                getRowId={(row) => row.id}
                selection={sourceSelection}
                label={t().sourceList}
                layout="list"
                renderPreview={(row) => <i class={`${row.icon} cloud-file-chooser__icon`} aria-hidden="true" />}
                renderLabel={(row) => row.name}
                onRowClick={openSource}
                onOpen={openSource}
              />
              <Switch>
                <Match when={props.providers().state === "loading"}>
                  <Placeholder state="loading" variant="inline" align="left" description={t().providersLoading} />
                </Match>
                <Match when={props.providers().state === "error"}>
                  <Placeholder
                    state="error"
                    variant="inline"
                    align="left"
                    description={t().providersFailed}
                    action={
                      <Button size="sm" variant="secondary" onClick={props.retryProviders}>
                        {t().retry}
                      </Button>
                    }
                  />
                </Match>
              </Switch>
            </Match>
            <Match when={status() === "loading"}>
              <Placeholder state="loading" variant="panel" class="cloud-file-chooser__state" description={t().loading} />
            </Match>
            <Match when={status() === "error" && errorView()}>
              {(view) => (
                <Placeholder
                  state="error"
                  variant="panel"
                  class="cloud-file-chooser__state"
                  title={view().title}
                  description={view().description}
                  action={
                    view().retry ? (
                      <Button size="sm" variant="secondary" onClick={() => void load()}>
                        {t().retry}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={up}>
                        <i class="ti ti-arrow-up" aria-hidden="true" /> {t().up}
                      </Button>
                    )
                  }
                />
              )}
            </Match>
            <Match when={items().length === 0 && !next()}>
              <Show
                when={query()}
                fallback={<Placeholder variant="panel" class="cloud-file-chooser__state" icon="ti ti-folder" title={t().emptyFolder} />}
              >
                <Placeholder
                  variant="panel"
                  class="cloud-file-chooser__state"
                  icon="ti ti-filter-off"
                  title={t().noMatches({ query: query() })}
                  action={
                    <Button size="sm" variant="secondary" onClick={clearFilter}>
                      {t().clearFilter}
                    </Button>
                  }
                />
              </Show>
            </Match>
            <Match when={true}>
              <FileGrid
                rows={items()}
                getRowId={(entry) => entry.id}
                selection={selection}
                label={t().entries({ folder: folderName() })}
                layout="list"
                renderPreview={(entry) => (
                  <i
                    class={`${selection.selected().has(entry.id) && entry.kind === "file" ? "ti ti-circle-check" : entryIcon(entry)} cloud-file-chooser__icon`}
                    data-selected={selection.selected().has(entry.id) && entry.kind === "file" ? "true" : undefined}
                    aria-hidden="true"
                  />
                )}
                renderLabel={(entry) => <span title={entry.name}>{entry.name}</span>}
                renderMeta={(entry) =>
                  entry.kind === "folder" && !entry.tags?.length ? null : (
                    <span class="cloud-file-chooser__meta">
                      <Switch>
                        <Match when={entry.kind === "file" && problem(entry) === "size"}>
                          <span>{t().tooLarge({ limit: text.pprintBytes(limit(), { locale: locale() }) })}</span>
                        </Match>
                        <Match when={entry.kind === "file" && problem(entry) === "type"}>
                          <span>{t().wrongType}</span>
                        </Match>
                        <Match when={entry.kind === "file" ? entry : undefined}>
                          {(file) => (
                            <>
                              <Format.Bytes value={file().size} />
                              <Show when={file().updatedAt}>
                                {(updated) => (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <Format.Date value={updated()} timeZone={localTimeZone()} />
                                  </>
                                )}
                              </Show>
                            </>
                          )}
                        </Match>
                      </Switch>
                      {renderTags(entry.tags)}
                    </span>
                  )
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
              <div class="cloud-file-chooser__more">
                <Show when={error() && status() === "ready"}>
                  <Placeholder state="error" variant="inline" align="left" description={errorView()?.title} />
                </Show>
                <Show when={next()}>
                  <Button variant="secondary" size="sm" loading={status() === "more"} onClick={() => void load(true)}>
                    {error() ? t().retry : t().loadMore}
                  </Button>
                </Show>
              </div>
            </Match>
          </Switch>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span class="cloud-file-chooser__status" role="status">
            <Switch>
              <Match when={downloading()}>{progress()}</Match>
              <Match when={!location()}>{null}</Match>
              <Match when={overBudget()}>{t().tooLargeTogether({ limit: text.pprintBytes(budget, { locale: locale() }) })}</Match>
              <Match when={chosen().length > 0}>{t().selected({ count: chosen().length })}</Match>
              <Match when={true}>{t().selectHint({ multiple })}</Match>
            </Switch>
          </span>
          {/* Labels never change, so the buttons keep their place. Cancel stops a transfer first; Add tries failed files again. */}
          <div class="cloud-file-chooser__actions">
            <Button variant="ghost" data-file-chooser-cancel onClick={() => (downloading() ? stop() : props.close([]))}>
              {t().cancel}
            </Button>
            <Show when={location()}>
              <Button
                variant="primary"
                disabled={chosen().length === 0 || overBudget() || (downloading() && !failed())}
                onClick={() => void add()}
              >
                {t().add}
              </Button>
            </Show>
          </div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}
