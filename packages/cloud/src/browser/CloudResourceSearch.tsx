import { query, timed } from "@k2b/stdlib/solid";
import { NoticeCard, Select, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SearchApp, SearchItem, SearchResponse } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import { cloudResourceSearchUrl, filterCloudResourceSearchItems } from "./resource-search";
import { resourceSearchMessages } from "./resource-search-messages";

type ParsedInput = {
  query: string;
  tags: string[];
};

export type CloudResourceSearchHelpApp = {
  appId: string;
  appName: string;
  appIcon: string;
  tags: string[];
};

export type CloudResourceSearchProps = {
  onSelect: (item: SearchItem) => void;
  onHelp?: () => void;
  helpApps?: readonly CloudResourceSearchHelpApp[];
  initialAppId?: string;
  placeholder?: string;
  requireReader?: boolean;
  excludeRefs?: readonly CloudResourceRef[];
};

type TagSuggestion = {
  tag: string;
  appName: string;
  appIcon: string;
};

const MIN_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 200;
const TAG_TOKEN_PATTERN = /^[^\s#]+$/;

const rowKey = (item: SearchItem) => `row:${item.appId}:${item.ref.type}:${item.ref.id}`;
const isValidImagePreviewUrl = (url?: string) => typeof url === "string" && url.startsWith("/");
const sortByPriorityAndTitle = (a: SearchItem, b: SearchItem) => {
  const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  return a.title.localeCompare(b.title);
};

/**
 * Cluster items by their owning app while preserving the global priority
 * order across groups: the first occurrence of each app fixes its slot, and
 * items within a group keep their original (already sorted) order. Map
 * iteration order in JS is insertion order, so this is stable.
 */
const groupByApp = (items: SearchItem[]): SearchItem[] => {
  const groups = new Map<string, SearchItem[]>();
  for (const item of items) {
    const arr = groups.get(item.appId);
    if (arr) arr.push(item);
    else groups.set(item.appId, [item]);
  }
  const out: SearchItem[] = [];
  for (const group of groups.values()) out.push(...group);
  return out;
};

type ListEntry =
  | { kind: "header"; appId: string; appName: string; appIcon: string; count: number }
  | { kind: "item"; item: SearchItem; flatIndex: number };

/**
 * Build the flat render list with optional group headers interleaved.
 * Headers only appear when 2+ apps have results (single-app queries stay
 * uncluttered). `flatIndex` on each item entry mirrors the index into the
 * underlying sorted list — used for selection/scroll/keyboard nav.
 */
const buildListEntries = (items: SearchItem[]): ListEntry[] => {
  if (items.length === 0) return [];

  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.appId, (counts.get(item.appId) ?? 0) + 1);
  const showHeaders = counts.size >= 2;

  const entries: ListEntry[] = [];
  let prevAppId: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (showHeaders && item.appId !== prevAppId) {
      entries.push({
        kind: "header",
        appId: item.appId,
        appName: item.appName,
        appIcon: item.appIcon,
        count: counts.get(item.appId) ?? 0,
      });
      prevAppId = item.appId;
    }
    entries.push({ kind: "item", item, flatIndex: i });
  }
  return entries;
};

const parseInput = (raw: string): ParsedInput => {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const tags: string[] = [];
  const queryTokens: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("#") && token.length > 1) {
      const tag = token.slice(1).toLowerCase();
      if (TAG_TOKEN_PATTERN.test(tag)) {
        tags.push(tag);
        continue;
      }
    }

    queryTokens.push(token);
  }

  return {
    query: queryTokens.join(" "),
    tags: [...new Set(tags)],
  };
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const removeTagFromInput = (raw: string, tag: string): string => {
  const pattern = new RegExp(`(^|\\s)#${escapeRegex(tag)}(?=\\s|$)`, "gi");
  return raw.replace(pattern, "").replace(/\s+/g, " ").trim();
};

const metadataRows = (metadata?: SearchItem["metadata"]) =>
  (metadata ?? []).filter((entry) => entry.label.trim().length > 0 && entry.value.trim().length > 0).slice(0, 5);

const loadSearch = async (url: string, abortSignal: AbortSignal, fallbackMessage: string): Promise<SearchResponse> => {
  const response = await fetch(url, { signal: abortSignal });
  const payload = (await response.json()) as SearchResponse | { message?: string };
  if (!response.ok) {
    throw new Error("message" in payload ? (payload.message ?? fallbackMessage) : fallbackMessage);
  }
  return payload as SearchResponse;
};

export default function CloudResourceSearch(props: CloudResourceSearchProps) {
  const locale = useLocale();
  const t = () => resourceSearchMessages.resolve([locale()]).t;
  const [rawInput, setRawInput] = createSignal("");
  const [appId, setAppId] = createSignal<string | null>(props.initialAppId ?? null);
  const [searchUrl, setSearchUrl] = createSignal(
    cloudResourceSearchUrl({ query: "", tags: [], appId: props.initialAppId, requireReader: props.requireReader }),
  );
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [previewFailed, setPreviewFailed] = createSignal(false);
  const [cursorPos, setCursorPos] = createSignal(0);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);

  let inputRef: HTMLInputElement | undefined;
  const rowRefs = new Map<string, HTMLButtonElement>();

  const parsedInput = createMemo(() => parseInput(rawInput()));
  const canSearch = createMemo(() => Boolean(appId()) || parsedInput().tags.length > 0 || parsedInput().query.length >= MIN_QUERY_LENGTH);
  const searchQuery = query.create({
    source: searchUrl,
    enabled: () => searchUrl().length > 0,
    load: (url, { abortSignal }) => loadSearch(url, abortSignal, t().searchFailed),
  });
  const resultItems = createMemo(() => {
    const sorted = filterCloudResourceSearchItems(searchQuery.data()?.items ?? [], props)
      .slice()
      .sort(sortByPriorityAndTitle);
    return groupByApp(sorted);
  });
  const apps = createMemo<SearchApp[]>(() => searchQuery.data()?.apps ?? []);
  const unsupportedTags = createMemo(() => searchQuery.data()?.unsupportedTags ?? []);

  // Tag suggestions for the empty state — flat list of every tag declared by
  // any app, deduped on tag name (first declaration wins) so we don't render
  // the same chip twice when two apps share a tag.
  const tagSuggestions = createMemo<TagSuggestion[]>(() => {
    const seen = new Set<string>();
    const out: TagSuggestion[] = [];
    for (const app of props.helpApps ?? []) {
      for (const tag of app.tags) {
        const lower = tag.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push({ tag: lower, appName: app.appName, appIcon: app.appIcon });
      }
    }
    return out;
  });

  /**
   * Detect whether the caret is currently inside a tag token (i.e. the user
   * is mid-typing `#...`). Returns the token's start/end indices in rawInput
   * plus the lowercased prefix typed after `#`. Returns null otherwise — no
   * autocomplete popover should show.
   *
   * Walks back from the cursor to the last whitespace; if the token starts
   * with `#`, we're in tag-input mode. If the prefix contains a non-tag
   * character (`#` or whitespace), bails — the parser would reject it
   * anyway, so suggestions would be misleading.
   */
  const tagContext = createMemo(() => {
    const text = rawInput();
    const pos = Math.min(cursorPos(), text.length);
    let start = pos;
    while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
    // Extend to the next whitespace so we replace the WHOLE token, not just
    // up to the caret. Otherwise editing in the middle of an existing tag
    // (e.g. caret after `#no` in `#notebook`) leaves `tebook` dangling after
    // the inserted suggestion. Prefix used for matching is still the part
    // BEFORE the caret — that's what the user has committed to typing.
    let end = pos;
    while (end < text.length && !/\s/.test(text[end] ?? "")) end++;
    const fullToken = text.slice(start, end);
    if (!fullToken.startsWith("#")) return null;
    const prefix = text.slice(start + 1, pos).toLowerCase();
    if (prefix.length > 0 && !TAG_TOKEN_PATTERN.test(prefix)) return null;
    return { start, end, prefix };
  });

  /**
   * Tags filtered by the current prefix, with already-active tags excluded
   * (no point suggesting one the user has). Starts-with match for predictability.
   */
  const filteredSuggestions = createMemo<TagSuggestion[]>(() => {
    const ctx = tagContext();
    if (!ctx) return [];
    const active = new Set(parsedInput().tags);
    const all = tagSuggestions().filter((s) => !active.has(s.tag));
    if (ctx.prefix.length === 0) return all;
    return all.filter((s) => s.tag.startsWith(ctx.prefix));
  });

  const popoverOpen = createMemo(() => filteredSuggestions().length > 0);

  // Reset highlight when the filtered list changes shape (new prefix, etc.).
  createEffect(() => {
    filteredSuggestions();
    setSuggestionIndex(0);
  });

  const updateCursor = () => {
    if (!inputRef) return;
    setCursorPos(inputRef.selectionStart ?? rawInput().length);
  };

  const insertTagAtCursor = (tag: string) => {
    const ctx = tagContext();
    const text = rawInput();
    if (!ctx) {
      // No tag context — append. Used by suggestion-mode chips.
      if (parsedInput().tags.includes(tag)) {
        inputRef?.focus();
        return;
      }
      const next = text.length > 0 ? `${text.trimEnd()} #${tag} ` : `#${tag} `;
      setRawInput(next);
      const newPos = next.length;
      queueMicrotask(() => {
        if (inputRef) inputRef.setSelectionRange(newPos, newPos);
        setCursorPos(newPos);
      });
      inputRef?.focus();
      return;
    }
    const before = text.slice(0, ctx.start);
    const after = text.slice(ctx.end).replace(/^\s+/, "");
    // Always emit `#tag ` with one trailing space so the user can keep
    // typing the next token without manual spacing.
    const insertion = `#${tag} `;
    const next = before + insertion + after;
    setRawInput(next);
    const newPos = before.length + insertion.length;
    queueMicrotask(() => {
      if (inputRef) inputRef.setSelectionRange(newPos, newPos);
      setCursorPos(newPos);
    });
    inputRef?.focus();
  };

  const activeItem = createMemo(() => resultItems()[activeIndex()] ?? null);
  const listEntries = createMemo(() => buildListEntries(resultItems()));

  // Empty-state branching. Single source of truth for what the body renders.
  // - suggestions: user hasn't typed enough to search; show what's possible.
  // - unsupported-tags: response told us no app accepts these tags.
  // - no-results: search ran, returned nothing.
  // - ready: render results.
  // - idle: search debounced or in flight, no decision yet.
  type BodyMode = "suggestions" | "unsupported-tags" | "no-results" | "ready" | "idle";
  const bodyMode = createMemo<BodyMode>(() => {
    if (!canSearch()) return "suggestions";
    if (resultItems().length > 0) return "ready";
    if (searchQuery.loading() || searchQuery.refreshing() || (!searchQuery.data() && !searchQuery.error())) return "idle";
    if (unsupportedTags().length > 0) return "unsupported-tags";
    return "no-results";
  });

  const { debouncedFn: debounceSearch, cancel: cancelDebounce } = timed.debounce(
    (request: { input: ParsedInput; appId: string | null }) => {
      setSearchUrl(cloudResourceSearchUrl({ ...request.input, appId: request.appId, requireReader: props.requireReader }));
    },
    SEARCH_DEBOUNCE_MS,
  );

  const bindRowRef = (key: string, element?: HTMLButtonElement) => {
    if (!element) {
      rowRefs.delete(key);
      return;
    }
    rowRefs.set(key, element);
  };

  const selectItem = (row?: SearchItem) => {
    if (!row) return;
    props.onSelect(row);
  };

  const moveSelection = (delta: -1 | 1) => {
    const list = resultItems();
    if (list.length === 0) return;
    const next = (activeIndex() + delta + list.length) % list.length;
    setActiveIndex(next);
  };

  const removeTag = (tag: string) => {
    setRawInput((prev) => removeTagFromInput(prev, tag));
    inputRef?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    // Tag autocomplete intercepts navigation when the popover is open. Only
    // reaches results-list nav when no suggestion is being chosen.
    if (popoverOpen()) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const list = filteredSuggestions();
        setSuggestionIndex((i) => (i + 1) % list.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const list = filteredSuggestions();
        setSuggestionIndex((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const list = filteredSuggestions();
        const choice = list[suggestionIndex()];
        if (choice) insertTagAtCursor(choice.tag);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Close popover by erasing the in-flight tag token (caret-prefixed
        // `#xyz`) — leaves the rest of the query intact. If the user wants
        // to keep `#xyz`, they can press Space instead.
        const ctx = tagContext();
        if (ctx) {
          const text = rawInput();
          const next = text.slice(0, ctx.start) + text.slice(ctx.end).replace(/^\s+/, "");
          setRawInput(next);
          queueMicrotask(() => {
            if (inputRef) inputRef.setSelectionRange(ctx.start, ctx.start);
            setCursorPos(ctx.start);
          });
        }
        return;
      }
      // Space commits the current token as-is and closes the popover by
      // virtue of advancing the cursor past `#`. No special handling needed —
      // tagContext recomputes naturally.
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      selectItem(activeItem() ?? undefined);
    }
  };

  createEffect(() => {
    const response = searchQuery.data();
    if (response) setActiveIndex(0);
  });

  createEffect(() => {
    const maxIndex = resultItems().length - 1;
    if (maxIndex < 0) {
      setActiveIndex(0);
      return;
    }

    if (activeIndex() > maxIndex) setActiveIndex(maxIndex);
  });

  createEffect(() => {
    const item = activeItem();
    const key = item ? rowKey(item) : null;

    setPreviewFailed(false);
    if (!key) return;

    queueMicrotask(() => {
      rowRefs.get(key)?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    const input = parsedInput();
    const selectedAppId = appId();

    if (!canSearch()) {
      cancelDebounce();
      setSearchUrl(cloudResourceSearchUrl({ ...input, requireReader: props.requireReader }));
      setActiveIndex(0);
      return;
    }

    debounceSearch({ input, appId: selectedAppId });
  });

  onCleanup(() => {
    cancelDebounce();
  });

  onMount(() => {
    requestAnimationFrame(() => inputRef?.focus());
  });

  return (
    <div
      class="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] text-zinc-900 dark:text-zinc-100"
      classList={{
        "md:grid-cols-[minmax(0,1fr)_18rem] md:gap-x-3": bodyMode() === "ready",
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      <div class="flex min-w-0 items-center gap-2 pr-3">
        <div class="relative min-w-0 flex-1">
          <label class="flex items-center gap-3 px-4 py-3.5">
            <i class="ti ti-search text-xl text-dimmed" />
            <input
              id="spotlight-input"
              ref={inputRef}
              type="search"
              value={rawInput()}
              onInput={(event) => {
                setRawInput(event.currentTarget.value);
                setCursorPos(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
              }}
              onKeyUp={updateCursor}
              onClick={updateCursor}
              onSelect={updateCursor}
              onKeyDown={handleKeyDown}
              placeholder={props.placeholder ?? t().searchPlaceholder}
              aria-label={t().searchCloudResources}
              class="w-full border-0 bg-transparent text-base outline-none placeholder:text-dimmed md:text-lg"
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
            />
            <Show when={searchQuery.loading() || searchQuery.refreshing()}>
              <i class="ti ti-loader-2 animate-spin text-dimmed" />
            </Show>
          </label>

          {/* Tag autocomplete popover. Anchored to the input row, overlays the
            body when the user is mid-typing a `#tag` token. Keyboard nav
            (Up/Down/Tab/Enter/Escape) is intercepted by handleKeyDown. */}
          <Show when={popoverOpen()}>
            <div
              class="absolute left-3 right-3 top-full z-30 -mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl bg-white/95 p-1.5 shadow-lg ring-1 ring-inset ring-zinc-300/60 backdrop-blur-sm dark:bg-zinc-900/95 dark:ring-zinc-700/60"
              role="listbox"
              aria-label={t().tagSuggestions}
            >
              <For each={filteredSuggestions()}>
                {(suggestion, index) => {
                  const selected = () => index() === suggestionIndex();
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected()}
                      onMouseEnter={() => setSuggestionIndex(index())}
                      onMouseDown={(e) => {
                        // mousedown so the input doesn't lose focus to the click.
                        e.preventDefault();
                        insertTagAtCursor(suggestion.tag);
                      }}
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors"
                      classList={{
                        "bg-blue-50/85 dark:bg-blue-950/45": selected(),
                        "hover:bg-zinc-100/85 dark:hover:bg-zinc-800/60": !selected(),
                      }}
                    >
                      <i class={`${suggestion.appIcon} text-[12px] text-dimmed`} />
                      <span class="font-medium">#{suggestion.tag}</span>
                      <span class="text-[10px] text-dimmed">{suggestion.appName}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
        <Select
          class="w-44 shrink-0"
          aria-label={t().filterByApp}
          value={appId}
          onValueChange={setAppId}
          placeholder={t().allApps}
          clearable
          options={apps().map((app) => ({ id: app.id, label: app.name, icon: app.icon }))}
        />
      </div>

      <div class="min-h-0 overflow-hidden">
        <div class="flex h-full min-h-0 flex-col gap-2 px-3 pb-3">
          {/* Active-tag chip row + meta. Hidden in suggestions mode. */}
          <Show when={bodyMode() !== "suggestions"}>
            <div class="flex h-8 items-center justify-between gap-3">
              <div class="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-dimmed">
                <Show when={parsedInput().tags.length > 0}>
                  <div class="flex flex-wrap items-center gap-1">
                    <For each={parsedInput().tags}>
                      {(tag) => {
                        const isUnsupported = () => unsupportedTags().includes(tag);
                        return (
                          <span
                            class="group inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                            classList={{
                              "bg-zinc-200/70 dark:bg-zinc-800/70": !isUnsupported(),
                              "bg-amber-200/60 text-amber-900 dark:bg-amber-900/35 dark:text-amber-200": isUnsupported(),
                            }}
                          >
                            #{tag}
                            <button
                              type="button"
                              class="opacity-60 hover:opacity-100"
                              onClick={() => removeTag(tag)}
                              aria-label={t().removeTag({ tag })}
                              title={t().removeTagTitle({ tag })}
                            >
                              <i class="ti ti-x text-[10px]" />
                            </button>
                          </span>
                        );
                      }}
                    </For>
                  </div>
                </Show>
                <Show when={bodyMode() === "ready"}>
                  <span>
                    {t().resultCount({ count: resultItems().length })} <span aria-hidden="true">•</span>{" "}
                    <Show when={props.onHelp}>
                      <button type="button" class="text-blue-500 hover:underline dark:text-blue-400" onClick={() => props.onHelp?.()}>
                        {t().tagHelp}
                      </button>
                    </Show>
                  </span>
                </Show>
              </div>
            </div>
          </Show>

          <div class="min-h-0 flex-1 overflow-hidden">
            <Show when={searchQuery.error()}>
              {(error) => (
                <NoticeCard tone="danger" icon={false} class="mb-2">
                  {error().message}
                </NoticeCard>
              )}
            </Show>

            {/* Suggestions: empty input, show available tags as clickable chips. */}
            <Show when={bodyMode() === "suggestions"}>
              <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
                <p class="text-xs text-dimmed">
                  {t().typeToSearchBeforeTag} <code class="rounded bg-zinc-100 px-1 py-0.5 text-[10px] dark:bg-zinc-900">#tag</code>{" "}
                  {t().typeToSearchAfterTag}
                </p>
                <Show when={tagSuggestions().length > 0} fallback={<p class="text-xs text-dimmed">{t().noTagsAvailable}</p>}>
                  <div class="flex flex-wrap gap-1">
                    <For each={tagSuggestions()}>
                      {(suggestion) => (
                        <button
                          type="button"
                          onClick={() => insertTagAtCursor(suggestion.tag)}
                          class="inline-flex items-center gap-1 rounded-full bg-zinc-100/80 px-2 py-0.5 text-[10px] leading-4 text-zinc-700 transition-colors hover:bg-zinc-200/80 dark:bg-zinc-900/55 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
                          title={t().addTag({ tag: suggestion.tag, app: suggestion.appName })}
                        >
                          <i class={`${suggestion.appIcon} text-[10px] text-dimmed`} />
                          <span>#{suggestion.tag}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={props.onHelp}>
                  <button
                    type="button"
                    class="self-start text-[11px] text-blue-500 hover:underline dark:text-blue-400"
                    onClick={() => props.onHelp?.()}
                  >
                    {t().seeAllTagDescriptions}
                  </button>
                </Show>
              </div>
            </Show>

            {/* Unsupported tags: response told us no app handles them. */}
            <Show when={bodyMode() === "unsupported-tags"}>
              <div class="flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center">
                <i class="ti ti-tag-off text-2xl text-dimmed" />
                <div class="flex flex-col gap-1">
                  <p class="text-xs">
                    {t().noAppSupports}{" "}
                    <For each={unsupportedTags()}>
                      {(tag, index) => (
                        <>
                          <code class="rounded bg-amber-200/60 px-1 py-0.5 text-[10px] text-amber-900 dark:bg-amber-900/35 dark:text-amber-200">
                            #{tag}
                          </code>
                          <Show when={index() < unsupportedTags().length - 1}> </Show>
                        </>
                      )}
                    </For>
                    .
                  </p>
                  <p class="text-[11px] text-dimmed">{t().removeTagOrPick}</p>
                </div>
                <div class="flex flex-wrap items-center justify-center gap-1.5">
                  <For each={unsupportedTags()}>
                    {(tag) => (
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        class="inline-flex items-center gap-1 rounded-full bg-amber-200/60 px-2.5 py-1 text-[11px] text-amber-900 hover:bg-amber-300/60 dark:bg-amber-900/35 dark:text-amber-200 dark:hover:bg-amber-900/55"
                      >
                        <span>{t().removeNamedTag({ tag })}</span>
                        <i class="ti ti-x text-[10px]" />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* No matches at all (query/tags valid, just empty result set). */}
            <Show when={bodyMode() === "no-results"}>
              <div class="flex h-full min-h-0 flex-col items-center justify-center gap-2 text-center">
                <i class="ti ti-mood-empty text-2xl text-dimmed" />
                <p class="text-xs text-dimmed">
                  {t().noMatches}
                  {parsedInput().query.length > 0 ? (
                    <>
                      {" "}
                      {t().matchesFor} <span class="text-zinc-700 dark:text-zinc-200">"{parsedInput().query}"</span>
                    </>
                  ) : null}
                  .
                </p>
              </div>
            </Show>

            {/* Ready: the left result list; the detail spans both grid rows below. */}
            <Show when={bodyMode() === "ready"}>
              <div class="h-full min-h-0">
                <section class="h-full min-h-0 overflow-y-auto overscroll-y-contain pr-1" onWheel={(event) => event.stopPropagation()}>
                  <div class="flex flex-col">
                    <For each={listEntries()}>
                      {(entry) => {
                        if (entry.kind === "header") {
                          // Faint section header — no <hr>, no border. First
                          // header gets less top spacing so it doesn't shove
                          // the list down on group transitions.
                          return (
                            <div class="flex items-center gap-1.5 px-1 pt-3 pb-1 text-[10px] uppercase tracking-wide text-dimmed first:pt-1">
                              <i class={`${entry.appIcon} text-[11px]`} />
                              <span>{entry.appName}</span>
                              <span class="opacity-60">· {entry.count}</span>
                            </div>
                          );
                        }
                        const item = entry.item;
                        const selected = () => entry.flatIndex === activeIndex();
                        return (
                          <button
                            ref={(element) => bindRowRef(rowKey(item), element)}
                            type="button"
                            onMouseEnter={() => setActiveIndex(entry.flatIndex)}
                            onClick={() => selectItem(item)}
                            class="mt-1.5 w-full rounded-xl p-2.5 text-left transition-colors first:mt-0"
                            classList={{
                              "bg-blue-50/85 dark:bg-blue-950/45": selected(),
                              "bg-zinc-50/75 hover:bg-zinc-100/85 dark:bg-zinc-900/45 dark:hover:bg-zinc-900/65": !selected(),
                            }}
                          >
                            <div class="flex items-start gap-2.5">
                              <i class={`${item.icon ?? item.appIcon} mt-0.5 text-[13px] text-dimmed`} />
                              <div class="min-w-0">
                                <p class="truncate text-xs">{item.title}</p>
                                <Show when={item.preview}>
                                  <p class="mt-0.5 truncate text-[11px] text-dimmed">{item.preview}</p>
                                </Show>
                                <p class="mt-1 text-[10px] text-dimmed">{item.appName}</p>
                              </div>
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </section>
              </div>
            </Show>
          </div>
        </div>
      </div>

      <Show when={bodyMode() === "ready"}>
        <aside
          class="hidden min-h-0 overflow-y-auto overscroll-y-contain rounded-xl bg-zinc-50/80 p-3 dark:bg-zinc-900/55 md:col-start-2 md:row-start-1 md:row-span-2 md:my-3 md:mr-3 md:block"
          onWheel={(event) => event.stopPropagation()}
        >
          <Show when={activeItem()} fallback={<div class="text-xs text-dimmed">{t().selectPreview}</div>}>
            {(item) => (
              <div class="flex flex-col gap-4">
                <div class="flex items-center gap-3">
                  <div class="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-900">
                    <Show
                      when={isValidImagePreviewUrl(item().previewUrl) && !previewFailed()}
                      fallback={<i class={`${item().icon ?? item().appIcon} text-lg text-dimmed`} />}
                    >
                      <img
                        src={item().previewUrl}
                        alt={item().title}
                        class="h-full w-full object-cover"
                        onError={() => setPreviewFailed(true)}
                      />
                    </Show>
                  </div>
                  <div class="min-w-0">
                    <p class="truncate text-sm">{item().title}</p>
                    <p class="mt-0.5 truncate text-xs text-dimmed">{item().appName}</p>
                  </div>
                </div>

                <Show when={item().preview}>
                  <p class="text-xs leading-relaxed text-dimmed">{item().preview}</p>
                </Show>

                <Show when={metadataRows(item().metadata).length > 0}>
                  <div class="rounded-lg bg-zinc-100/65 p-2 dark:bg-zinc-900/65">
                    <div class="flex flex-col gap-1">
                      <For each={metadataRows(item().metadata)}>
                        {(entry) => (
                          <div class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 rounded-md px-1 py-1 text-xs">
                            <span class="truncate text-dimmed">{entry.label}</span>
                            <span class="truncate">{entry.value}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </aside>
      </Show>
    </div>
  );
}
