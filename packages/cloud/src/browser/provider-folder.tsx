import { timed } from "@k2b/stdlib/solid";
import { announce, Breadcrumbs, Button, createDelayedLoading, IconButton, Placeholder, TextInput } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { FILE_PROVIDER_CONTEXT_MAX_REFS, type FileProviderContext, type FileProviderEntry } from "../contracts/file-provider";
import type { fileChooserMessages } from "./file-chooser-messages";
import { FileDialogSkeletonRows } from "./file-dialog";
import { type FileProviderCaller, FileProviderError, type FileProviderSource, listProviderFolder } from "./file-providers";

type Messages = ReturnType<typeof fileChooserMessages.resolve>["t"];
export type Crumb = { id?: string; name: string };
/** Where the dialog is: a folder of one provider, or no provider when `null`. */
export type FolderLocation = { provider: FileProviderSource; trail: readonly Crumb[] } | null;

/** Empty pages may still continue; a dialog follows at most this many of them before it shows "Load more". */
const EMPTY_PAGES_FOLLOWED = 5;
/** A folder shows at most this many entries; past them, the name filter finds the rest. */
export const FOLDER_ENTRY_LIMIT = 500;

/**
 * Browsing one provider's folders, shared by choosing and saving: the location, the name filter, the folder's pages,
 * and its load state. `settled` runs after a folder has loaded and shows, or the dialog left the provider, so the dialog
 * can move focus. When a provider's root answers 403 or 404, the provider is gone for this person: `gone` receives it
 * and the dialog leaves it, instead of showing a folder error. With `tree`, the name filter of a provider that supports
 * it searches the folders below as well.
 *
 * Placeholder rows show only when a folder takes longer than 200 ms and then stay at least 300 ms; until then a new
 * filter keeps the previous results in place, so typing never flickers.
 */
export const createProviderFolder = (props: {
  caller: () => FileProviderCaller;
  t: () => Messages;
  settled: () => void;
  gone: (provider: FileProviderSource) => void;
  context?: FileProviderContext | ((signal: AbortSignal) => Promise<FileProviderContext>);
  tree?: boolean;
  /** A deeper folder answered 403 or 404; return true when the dialog handled it, such as by opening the root instead. */
  missing?: (provider: FileProviderSource) => boolean;
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
  /** Whether the open provider searches below the folder; the filter says which it does. */
  const searchesTree = () => props.tree === true && location()?.provider.tree === true;
  const placeholder = createDelayedLoading(() => status() === "loading");
  // Focus waits for the rows: a folder that loaded while its placeholder still holds settles once the rows show.
  const [settling, setSettling] = createSignal(false);
  createEffect(() => {
    if (!settling() || placeholder()) return;
    setSettling(false);
    props.settled();
  });

  /** `keep` leaves the shown entries in place until the new page arrives, as a new filter does. */
  const load = async (more = false, keep = false) => {
    const current = location();
    if (!current) return;
    request?.abort();
    const pending = new AbortController();
    request = pending;
    if (!more && !keep) {
      batch(() => {
        setItems([]);
        setNext(null);
        setWritable(false);
      });
    }
    // Kept rows belong to the earlier query: its cursor must not continue the new one.
    if (keep) setNext(null);
    setStatus(more ? "more" : "loading");
    if (!more) setError(null);
    try {
      const context = current.provider.context === true && props.context !== undefined ? await contextFor(pending.signal) : undefined;
      if (pending.signal.aborted) return;
      setContextual(context !== undefined);
      let cursor = more ? (next() ?? undefined) : undefined;
      let followed = 0;
      let first = !more;
      for (;;) {
        const page = await listProviderFolder(
          current.provider,
          { parent: current.trail.at(-1)?.id, query: query() || undefined, cursor, context, tree: props.tree },
          props.caller(),
          pending.signal,
        );
        if (pending.signal.aborted) return;
        // Kept entries give way to the first page of the new answer, in the same update.
        const replace = first && keep;
        first = false;
        batch(() => {
          // An ID names one entry: a repeated one, on this page or an earlier one, is left out.
          setItems((shown) => {
            const previous = replace ? [] : shown;
            const seen = new Set(previous.map((entry) => entry.id));
            const fresh = page.items.filter((entry) => {
              if (seen.has(entry.id)) return false;
              seen.add(entry.id);
              return true;
            });
            return [...previous, ...fresh];
          });
          setNext(page.next);
          if (!more) setWritable(page.writable);
        });
        if (items().length > 0 || !page.next || ++followed >= EMPTY_PAGES_FOLLOWED) break;
        cursor = page.next;
      }
      setError(null);
      setStatus("ready");
      if (!more) {
        announce(props.t().folderAnnounced({ folder: folderName(), count: items().length, more: Boolean(next()) }));
        setSettling(true);
      }
    } catch (cause) {
      if (pending.signal.aborted) return;
      const failure =
        cause instanceof FileProviderError ? cause : new FileProviderError("INTERNAL", cause instanceof Error ? cause.message : "", 500);
      if (!more && (failure.status === 403 || failure.status === 404)) {
        if (current.trail.length === 1) {
          navigate(null);
          props.gone(current.provider);
          return;
        }
        if (props.missing?.(current.provider)) return;
      }
      setError(failure);
      setStatus(more ? "ready" : "error");
    }
  };

  const applyQuery = (value: string) => {
    setQuery(value.trim());
    void load(false, true);
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
    if (!location()) return;
    // A result for what was typed before is no longer wanted: stop it now and keep the shown rows until the next one.
    if (status() === "loading" && items().length > 0) {
      request?.abort();
      setStatus("ready");
    }
    applyFilter(value);
  };

  const navigate = (target: FolderLocation) => {
    cancelFilter();
    request?.abort();
    setSettling(false);
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
    searchesTree,
    placeholder,
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
 * The path row and the name filter. The path starts at the provider; every level above the open folder is a link. On a
 * phone the filter hides behind a button and takes the path's place while it is open. The filter says whether it
 * searches the subfolders too.
 */
export function FolderToolbar(props: { folder: ProviderFolder; t: () => Messages; disabled: boolean }): JSX.Element {
  const [searching, setSearching] = createSignal(false);
  const toggleSearch = () => {
    if (searching()) props.folder.clearFilter();
    setSearching(!searching());
  };
  const label = () => (props.folder.searchesTree() ? props.t().searchBelow : props.t().filter);
  const icon = () => (props.folder.searchesTree() ? "ti ti-search" : "ti ti-filter");
  return (
    <div class="cloud-file-chooser__toolbar" data-searching={searching() ? "true" : undefined}>
      <Breadcrumbs
        class="cloud-file-chooser__crumbs"
        label={props.t().breadcrumbs}
        items={(props.folder.location()?.trail ?? []).map((crumb) => ({ label: crumb.name }))}
        disabled={props.disabled}
        onSelect={(index: number) => {
          const current = props.folder.location();
          if (current) props.folder.navigate({ provider: current.provider, trail: current.trail.slice(0, index + 1) });
        }}
      />
      <TextInput
        class="cloud-file-chooser__filter"
        type="search"
        icon={icon()}
        aria-label={label()}
        placeholder={label()}
        maxLength={200}
        disabled={props.disabled}
        value={props.folder.filter}
        onValueChange={props.folder.changeFilter}
        clearable
        onClear={props.folder.clearFilter}
      />
      <span class="cloud-file-chooser__filter-toggle">
        <IconButton size="sm" variant="ghost" label={searching() ? props.t().closeFilter : label()} onClick={toggleSearch}>
          <i class={searching() ? "ti ti-x" : icon()} aria-hidden="true" />
        </IconButton>
      </span>
    </div>
  );
}

/**
 * One folder in the dialog: placeholder rows while it loads, the error with Try again or Up, the empty folder, no
 * matches, or `children` with Load more below while the folder continues. Past `FOLDER_ENTRY_LIMIT` entries, a hint to
 * filter takes the place of Load more. Before the placeholder shows, a new filter keeps the previous rows and a new
 * folder keeps its place empty.
 */
export function FolderContents(props: {
  folder: ProviderFolder;
  t: () => Messages;
  noMatchingFiles?: string;
  /** The person pointed at or pressed a key in the list, as opposed to focus the dialog moved there. */
  onUse?: () => void;
  children: JSX.Element;
}): JSX.Element {
  const folder = props.folder;
  return (
    <Switch>
      <Match when={folder.placeholder()}>
        <FileDialogSkeletonRows label={props.t().loading} />
      </Match>
      <Match when={folder.status() === "loading" && folder.items().length === 0}>
        <div class="cloud-file-dialog__list" aria-busy="true" />
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
          {/* The filter's own × clears it; the state needs no second action. */}
          <Placeholder
            variant="panel"
            class="cloud-file-chooser__state"
            icon={folder.searchesTree() ? "ti ti-search-off" : "ti ti-filter-off"}
            title={
              folder.searchesTree() ? props.t().noMatchesBelow({ query: folder.query() }) : props.t().noMatches({ query: folder.query() })
            }
          />
        </Show>
      </Match>
      <Match when={true}>
        <div
          class="cloud-file-dialog__list"
          aria-busy={folder.status() === "loading" ? "true" : undefined}
          ref={(element) => {
            // Listens only: the rows inside own every interaction, the list just notes that the person used them.
            const use = () => props.onUse?.();
            element.addEventListener("pointerdown", use);
            element.addEventListener("keydown", use);
          }}
        >
          {props.children}
          <div class="cloud-file-chooser__more">
            <Show when={folder.error()}>
              <Placeholder state="error" variant="inline" align="left" description={folder.errorView()?.title} />
            </Show>
            <Show when={folder.next()}>
              <Show
                when={folder.items().length < FOLDER_ENTRY_LIMIT}
                fallback={<span class="cloud-file-chooser__limit">{props.t().useFilter({ count: FOLDER_ENTRY_LIMIT })}</span>}
              >
                <Button
                  variant="link"
                  size="sm"
                  loading={folder.status() === "more"}
                  disabled={folder.status() === "loading"}
                  onClick={() => void folder.load(true)}
                >
                  {folder.error() ? props.t().retry : props.t().loadMore}
                  <i class={folder.error() ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
                </Button>
              </Show>
            </Show>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
