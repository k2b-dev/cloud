import { query, timed } from "@k2b/stdlib/solid";
import { Button, IconButton, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import type { SearchItem, SearchResponse } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import { LOCALE_HEADER } from "../shared/locale";
import { matchNavigationSearchItems, type NavigationSearchItem } from "./navigation-search";
import { cloudResourceSearchUrl, filterCloudResourceSearchItems } from "./resource-search";
import { commitTypedTags, matchingSearchTags, searchTags, tagAtCursor } from "./resource-search-input";
import { resourceSearchMessages } from "./resource-search-messages";
import type { GlobalSearchOptions, SearchScope } from "./search-bridge";

export type CloudResourceSearchProps = {
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

const itemKey = (item: SearchItem) => `${item.ref.type}:${item.ref.id}`;
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
      ? (response()?.apps.find((app) => app.id === props.initialAppId)?.name ?? scope()?.label)
      : scope()?.label;
  createEffect(() => {
    const request = props.request;
    if (!request) return;
    setScope(request.scope);
    setTags([]);
    setBrowsingTags(false);
    queueMicrotask(() => inputRef?.focus());
  });
  const [caret, setCaret] = createSignal(0);
  const [browsingTags, setBrowsingTags] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [tagIndex, setTagIndex] = createSignal(0);
  const [selectedKey, setSelectedKey] = createSignal<string>();
  const [mobileDetails, setMobileDetails] = createSignal(false);
  const [previewFailed, setPreviewFailed] = createSignal(false);
  let inputRef!: HTMLInputElement;
  let bodyRef!: HTMLDivElement;
  let backRef: HTMLButtonElement | undefined;

  const tagContext = createMemo(() => tagAtCursor(input(), caret()));
  const choosingTag = () => browsingTags() || tagContext() !== null;
  const textQuery = createMemo(() => {
    const ctx = tagContext();
    return (ctx ? input().slice(0, ctx.start) + input().slice(ctx.end) : input()).trim();
  });
  const canSearch = () => Boolean(appId()) || tags().length > 0 || textQuery().length >= 2;
  const desiredUrl = createMemo(() =>
    cloudResourceSearchUrl({
      query: canSearch() ? textQuery() : "",
      tags: tags(),
      appId: appId(),
      scope: scope()?.ref,
      requireReader: props.requireReader,
    }),
  );
  const [searchUrl, setSearchUrl] = createSignal(desiredUrl());
  const searchQuery = query.create({
    source: searchUrl,
    load: async (url, { abortSignal }) => {
      if (props.searchResources === false) {
        const data: SearchResponse = { query: "", count: 0, apps: [], items: [] };
        return { url, data };
      }
      const response = await fetch(url, { signal: abortSignal, headers: { [LOCALE_HEADER]: locale() } });
      if (!response.ok) throw new Error(t().searchFailed);
      const data: SearchResponse = await response.json();
      return { url, data };
    },
  });
  const response = () => searchQuery.data()?.data;
  const fresh = () => searchQuery.data()?.url === desiredUrl() && !searchQuery.error();
  const pending = () => searchUrl() !== desiredUrl() || searchQuery.loading() || searchQuery.refreshing();
  const catalog = createMemo(() => searchTags(response()?.apps ?? [], appId()));
  const quickTags = createMemo(() =>
    catalog()
      .filter((tag, index, all) => all.findIndex((other) => other.appName === tag.appName) === index)
      .slice(0, 3),
  );
  const suggestions = createMemo(() => matchingSearchTags(catalog(), tagContext()?.prefix ?? "", tags()));
  const navigation = createMemo(() =>
    canSearch() && !scope()?.ref
      ? matchNavigationSearchItems(props.navigationItems ?? [], {
          query: textQuery(),
          tags: tags(),
          appId: appId(),
          requireReader: props.requireReader,
        })
      : [],
  );
  const items = createMemo(() => {
    if (!canSearch()) return [];
    // Keep last-good rows only within the same context, never across scope changes.
    const loaded = new URL(searchQuery.data()?.url ?? "/api/search", "https://cloud.invalid");
    const sameScope =
      (loaded.searchParams.get("scope_type") ?? undefined) === scope()?.ref?.type &&
      (loaded.searchParams.get("scope_id") ?? undefined) === scope()?.ref?.id &&
      (loaded.searchParams.get("app") ?? undefined) === appId();
    const resources = filterCloudResourceSearchItems(sameScope ? (response()?.items ?? []) : [], props).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.title.localeCompare(b.title),
    );
    return [...groupByApp(resources), ...groupByApp(navigation())];
  });
  const selectable = (item: SearchItem) => !props.disabled && !choosingTag() && (navigation().includes(item) || (fresh() && !pending()));
  const activeItem = () => items()[activeIndex()];
  const selectedItem = () => items().find((item) => itemKey(item) === selectedKey());
  const previewItem = () => (props.selectionMode ? (selectedItem() ?? activeItem()) : activeItem());
  const showResults = () => !choosingTag() && items().length > 0;
  const unknownTags = () => (fresh() && !pending() ? (response()?.unsupportedTags ?? []) : []);

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
  createEffect(() => {
    searchQuery.data();
    setActiveIndex(0);
  });
  createEffect(() => {
    suggestions();
    setTagIndex(0);
  });
  createEffect(() => {
    if (activeIndex() >= items().length) setActiveIndex(0);
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
    if (props.selectionMode) {
      setSelectedKey(itemKey(item));
      setActiveIndex(items().indexOf(item));
    } else props.onSelect(item);
  };
  const scrollOption = (index: number, kind: "tag" | "result") => {
    queueMicrotask(() => bodyRef?.querySelector<HTMLElement>(`[data-${kind}-index="${index}"]`)?.scrollIntoView({ block: "nearest" }));
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
      const next = (activeIndex() + (event.key === "ArrowDown" ? 1 : -1) + items().length) % items().length;
      setActiveIndex(next);
      scrollOption(next, "result");
    } else if (event.key === "Enter" && activeItem()) {
      event.preventDefault();
      const item = activeItem()!;
      if ((event.metaKey || event.ctrlKey) && props.onOpenInNewTab && !props.selectionMode) {
        if (selectable(item)) props.onOpenInNewTab(item);
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
      classList={{ "has-results": showResults(), "is-picker": props.selectionMode, "shows-details": mobileDetails() && showResults() }}
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
        <Show when={pending() && !choosingTag()} fallback={<i class="ti ti-search" aria-hidden="true" />}>
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
            aria-expanded={choosingTag() ? suggestions().length > 0 : showResults()}
            aria-activedescendant={
              choosingTag()
                ? suggestions().length
                  ? `${id}-tag-${tagIndex()}`
                  : undefined
                : showResults()
                  ? `${id}-result-${activeIndex()}`
                  : undefined
            }
            value={input()}
            onInput={onInput}
            onClick={updateCaret}
            onSelect={updateCaret}
            onKeyUp={updateCaret}
            onKeyDown={handleKeyDown}
            placeholder={tags().length ? "" : (props.placeholder ?? (props.selectionMode ? t().pickerPlaceholder : t().searchPlaceholder))}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            maxLength={500}
          />
        </div>
      </label>
      <ScrollArea ref={bodyRef} class="cloud-resource-search__body" aria-busy={pending() && !choosingTag()}>
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
              <Show when={searchQuery.error()}>
                <div class="cloud-resource-search__hint" role="status">
                  {t().searchFailed}{" "}
                  <Button variant="text" size="xs" onClick={() => void searchQuery.refresh()}>
                    {t().retry}
                  </Button>
                </div>
              </Show>
              <Show when={fresh() && response()?.failedApps?.length}>
                <p class="cloud-resource-search__hint" role="status">
                  {t().partialFailure}
                </p>
              </Show>
              <Show when={!canSearch()}>
                <div class="cloud-resource-search__idle">
                  <p>{props.selectionMode ? t().pickerHint : props.searchResources === false ? t().navigationHint : t().startHint}</p>
                  <div class="cloud-resource-search__quick" aria-busy={!response() && !searchQuery.error()}>
                    <Show
                      when={response() || searchQuery.error()}
                      fallback={<For each={[0, 1, 2]}>{() => <span class="cloud-resource-search__tag-skeleton" aria-hidden="true" />}</For>}
                    >
                      <For each={quickTags()}>
                        {(tag) => (
                          <Button variant="subtle" size="xs" onClick={() => addTag(tag.tag)}>
                            #{tag.tag}
                          </Button>
                        )}
                      </For>
                    </Show>
                    <Show when={!response() || catalog().length > 0}>
                      <Button
                        variant="text"
                        size="xs"
                        disabled={!catalog().length}
                        onClick={() => {
                          setBrowsingTags(true);
                          focusInput();
                        }}
                      >
                        {t().allTags}
                      </Button>
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={showResults()}>
                <div class="cloud-resource-search__count" aria-live="polite">
                  {t().resultCount({ count: items().length })}
                </div>
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
                          onFocus={() => setActiveIndex(index())}
                          onMouseEnter={() => {
                            if (!props.selectionMode) setActiveIndex(index());
                          }}
                          onClick={(event) => {
                            if ((event.metaKey || event.ctrlKey) && props.onOpenInNewTab && !props.selectionMode) {
                              if (selectable(item)) props.onOpenInNewTab(item);
                            } else chooseItem(item);
                          }}
                        >
                          <i class={item.icon ?? item.appIcon} aria-hidden="true" />
                          <span class="cloud-resource-search__result-copy">
                            <span>{item.title}</span>
                            <small>{item.preview ?? item.appName}</small>
                          </span>
                          <Show when={props.selectionMode && selectedKey() === itemKey(item)}>
                            <i class="ti ti-check" aria-hidden="true" />
                          </Show>
                        </button>
                      </>
                    )}
                  </For>
                </section>
              </Show>
              <Show
                when={canSearch() && !items().length && !pending() && fresh() && !searchQuery.error() && !response()?.failedApps?.length}
              >
                <p class="cloud-resource-search__hint" role="status">
                  {unknownTags().length ? t().unsupportedTags : t().noMatches}
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
              <p class="cloud-resource-search__hint">
                {searchQuery.loading() ? t().loadingTags : searchQuery.error() ? t().searchFailed : t().noTags}
              </p>
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
      <Show when={showResults() || (choosingTag() && suggestions().length > 0)}>
        <footer class="cloud-resource-search__footer">
          <Show when={showResults()}>
            <Button
              class="cloud-resource-search__details"
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
                <Show when={props.onOpenInNewTab && !props.selectionMode && !choosingTag()}>
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
