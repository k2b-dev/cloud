import { timed } from "@k2b/stdlib/solid";
import { announce, Button, IconButton, Placeholder, TextInput } from "@k2b/ui";
import { batch, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { FILE_PROVIDER_CONTEXT_MAX_REFS, type FileProviderContext, type FileProviderEntry } from "../contracts/file-provider";
import type { fileChooserMessages } from "./file-chooser-messages";
import { FileDialogSkeletonRows } from "./file-dialog";
import { type FileProviderCaller, FileProviderError, type FileProviderSource, listProviderFolder } from "./file-providers";

type Messages = ReturnType<typeof fileChooserMessages.resolve>["t"];
type Crumb = { id?: string; name: string };
/** Where the dialog is: a folder of one provider, or no provider when `null`. */
export type FolderLocation = { provider: FileProviderSource; trail: readonly Crumb[] } | null;

/** Empty pages may still continue; a dialog follows at most this many of them before it shows "Load more". */
const EMPTY_PAGES_FOLLOWED = 5;
/** A folder shows at most this many entries; past them, the name filter finds the rest. */
export const FOLDER_ENTRY_LIMIT = 500;

/**
 * Browsing one provider's folders, shared by choosing and saving: the location, the name filter, the folder's pages,
 * and its load state. `settled` runs after a folder has loaded or the dialog left the provider, so the dialog can move
 * focus. When a provider's root answers 403 or 404, the provider is gone for this person: `gone` receives it and
 * the dialog leaves it, instead of showing a folder error.
 */
export const createProviderFolder = (props: {
  caller: () => FileProviderCaller;
  t: () => Messages;
  settled: () => void;
  gone: (provider: FileProviderSource) => void;
  context?: FileProviderContext | ((signal: AbortSignal) => Promise<FileProviderContext>);
}) => {
  const [location, setLocation] = createSignal<FolderLocation>(null);
  const [filter, setFilter] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<FileProviderEntry[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [writable, setWritable] = createSignal(false);
  const [status, setStatus] = createSignal<"loading" | "ready" | "more" | "error">("ready");
  const [error, setError] = createSignal<FileProviderError | null>(null);
  const [contextual, setContextual] = createSignal(false);
  let resolvedContext: FileProviderContext | undefined;
  const contextFor = async (signal: AbortSignal): Promise<FileProviderContext> => {
    if (resolvedContext) return resolvedContext;
    const raw = typeof props.context === "function" ? await props.context(signal) : props.context;
    signal.throwIfAborted();
    const refs: FileProviderContext["refs"] = [];
    const seen = new Set<string>();
    for (const value of raw?.refs ?? []) {
      const parsed = CloudResourceRefSchema.safeParse(value);
      if (!parsed.success) continue;
      const key = JSON.stringify([parsed.data.type, parsed.data.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(parsed.data);
      if (refs.length === FILE_PROVIDER_CONTEXT_MAX_REFS) break;
    }
    resolvedContext = { refs };
    return resolvedContext;
  };
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());

  const folderName = () => location()?.trail.at(-1)?.name ?? props.t().sources;

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
        setWritable(false);
      });
    }
    setStatus(more ? "more" : "loading");
    setError(null);
    try {
      const context = current.provider.context === true && props.context !== undefined ? await contextFor(pending.signal) : undefined;
      if (pending.signal.aborted) return;
      setContextual(context !== undefined);
      let cursor = more ? (next() ?? undefined) : undefined;
      let followed = 0;
      for (;;) {
        const page = await listProviderFolder(
          current.provider,
          { parent: current.trail.at(-1)?.id, query: query() || undefined, cursor, context },
          props.caller(),
          pending.signal,
        );
        if (pending.signal.aborted) return;
        batch(() => {
          setItems((previous) => [...previous, ...page.items]);
          setNext(page.next);
          if (!more) setWritable(page.writable);
        });
        if (items().length > 0 || !page.next || ++followed >= EMPTY_PAGES_FOLLOWED) break;
        cursor = page.next;
      }
      setStatus("ready");
      if (!more) {
        announce(props.t().folderAnnounced({ folder: folderName(), count: items().length, more: Boolean(next()) }));
        props.settled();
      }
    } catch (cause) {
      if (pending.signal.aborted) return;
      const failure =
        cause instanceof FileProviderError ? cause : new FileProviderError("INTERNAL", cause instanceof Error ? cause.message : "", 500);
      if (!more && current.trail.length === 1 && (failure.status === 403 || failure.status === 404)) {
        navigate(null);
        props.gone(current.provider);
        return;
      }
      setError(failure);
      setStatus(more ? "ready" : "error");
    }
  };

  const applyQuery = (value: string) => {
    setQuery(value.trim());
    void load();
  };
  const { debouncedFn: applyFilter, cancel: cancelFilter } = timed.debounce(applyQuery, 250);
  onCleanup(cancelFilter);
  const clearFilter = () => {
    cancelFilter();
    setFilter("");
    if (location() && query()) applyQuery("");
  };
  const changeFilter = (value: string) => {
    setFilter(value);
    if (location()) applyFilter(value);
  };

  const navigate = (target: FolderLocation) => {
    cancelFilter();
    request?.abort();
    batch(() => {
      setFilter("");
      setQuery("");
      setLocation(target);
      setContextual(false);
      setItems([]);
      setNext(null);
      setWritable(false);
      setError(null);
      setStatus(target ? "loading" : "ready");
    });
    if (target) void load();
    else props.settled();
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

  const errorView = createMemo(() => {
    const value = error();
    if (!value) return null;
    const t = props.t();
    const app = location()?.provider.name ?? "";
    if (value.status === 0) return { icon: "ti ti-wifi-off", title: t.offline, description: t.offlineHint, retry: true };
    if (value.status === 403) return { icon: "ti ti-lock", title: t.noAccess, description: t.backHint, retry: false };
    if (value.status === 404) return { icon: "ti ti-folder-off", title: t.notFound, description: t.backHint, retry: false };
    if (value.status >= 502 || value.code === "APP_UNAVAILABLE")
      return { icon: undefined, title: t.unavailable({ app }), description: t.unavailableHint, retry: true };
    return { icon: undefined, title: t.loadFailed, description: value.message || undefined, retry: true };
  });

  return {
    location,
    contextual,
    filter,
    query,
    items,
    next,
    writable,
    status,
    error,
    errorView,
    folderName,
    load,
    navigate,
    openProvider,
    openFolder,
    up,
    changeFilter,
    clearFilter,
  };
};

export type ProviderFolder = ReturnType<typeof createProviderFolder>;

/**
 * The path row with Up and the name filter. The path starts at the provider, so Up stops there. On a phone the filter
 * hides behind a button and takes the path's place while it is open.
 */
export function FolderToolbar(props: { folder: ProviderFolder; t: () => Messages; disabled: boolean }): JSX.Element {
  const [searching, setSearching] = createSignal(false);
  const top = () => (props.folder.location()?.trail.length ?? 1) <= 1;
  const toggleSearch = () => {
    if (searching()) props.folder.clearFilter();
    setSearching(!searching());
  };
  return (
    <div class="cloud-file-chooser__toolbar" data-searching={searching() ? "true" : undefined}>
      <nav class="cloud-file-chooser__crumbs" aria-label={props.t().breadcrumbs}>
        <IconButton size="sm" variant="ghost" label={props.t().up} disabled={top() || props.disabled} onClick={props.folder.up}>
          <i class="ti ti-arrow-up" aria-hidden="true" />
        </IconButton>
        <ol>
          <For each={props.folder.location()?.trail ?? []}>
            {(crumb, index) => {
              const last = () => index() === (props.folder.location()?.trail.length ?? 0) - 1;
              return (
                <li>
                  <Show when={index() > 0}>
                    <span aria-hidden="true">/</span>
                  </Show>
                  <Button
                    size="sm"
                    variant={last() ? "subtle" : "text"}
                    aria-current={last() ? "location" : undefined}
                    disabled={props.disabled}
                    onClick={() => {
                      const current = props.folder.location();
                      if (current && !last())
                        props.folder.navigate({ provider: current.provider, trail: current.trail.slice(0, index() + 1) });
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
        aria-label={props.t().filter}
        placeholder={props.t().filter}
        maxLength={200}
        disabled={props.disabled || props.folder.status() === "loading" || props.folder.status() === "error"}
        value={props.folder.filter}
        onValueChange={props.folder.changeFilter}
        clearable
        onClear={props.folder.clearFilter}
      />
      <span class="cloud-file-chooser__filter-toggle">
        <IconButton size="sm" variant="ghost" label={searching() ? props.t().closeFilter : props.t().filter} onClick={toggleSearch}>
          <i class={searching() ? "ti ti-x" : "ti ti-filter"} aria-hidden="true" />
        </IconButton>
      </span>
    </div>
  );
}

/**
 * One folder in the dialog: placeholder rows while it loads, the error with Try again or Up, the empty folder, no
 * matches, or `children` with Load more below while the folder continues. Past `FOLDER_ENTRY_LIMIT` entries, a hint to
 * filter takes the place of Load more.
 */
export function FolderContents(props: {
  folder: ProviderFolder;
  t: () => Messages;
  noMatchingFiles?: string;
  children: JSX.Element;
}): JSX.Element {
  const folder = props.folder;
  return (
    <Switch>
      <Match when={folder.status() === "loading"}>
        <FileDialogSkeletonRows label={props.t().loading} />
      </Match>
      <Match when={folder.status() === "error" && folder.errorView()}>
        {(view) => (
          <Placeholder
            state="error"
            variant="panel"
            class="cloud-file-chooser__state"
            icon={view().icon}
            title={view().title}
            description={view().description}
            action={
              view().retry ? (
                <Button size="sm" variant="secondary" onClick={() => void folder.load()}>
                  {props.t().retry}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={folder.up}>
                  <i class="ti ti-arrow-up" aria-hidden="true" /> {props.t().up}
                </Button>
              )
            }
          />
        )}
      </Match>
      <Match when={folder.items().length === 0 && !folder.next()}>
        <Show
          when={folder.query()}
          fallback={
            <Show
              when={folder.contextual() && folder.location()?.trail.length === 1}
              fallback={<Placeholder variant="panel" class="cloud-file-chooser__state" icon="ti ti-folder" title={props.t().emptyFolder} />}
            >
              <Placeholder
                variant="panel"
                class="cloud-file-chooser__state"
                icon="ti ti-file-search"
                title={props.noMatchingFiles ?? props.t().noMatchingFiles}
              />
            </Show>
          }
        >
          <Placeholder
            variant="panel"
            class="cloud-file-chooser__state"
            icon="ti ti-filter-off"
            title={props.t().noMatches({ query: folder.query() })}
            action={
              <Button size="sm" variant="secondary" onClick={folder.clearFilter}>
                {props.t().clearFilter}
              </Button>
            }
          />
        </Show>
      </Match>
      <Match when={true}>
        <div class="cloud-file-dialog__list">
          {props.children}
          <div class="cloud-file-chooser__more">
            <Show when={folder.error() && folder.status() === "ready"}>
              <Placeholder state="error" variant="inline" align="left" description={folder.errorView()?.title} />
            </Show>
            <Show when={folder.next()}>
              <Show
                when={folder.items().length < FOLDER_ENTRY_LIMIT}
                fallback={<span class="cloud-file-chooser__limit">{props.t().useFilter({ count: FOLDER_ENTRY_LIMIT })}</span>}
              >
                <Button variant="secondary" size="sm" loading={folder.status() === "more"} onClick={() => void folder.load(true)}>
                  {folder.error() ? props.t().retry : props.t().loadMore}
                </Button>
              </Show>
            </Show>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
