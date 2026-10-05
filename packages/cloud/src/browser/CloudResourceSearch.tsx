import { timed } from "@k2b/stdlib/solid";
import { announce, Button, IconButton, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import type { SearchApp, SearchItem } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import { shortcutLabel } from "./command-shortcuts";
import { matchNavigationSearchItems, type NavigationSearchItem } from "./navigation-search";
import { cloudResourceSearchUrl, filterCloudResourceSearchItems } from "./resource-search";
import { commitTypedTags, matchingSearchTags, searchTags, tagAtCursor } from "./resource-search-input";
import { resourceSearchMessages } from "./resource-search-messages";
import type { GlobalSearchOptions, SearchScope } from "./search-bridge";
import { commandSearchItem, matchingCommands, type PaletteCommand } from "./search-commands";
import {
  applySearchLine,
  emptySearchRun,
  failedSearchApps,
  retrySearchApp,
  type SearchBlock,
  type SearchRun,
  searchFinished,
  searchingApps,
  streamCloudResourceSearch,
} from "./search-stream";

export type CloudResourceSearchProps = {
  commands?: readonly PaletteCommand[];
  commandsLoading?: boolean;
  commandsError?: boolean;
  onCommand?: (command: PaletteCommand, newTab: boolean) => void;
  onSelect: (item: SearchItem) => void;
  onOpenInNewTab?: (item: SearchItem) => void;
  onClose: () => void;
  selectionMode?: boolean;
  title?: string;
  initialAppId?: string;
  request?: GlobalSearchOptions;
  disabled?: boolean;
  navigationError?: string;
  placeholder?: string;
  requireReader?: boolean;
  navigationItems?: readonly NavigationSearchItem[];
  searchResources?: boolean;
  excludeRefs?: readonly CloudResourceRef[];
};

const isLinkableCommand = (command: PaletteCommand) => typeof command.action !== "function" && "command" in command.action;

const itemKey = (item: SearchItem) => `${item.ref.type}:${item.ref.id}`;
const URL_BASE = "https://cloud.invalid";
const groupByApp = (items: SearchItem[]) => {
  const groups = new Map<string, SearchItem[]>();
  for (const item of items) {
    const group = groups.get(item.appId) ?? [];
    group.push(item);
    groups.set(item.appId, group);
  }
  return [...groups.values()].flat();
};

export default function CloudResourceSearch(props: CloudResourceSearchProps) {
  const locale = useLocale();
  const t = () => resourceSearchMessages.resolve([locale()]).t;
  const id = createUniqueId();
  const [input, setInput] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [scope, setScope] = createSignal<SearchScope | undefined>(
    props.request?.scope ?? (props.initialAppId ? { appId: props.initialAppId, label: props.initialAppId } : undefined),
  );
  const appId = () => scope()?.appId ?? scope()?.ref?.type.split(".")[0];
  const scopeLabel = () =>
    !props.request && props.initialAppId
      ? (catalogApps()?.find((app) => app.id === props.initialAppId)?.name ?? scope()?.label)
      : scope()?.label;
  createEffect(() => {
    const request = props.request;
    if (!request) return;
    setScope(request.scope);
    if (request.query !== undefined) {
      setInput(request.query);
      setCaret(request.query.length);
    }
    setTags([]);
    setBrowsingTags(false);
    queueMicrotask(() => inputRef?.focus());
  });
  const [caret, setCaret] = createSignal(0);
  const [browsingTags, setBrowsingTags] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let userSelected = false;
  const selectIndex = (index: number) => {
    userSelected = true;
    setActiveIndex(index);
  };
  const [tagIndex, setTagIndex] = createSignal(0);
  const [selectedKey, setSelectedKey] = createSignal<string>();
  const [mobileDetails, setMobileDetails] = createSignal(false);
  const [previewFailed, setPreviewFailed] = createSignal(false);
  let inputRef!: HTMLInputElement;
  let bodyRef!: HTMLDivElement;
  let backRef: HTMLButtonElement | undefined;

  const commandMode = () => !props.selectionMode && Boolean(props.onCommand) && input().trimStart().startsWith(">");
  const commandQuery = () => (commandMode() ? input().trimStart().slice(1).trim() : textQuery());
  const commandFor = (item: SearchItem) =>
    item.ref.type === "cloud.command" ? visibleCommands().find((command) => command.id === item.ref.id) : undefined;
  const tagContext = createMemo(() => (commandMode() ? null : tagAtCursor(input(), caret())));
  const choosingTag = () => !commandMode() && (browsingTags() || tagContext() !== null);
  const textQuery = createMemo(() => {
    const ctx = tagContext();
    return (ctx ? input().slice(0, ctx.start) + input().slice(ctx.end) : input()).trim();
  });
  const visibleCommands = createMemo(() =>
    props.selectionMode || !props.onCommand ? [] : matchingCommands(props.commands ?? [], commandQuery(), commandMode()),
  );
  const canSearch = () => !commandMode() && (Boolean(appId()) || tags().length > 0 || textQuery().length >= 2);
  const desiredUrl = createMemo(() =>
    cloudResourceSearchUrl({
      query: canSearch() ? textQuery() : "",
      tags: commandMode() ? [] : tags(),
      appId: commandMode() ? undefined : appId(),
      scope: commandMode() ? undefined : scope()?.ref,
      scopeTag: commandMode() ? undefined : scope()?.tag,
      requireReader: props.requireReader,
    }),
  );
  const [searchUrl, setSearchUrl] = createSignal(desiredUrl());
  // One streamed run per search URL. Apps answer in any order; their rows are appended and never reordered.
  const [run, setRun] = createSignal<SearchRun>(emptySearchRun());
  const [runUrl, setRunUrl] = createSignal<string>();
  const [catalogApps, setCatalogApps] = createSignal<SearchApp[]>();
  // The last rows a run showed stay until the next run shows its first rows, so typing does not blank the list.
  const [stale, setStale] = createSignal<{ url: string; blocks: SearchBlock[] }>();
  let controller: AbortController | undefined;
  const startRun = (url: string) => {
    controller?.abort();
    const own = new AbortController();
    controller = own;
    const previous = runUrl();
    if (previous && run().blocks.length) setStale({ url: previous, blocks: run().blocks });
    setRunUrl(url);
    if (props.searchResources === false) {
      setRun({ ...emptySearchRun(), done: true });
      return;
    }
    setRun(emptySearchRun());
    void streamCloudResourceSearch(url, {
      signal: own.signal,
      locale: locale(),
      onLine: (line) => {
        if (controller !== own) return;
        if (line.type === "start") setCatalogApps(line.apps);
        setRun((current) => applySearchLine(current, line));
      },
    }).catch(() => {
      if (controller === own && !own.signal.aborted) setRun((current) => ({ ...current, failed: true }));
    });
  };
  /** Searches one app again within the current run; its rows, if any, are appended at the end. */
  const retryApp = (appId: string) => {
    const own = controller;
    const url = runUrl();
    if (!own || !url) return;
    const target = new URL(url, URL_BASE);
    target.searchParams.set("app", appId);
    // Narrowed to one app, the server samples more; the retried section keeps the size the others have.
    const limit = run().providers.length > 1 ? Number(target.searchParams.get("provider_limit")) : undefined;
    setRun((current) => retrySearchApp(current, appId));
    const giveUp = () => {
      if (controller === own && run().status[appId] === "searching")
        setRun((current) => applySearchLine(current, { type: "provider", provider: appId, status: "error", results: [], ms: 0 }));
    };
    void streamCloudResourceSearch(`${target.pathname}${target.search}`, {
      signal: own.signal,
      locale: locale(),
      onLine: (line) => {
        if (controller !== own || line.type !== "provider" || line.provider !== appId) return;
        setRun((current) => applySearchLine(current, { ...line, results: line.results.slice(0, limit) }));
      },
    }).then(giveUp, giveUp);
  };
  createEffect(on(searchUrl, startRun));
  onCleanup(() => controller?.abort());

  const current = () => runUrl() === desiredUrl();
  const started = () => run().providers.length > 0 || run().done || run().failed;
  const finished = () => current() && searchFinished(run());
  const waiting = () => searchUrl() !== desiredUrl() || !started();
  const pendingApps = () => (current() ? searchingApps(run()) : []);
  const failedApps = () => (current() ? failedSearchApps(run()) : []);
  const appName = (appId: string) => run().apps.find((app) => app.id === appId)?.name ?? appId;
  const narrowedApp = () => (run().providers.length === 1 ? run().providers[0] : undefined);
  const catalog = createMemo(() => searchTags(catalogApps() ?? [], appId()));
  const quickTags = createMemo(() =>
    catalog()
      .filter((tag, index, all) => all.findIndex((other) => other.appName === tag.appName) === index)
      .slice(0, 3),
  );
  const suggestions = createMemo(() => matchingSearchTags(catalog(), tagContext()?.prefix ?? "", tags()));
  const navigation = createMemo(() =>
    canSearch() && !scope()?.ref && scope()?.tag === undefined
      ? matchNavigationSearchItems(props.navigationItems ?? [], {
          query: textQuery(),
          tags: tags(),
          appId: appId(),
          requireReader: props.requireReader,
        })
      : [],
  );
  // Keep last-good rows only within the same context, never across scope changes.
  const sameScope = (url: string) => {
    const loaded = new URL(url, URL_BASE).searchParams;
    return (
      (loaded.get("scope_type") ?? undefined) === scope()?.ref?.type &&
      (loaded.get("scope_id") ?? undefined) === scope()?.ref?.id &&
      (loaded.get("app") ?? undefined) === appId() &&
      (loaded.get("scope_tag") ?? undefined) === scope()?.tag
    );
  };
  const shownRun = () => run().blocks.length > 0 || searchFinished(run());
  const shownBlocks = () => {
    const source = shownRun() ? { url: runUrl() ?? "", blocks: run().blocks } : stale();
    return source && sameScope(source.url) ? source.blocks : [];
  };
  /** Rows of the run for the current input; anything older is visible but cannot be chosen. */
  const freshResults = () => current() && shownRun();
  const results = createMemo(() =>
    canSearch()
      ? [...groupByApp(navigation()), ...shownBlocks().flatMap((block) => filterCloudResourceSearchItems(block.items, props))]
      : [],
  );
  const items = createMemo(() => {
    const commands = visibleCommands().map((command) => commandSearchItem(command, command.context ? t().contextActions : t().actions));
    // Instant rows come first: streamed app sections are appended below them and never push them down.
    return [...commands, ...results()];
  });
  const selectable = (item: SearchItem) =>
    !props.disabled &&
    !choosingTag() &&
    (commandFor(item) || navigation().includes(item) || (freshResults() && searchUrl() === desiredUrl()));
  const activeItem = () => items()[activeIndex()];
  const selectedItem = () => items().find((item) => itemKey(item) === selectedKey());
  const previewItem = () => (props.selectionMode ? (selectedItem() ?? activeItem()) : activeItem());
  const showList = () => !choosingTag() && items().length > 0;
  // An active search keeps the full height from its first keystroke, so arriving rows never resize the dialog.
  const searching = () => !choosingTag() && (canSearch() || commandMode());
  const showResults = () => showList() && searching();
  const unknownTags = () => (current() && started() ? run().unsupportedTags : []);
  const noMatches = () =>
    !items().length && (commandMode() ? !props.commandsLoading : canSearch() && finished() && !run().failed && failedApps().length === 0);
  const stillSearching = () => {
    const names = pendingApps().map(appName);
    const shown = names.length > 3 ? [...names.slice(0, 2), t().moreApps({ count: names.length - 2 })] : names;
    return t().stillSearching({ apps: new Intl.ListFormat(locale(), { type: "conjunction" }).format(shown), count: names.length });
  };

  const { debouncedFn: scheduleSearch, cancel } = timed.debounce((url: string) => setSearchUrl(url), 200);
  createEffect(() => {
    const url = desiredUrl();
    if (choosingTag()) {
      cancel();
      return;
    }
    if (url === searchUrl()) {
      cancel();
      return;
    }
    if (canSearch()) scheduleSearch(url);
    else {
      cancel();
      setSearchUrl(url);
    }
  });
  createEffect(() => {
    desiredUrl();
    setSelectedKey(undefined);
    setMobileDetails(false);
  });
  createEffect(
    on(
      () => ({ rows: items(), context: JSON.stringify([desiredUrl(), commandMode(), commandQuery()]) }),
      (current, previous) => {
        if (userSelected && previous?.context === current.context) {
          const selected = previous.rows[activeIndex()];
          // Preserve the actual target across asynchronous catalog/context updates.
          // A removed target leaves no selection rather than selecting a different action.
          setActiveIndex(selected ? current.rows.findIndex((row) => itemKey(row) === itemKey(selected)) : -1);
        } else {
          userSelected = false;
          const explicitCommand = commandMode() && Boolean(commandQuery());
          const firstResult = current.rows.findIndex((row) => row.ref.type !== "cloud.command");
          // Actions are never implicitly selected; with text, the first result is.
          setActiveIndex(explicitCommand ? 0 : current.rows[0]?.ref.type === "cloud.command" && !textQuery() ? -1 : firstResult);
        }
      },
    ),
  );
  createEffect(
    on(
      () => canSearch() && !commandMode() && finished(),
      (done, wasDone) => {
        if (done && !wasDone) announce(t().searchDone({ count: results().length }));
      },
    ),
  );
  createEffect(() => {
    suggestions();
    setTagIndex(0);
  });
  createEffect(() => {
    previewItem();
    setPreviewFailed(false);
  });
  onCleanup(cancel);
  onMount(() => {
    const frame = requestAnimationFrame(() => inputRef?.focus());
    onCleanup(() => cancelAnimationFrame(frame));
  });

  const focusInput = (pos = input().length) => {
    queueMicrotask(() => {
      inputRef.focus();
      inputRef.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  const addTag = (tag: string) => {
    const ctx = tagContext();
    const next = ctx ? input().slice(0, ctx.start) + input().slice(ctx.end) : input();
    setInput(next.trim());
    setCaret(next.trim().length);
    setTags((prev) => [...new Set([...prev, tag])]);
    setBrowsingTags(false);
    focusInput();
  };
  const leaveTags = () => {
    const ctx = tagContext();
    if (ctx) {
      const next = (input().slice(0, ctx.start) + input().slice(ctx.end)).trim();
      setInput(next);
      setCaret(next.length);
    }
    setBrowsingTags(false);
    focusInput();
  };
  const onInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const el = event.currentTarget;
    if (event.isComposing) {
      setInput(el.value);
      setCaret(el.selectionStart ?? el.value.length);
      return;
    }
    const parsed = commitTypedTags(el.value, el.selectionStart ?? el.value.length);
    setInput(parsed.input);
    setCaret(parsed.caret);
    if (parsed.tags.length) {
      setTags((prev) => [...new Set([...prev, ...parsed.tags])]);
      setBrowsingTags(false);
      focusInput(parsed.caret);
    }
  };
  const chooseItem = (item: SearchItem) => {
    if (!selectable(item)) return;
    const command = commandFor(item);
    if (command) {
      props.onCommand?.(command, false);
      return;
    }
    if (props.selectionMode) {
      setSelectedKey(itemKey(item));
      selectIndex(items().indexOf(item));
    } else props.onSelect(item);
  };
  const scrollOption = (index: number, kind: "tag" | "result") => {
    queueMicrotask(() => bodyRef?.querySelector<HTMLElement>(`[data-${kind}-index="${index}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const openNewTab = (item: SearchItem) => {
    const command = commandFor(item);
    if (command) {
      if (typeof command.action !== "function" && "command" in command.action) props.onCommand?.(command, true);
    } else props.onOpenInNewTab?.(item);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      if (mobileDetails()) {
        event.preventDefault();
        event.stopPropagation();
        setMobileDetails(false);
        focusInput();
      } else if (choosingTag()) {
        event.preventDefault();
        event.stopPropagation();
        leaveTags();
      }
      return;
    }
    if (choosingTag()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!suggestions().length) return;
        const next = (tagIndex() + (event.key === "ArrowDown" ? 1 : -1) + suggestions().length) % suggestions().length;
        setTagIndex(next);
        scrollOption(next, "tag");
      } else if (event.key === "Enter") {
        event.preventDefault();
        const choice = suggestions()[tagIndex()];
        if (choice) addTag(choice.tag);
        else if (tagContext()?.prefix) addTag(tagContext()!.prefix);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items().length) return;
      const next =
        activeIndex() < 0
          ? event.key === "ArrowDown"
            ? 0
            : items().length - 1
          : (activeIndex() + (event.key === "ArrowDown" ? 1 : -1) + items().length) % items().length;
      selectIndex(next);
      scrollOption(next, "result");
    } else if (event.key === "Enter" && activeItem()) {
      event.preventDefault();
      const item = activeItem()!;
      if ((event.metaKey || event.ctrlKey) && props.onOpenInNewTab && !props.selectionMode) {
        if (selectable(item)) openNewTab(item);
      } else chooseItem(item);
    } else if (event.key === "Backspace" && !input() && tags().length) {
      event.preventDefault();
      setTags((prev) => prev.slice(0, -1));
    }
  };
  const updateCaret = () => setCaret(inputRef.selectionStart ?? input().length);
  const previewMetadata = () => (previewItem()?.metadata ?? []).filter((entry) => entry.label.trim() && entry.value.trim()).slice(0, 5);

  return (
    <div
      role="group"
      aria-label={props.title ?? t().searchCloudResources}
      class="cloud-resource-search"
      classList={{ "has-results": searching(), "is-picker": props.selectionMode, "shows-details": mobileDetails() && showResults() }}
      onKeyDown={(event) => {
        if (event.target === inputRef) return;
        if (event.key === "Escape") handleKeyDown(event);
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && props.onOpenInNewTab && !props.selectionMode) {
          handleKeyDown(event);
        }
      }}
    >
      <Show when={props.selectionMode}>
        <div class="cloud-resource-search__title">{props.title ?? t().chooseResource}</div>
      </Show>
      <IconButton class="cloud-resource-search__close" label={t().close} onClick={props.onClose}>
        <i class="ti ti-x" aria-hidden="true" />
      </IconButton>
      <label class="cloud-resource-search__input">
        <Show
          when={commandMode() ? props.commandsLoading : canSearch() && waiting() && !choosingTag()}
          fallback={<i class="ti ti-search" aria-hidden="true" />}
        >
          <i class="ti ti-loader-2 animate-spin" role="status" aria-label={t().loading} />
        </Show>
        <div class="cloud-resource-search__field">
          <Show when={scope()}>
            {(context) => (
              <button
                type="button"
                class="cloud-resource-search__tag max-w-full"
                title={scopeLabel()}
                onClick={() => {
                  setScope(undefined);
                  setTags([]);
                  focusInput();
                }}
                aria-label={t().removeScope({ app: scopeLabel() ?? context().label })}
              >
                <Show when={context().icon}>{(icon) => <i class={`${icon()} shrink-0`} aria-hidden="true" />}</Show>
                <span class="min-w-0 truncate">{scopeLabel()}</span> <i class="ti ti-x shrink-0" aria-hidden="true" />
              </button>
            )}
          </Show>
          <For each={tags()}>
            {(tag) => (
              <button
                type="button"
                class="cloud-resource-search__tag"
                classList={{ "is-unknown": unknownTags().includes(tag) }}
                onClick={() => {
                  setTags((prev) => prev.filter((value) => value !== tag));
                  focusInput();
                }}
                aria-label={t().removeTag({ tag })}
              >
                #{tag}
                <i class="ti ti-x" aria-hidden="true" />
              </button>
            )}
          </For>
          <input
            ref={inputRef}
            id={`${id}-input`}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-label={t().searchCloudResources}
            aria-controls={`${id}-options`}
            aria-expanded={choosingTag() ? suggestions().length > 0 : showList()}
            aria-activedescendant={
              choosingTag()
                ? suggestions().length
                  ? `${id}-tag-${tagIndex()}`
                  : undefined
                : showList() && activeIndex() >= 0
                  ? `${id}-result-${activeIndex()}`
                  : undefined
            }
            value={input()}
            onInput={onInput}
            onClick={updateCaret}
            onSelect={updateCaret}
            onKeyUp={updateCaret}
            onKeyDown={handleKeyDown}
            placeholder={
              commandMode()
                ? t().commandPlaceholder
                : tags().length
                  ? ""
                  : (props.placeholder ??
                    (props.selectionMode ? t().pickerPlaceholder : scope() ? t().scopedSearchPlaceholder : t().searchPlaceholder))
            }
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            maxLength={500}
          />
        </div>
      </label>
      <ScrollArea
        ref={bodyRef}
        class="cloud-resource-search__body"
        aria-busy={canSearch() && !choosingTag() && (waiting() || pendingApps().length > 0)}
      >
        <Show
          when={choosingTag()}
          fallback={
            <>
              <Show when={props.navigationError}>
                {(message) => (
                  <p role="alert" class="cloud-resource-search__hint">
                    {message()}
                  </p>
                )}
              </Show>
              <Show when={current() && run().failed}>
                <div class="cloud-resource-search__hint" role="status">
                  {t().searchFailed}{" "}
                  <Button variant="text" size="xs" onClick={() => startRun(searchUrl())}>
                    {t().retry}
                  </Button>
                </div>
              </Show>
              <Show when={!canSearch() && !commandMode()}>
                <div class="cloud-resource-search__idle">
                  <p>{props.selectionMode ? t().pickerHint : props.searchResources === false ? t().navigationHint : t().startHint}</p>
                  <div class="cloud-resource-search__quick" aria-busy={!catalogApps() && !run().failed}>
                    <Show
                      when={catalogApps() || run().failed}
                      fallback={<For each={[0, 1, 2]}>{() => <span class="cloud-resource-search__tag-skeleton" aria-hidden="true" />}</For>}
                    >
                      <For each={quickTags()}>
                        {(tag) => (
                          <Button variant="subtle" size="sm" onClick={() => addTag(tag.tag)}>
                            #{tag.tag}
                          </Button>
                        )}
                      </For>
                    </Show>
                    <Show when={!catalogApps() || catalog().length > 0}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setBrowsingTags(true);
                          focusInput();
                        }}
                      >
                        {t().allTags}
                      </Button>
                    </Show>
                    <Show when={props.onCommand && !props.selectionMode}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setInput(">");
                          setCaret(1);
                          focusInput();
                        }}
                      >
                        {t().actions}
                      </Button>
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={commandMode()}>
                <p class="cloud-resource-search__hint">{t().commandHint}</p>
              </Show>
              <Show when={props.commandsError && commandMode()}>
                <p role="status" class="cloud-resource-search__hint">
                  {t().commandFailed}
                </p>
              </Show>
              <Show when={searching()}>
                <div class="cloud-resource-search__count">{items().length > 0 ? t().resultCount({ count: items().length }) : "\u00a0"}</div>
              </Show>
              <Show when={showList()}>
                <section id={`${id}-options`} role="listbox" aria-label={t().searchCloudResources} class="cloud-resource-search__results">
                  <For each={items()}>
                    {(item, index) => (
                      <>
                        <Show when={index() === 0 || items()[index() - 1]?.appId !== item.appId}>
                          <div class="cloud-resource-search__group" role="presentation">
                            {item.appName}
                          </div>
                        </Show>
                        <button
                          type="button"
                          id={`${id}-result-${index()}`}
                          data-result-index={index()}
                          role="option"
                          aria-selected={props.selectionMode ? selectedKey() === itemKey(item) : activeIndex() === index()}
                          aria-disabled={!selectable(item)}
                          class="cloud-resource-search__result"
                          classList={{
                            "is-active": activeIndex() === index(),
                            "is-selected": props.selectionMode && selectedKey() === itemKey(item),
                          }}
                          onFocus={() => selectIndex(index())}
                          onMouseEnter={() => {
                            if (!props.selectionMode) selectIndex(index());
                          }}
                          onClick={(event) => {
                            if ((event.metaKey || event.ctrlKey) && props.onOpenInNewTab && !props.selectionMode) {
                              if (selectable(item)) openNewTab(item);
                            } else chooseItem(item);
                          }}
                        >
                          <i class={item.icon ?? item.appIcon} aria-hidden="true" />
                          <span class="cloud-resource-search__result-copy">
                            <span>{item.title}</span>
                            <small>{item.preview ?? item.appName}</small>
                          </span>
                          <Show when={commandFor(item)?.shortcut}>
                            {(shortcut) => <kbd class="shrink-0 text-xs text-dimmed">{shortcutLabel(shortcut())}</kbd>}
                          </Show>
                          <Show when={props.selectionMode && selectedKey() === itemKey(item)}>
                            <i class="ti ti-check" aria-hidden="true" />
                          </Show>
                        </button>
                      </>
                    )}
                  </For>
                </section>
              </Show>
              <Show when={canSearch() && !commandMode() && (pendingApps().length > 0 || failedApps().length > 0)}>
                <div class="cloud-resource-search__status">
                  <Show when={pendingApps().length > 0}>
                    <p>
                      <i class="ti ti-loader-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {stillSearching()}
                    </p>
                  </Show>
                  <For each={failedApps()}>
                    {(failure) => (
                      <p>
                        {failure.status === "timeout"
                          ? t().appTimedOut({ app: appName(failure.appId) })
                          : t().appUnavailable({ app: appName(failure.appId) })}
                        <span aria-hidden="true">·</span>
                        <Button variant="text" size="xs" onClick={() => retryApp(failure.appId)}>
                          {t().retry}
                        </Button>
                      </p>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={noMatches()}>
                <p class="cloud-resource-search__hint" role="status">
                  {unknownTags().length
                    ? t().unsupportedTags
                    : !commandMode() && narrowedApp()
                      ? t().appNoMatches({ app: appName(narrowedApp()!), query: textQuery() })
                      : t().noMatches}
                </p>
              </Show>
            </>
          }
        >
          <div class="cloud-resource-search__tag-heading">
            <span>{t().tagSuggestions}</span>
            <Button variant="text" size="xs" onClick={leaveTags}>
              {t().backToSearch}
            </Button>
          </div>
          <Show
            when={suggestions().length > 0}
            fallback={
              <p class="cloud-resource-search__hint">{run().failed ? t().searchFailed : catalogApps() ? t().noTags : t().loadingTags}</p>
            }
          >
            <div role="listbox" id={`${id}-options`} aria-label={t().tagSuggestions} class="cloud-resource-search__tags">
              <For each={suggestions()}>
                {(tag, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`${id}-tag-${index()}`}
                    data-tag-index={index()}
                    aria-selected={tagIndex() === index()}
                    class="cloud-resource-search__tag-option"
                    classList={{ "is-active": tagIndex() === index() }}
                    onFocus={() => setTagIndex(index())}
                    onMouseEnter={() => setTagIndex(index())}
                    onClick={() => addTag(tag.tag)}
                  >
                    <i class={tag.appIcon} aria-hidden="true" />
                    <span>
                      <strong>{tag.title}</strong>
                      <small>{tag.description}</small>
                    </span>
                    <code>#{tag.tag}</code>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </ScrollArea>
      <Show when={searching() || (choosingTag() && suggestions().length > 0)}>
        <footer class="cloud-resource-search__footer">
          <Show when={searching()}>
            <Button
              class="cloud-resource-search__details"
              disabled={!previewItem()}
              variant="text"
              size="xs"
              onClick={() => {
                setMobileDetails(true);
                queueMicrotask(() => backRef?.focus());
              }}
            >
              {t().details}
            </Button>
          </Show>
          <Show
            when={props.selectionMode && !choosingTag()}
            fallback={
              <div class="cloud-resource-search__keys">
                <span>↑ ↓ {t().navigate}</span>
                <span>↵ {choosingTag() ? t().select : t().open}</span>
                <Show
                  when={
                    props.onOpenInNewTab &&
                    !props.selectionMode &&
                    !choosingTag() &&
                    (!activeItem() || !commandFor(activeItem()!) || isLinkableCommand(commandFor(activeItem()!)!))
                  }
                >
                  <span>⌘/Ctrl ↵ {t().newTab}</span>
                </Show>
              </div>
            }
          >
            <span class="cloud-resource-search__selection">{selectedItem()?.title ?? t().chooseFirst}</span>
            <Button
              size="sm"
              disabled={!selectedItem() || !selectable(selectedItem()!)}
              onClick={() => {
                const item = selectedItem();
                if (item && selectable(item)) props.onSelect(item);
              }}
            >
              {t().add}
            </Button>
          </Show>
        </footer>
      </Show>
      <Show when={showResults() && previewItem()}>
        {(item) => (
          <ScrollArea class="cloud-resource-search__preview">
            <Button
              ref={backRef}
              variant="text"
              size="xs"
              class="cloud-resource-search__back"
              onClick={() => {
                setMobileDetails(false);
                focusInput();
              }}
            >
              ← {t().back}
            </Button>
            <div class="cloud-resource-search__preview-app">
              <i class={item().icon ?? item().appIcon} aria-hidden="true" />
              {item().appName}
            </div>
            <h2>{item().title}</h2>
            <Show when={item().previewUrl?.startsWith("/") && !previewFailed()}>
              <img class="cloud-resource-search__image" src={item().previewUrl} alt="" onError={() => setPreviewFailed(true)} />
            </Show>
            <Show when={previewMetadata().length > 0}>
              <dl>
                <For each={previewMetadata()}>
                  {(entry) => (
                    <>
                      <dt>{entry.label}</dt>
                      <dd>{entry.value}</dd>
                    </>
                  )}
                </For>
              </dl>
            </Show>
            <Show when={item().preview}>
              <p>{item().preview}</p>
            </Show>
          </ScrollArea>
        )}
      </Show>
    </div>
  );
}
