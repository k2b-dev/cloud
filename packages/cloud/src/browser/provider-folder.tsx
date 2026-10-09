import { timed } from "@k2b/stdlib/solid";
import { announce, Button, IconButton, Placeholder, TextInput } from "@k2b/ui";
import { batch, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import type { FileProviderEntry } from "../contracts/file-provider";
import type { fileChooserMessages } from "./file-chooser-messages";
import { type FileProviderCaller, FileProviderError, type FileProviderSource, listProviderFolder } from "./file-providers";

type Messages = ReturnType<typeof fileChooserMessages.resolve>["t"];
type Crumb = { id?: string; name: string };
/** Where the dialog is: a folder of one provider, or the source list when `null`. */
export type FolderLocation = { provider: FileProviderSource; trail: readonly Crumb[] } | null;

/** Empty pages may still continue; a dialog follows at most this many of them before it shows "Load more". */
const EMPTY_PAGES_FOLLOWED = 5;

/**
 * Browsing one provider's folders, shared by choosing and saving: the location, the name filter, the folder's pages,
 * and its load state. `settled` runs after a folder has loaded or the source list is back, so the dialog can move
 * focus to its first row.
 */
export const createProviderFolder = (props: { caller: () => FileProviderCaller; t: () => Messages; settled: () => void }) => {
  const [location, setLocation] = createSignal<FolderLocation>(null);
  const [filter, setFilter] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<FileProviderEntry[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [writable, setWritable] = createSignal(false);
  const [status, setStatus] = createSignal<"loading" | "ready" | "more" | "error">("ready");
  const [error, setError] = createSignal<FileProviderError | null>(null);
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
      setError(
        cause instanceof FileProviderError ? cause : new FileProviderError("INTERNAL", cause instanceof Error ? cause.message : "", 500),
      );
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
    if (value.status === 0) return { title: t.offline, description: t.offlineHint, retry: true };
    if (value.status === 403) return { title: t.noAccess, description: t.backHint, retry: false };
    if (value.status === 404) return { title: t.notFound, description: t.backHint, retry: false };
    if (value.status >= 502 || value.code === "APP_UNAVAILABLE")
      return { title: t.unavailable({ app }), description: t.unavailableHint, retry: true };
    return { title: t.loadFailed, description: value.message || undefined, retry: true };
  });

  return {
    location,
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
 * The path row with Up and the name filter. With `sources`, the path starts at the source list; without it, the
 * provider is the top, so Up stops there.
 */
export function FolderToolbar(props: { folder: ProviderFolder; t: () => Messages; disabled: boolean; sources: boolean }): JSX.Element {
  const top = () => {
    const current = props.folder.location();
    return !current || (!props.sources && current.trail.length === 1);
  };
  return (
    <div class="cloud-file-chooser__toolbar">
      <nav class="cloud-file-chooser__crumbs" aria-label={props.t().breadcrumbs}>
        <IconButton size="sm" variant="ghost" label={props.t().up} disabled={top() || props.disabled} onClick={props.folder.up}>
          <i class="ti ti-arrow-up" aria-hidden="true" />
        </IconButton>
        <ol>
          <Show when={props.sources}>
            <li>
              <Button
                size="sm"
                variant={props.folder.location() ? "text" : "subtle"}
                aria-current={props.folder.location() ? undefined : "location"}
                disabled={props.disabled}
                onClick={() => props.folder.navigate(null)}
              >
                {props.t().sources}
              </Button>
            </li>
          </Show>
          <For each={props.folder.location()?.trail ?? []}>
            {(crumb, index) => {
              const last = () => index() === (props.folder.location()?.trail.length ?? 0) - 1;
              return (
                <li>
                  <Show when={props.sources || index() > 0}>
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
        disabled={props.disabled}
        value={props.folder.filter}
        onValueChange={props.folder.changeFilter}
        clearable
        onClear={props.folder.clearFilter}
      />
    </div>
  );
}

/**
 * One folder in the dialog body: loading, the error with Try again or Up, the empty folder, no matches, or `children`
 * with Load more below while the folder continues.
 */
export function FolderContents(props: { folder: ProviderFolder; t: () => Messages; children: JSX.Element }): JSX.Element {
  const folder = props.folder;
  return (
    <Switch>
      <Match when={folder.status() === "loading"}>
        <Placeholder state="loading" variant="panel" class="cloud-file-chooser__state" description={props.t().loading} />
      </Match>
      <Match when={folder.status() === "error" && folder.errorView()}>
        {(view) => (
          <Placeholder
            state="error"
            variant="panel"
            class="cloud-file-chooser__state"
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
          fallback={<Placeholder variant="panel" class="cloud-file-chooser__state" icon="ti ti-folder" title={props.t().emptyFolder} />}
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
        {props.children}
        <div class="cloud-file-chooser__more">
          <Show when={folder.error() && folder.status() === "ready"}>
            <Placeholder state="error" variant="inline" align="left" description={folder.errorView()?.title} />
          </Show>
          <Show when={folder.next()}>
            <Button variant="secondary" size="sm" loading={folder.status() === "more"} onClick={() => void folder.load(true)}>
              {folder.error() ? props.t().retry : props.t().loadMore}
            </Button>
          </Show>
        </div>
      </Match>
    </Switch>
  );
}
