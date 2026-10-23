import { importOnDemand } from "@k2b/cloud/browser/reload";
import { timed } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { MailSearchState } from "../../contracts";
import {
  DEFAULT_MAIL_QUICK_SEARCH_FIELDS,
  encodedParameterLength,
  MAIL_QUICK_SEARCH_FIELDS,
  MAIL_QUICK_SEARCH_FIELDS_PARAMETER,
  MAIL_SEARCH_PARAMETER,
  MAX_MAIL_SEARCH_PARAMETER_LENGTH,
  MAX_MAIL_WORKSPACE_HREF_LENGTH,
  type MailQuickSearchField,
  parseMailQuickSearchFields,
  type ResolvedMailSearchRoute,
  simpleMailSearchExpression,
} from "../../search-url";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { buildMailSearchClearHref, buildMailSearchHref, mailRouteUrl } from "./mail-navigation";
import { summarizeMailSearchExpression } from "./mail-search-builder-model";

const selectedQuickSearchFields = (url: URL): MailQuickSearchField[] => {
  const fields = parseMailQuickSearchFields(url);
  return fields.length > 0 ? fields : [...DEFAULT_MAIL_QUICK_SEARCH_FIELDS];
};
const DEFAULT_QUICK_SEARCH_FIELD_SET = new Set<MailQuickSearchField>(DEFAULT_MAIL_QUICK_SEARCH_FIELDS);
export const isDefaultQuickSearch = (fields: MailQuickSearchField[]): boolean =>
  fields.length === DEFAULT_MAIL_QUICK_SEARCH_FIELDS.length && fields.every((field) => DEFAULT_QUICK_SEARCH_FIELD_SET.has(field));

/** Mailbox-owned search intent. Rendering it in the head does not change the route/abort owner. */
export function createMailboxSearch(props: {
  mailboxId: string;
  requestUrl: string;
  query: string;
  search: ResolvedMailSearchRoute;
  savedViews: SavedConversationView[];
  activeSavedViewId: string | null;
  folders: MailFolderView[];
  localTags: LocalTag[];
  canWrite: boolean;
  onOpenHref: (href: string, replace?: boolean) => void | Promise<void>;
  onNavigationStart?: () => void;
  enabled?: boolean;
  onUse?: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  const requestUrl = () => mailRouteUrl(props.requestUrl);
  const quickSearchFieldOptions = createMemo(
    () =>
      [
        { value: "any", label: messages().everything, icon: "ti ti-search" },
        { value: "from", label: messages().sender, icon: "ti ti-user-up" },
        { value: "recipients", label: messages().recipients, icon: "ti ti-user-down" },
        { value: "subject", label: messages().subject, icon: "ti ti-letter-case" },
        { value: "body", label: messages().messageBody, icon: "ti ti-align-left" },
        { value: "attachment_name", label: messages().attachmentNames, icon: "ti ti-paperclip" },
      ] satisfies Array<{ value: MailQuickSearchField; label: string; icon: string }>,
  );
  const [opened, setOpened] = createSignal(Boolean(props.query.trim()));
  let manualMode = false;
  let input: HTMLInputElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let head: HTMLElement | null = null;
  let previousMinHeight = "";
  const releaseHeight = () => {
    if (head) head.style.minHeight = previousMinHeight;
    head = null;
  };
  const lockHeight = (element?: HTMLElement) => {
    if (head) return;
    head = element?.closest<HTMLElement>(".k2b-app-workspace__head") ?? null;
    if (head) {
      previousMinHeight = head.style.minHeight;
      head.style.minHeight = `${head.getBoundingClientRect().height}px`;
    }
  };
  onCleanup(releaseHeight);
  const focusInput = () =>
    queueMicrotask(() => {
      if (opened() && input?.isConnected) input.focus({ preventScroll: true });
    });
  const open = (element?: HTMLElement) => {
    lockHeight(element ?? trigger);
    manualMode = true;
    setOpened(true);
    props.onUse?.();
    focusInput();
  };
  const [searchValue, setSearchValue] = createSignal(props.query);
  const [validationError, setValidationError] = createSignal(false);
  let quickSearchPending = false;
  const [searchFields, setSearchFields] = createSignal<MailQuickSearchField[]>(selectedQuickSearchFields(requestUrl()));
  const activeSavedView = createMemo(() => props.savedViews.find((view) => view.id === props.activeSavedViewId) ?? null);
  const currentSearchState = createMemo(() => {
    const resolved = props.search;
    const parsed =
      requestUrl().searchParams.has(MAIL_SEARCH_PARAMETER) && resolved.expression
        ? { expression: resolved.expression, sort: resolved.sort }
        : null;
    if (parsed) return parsed;
    const saved = activeSavedView()?.filter;
    if (saved) return saved;
    return resolved.expression ? { expression: resolved.expression, sort: resolved.sort } : null;
  });
  const structuredSummary = createMemo(() => {
    const state = currentSearchState();
    return state ? summarizeMailSearchExpression(state.expression, locale(), { folders: props.folders, tags: props.localTags }) : null;
  });
  const searchActive = () => Boolean(props.query.trim() || requestUrl().searchParams.has(MAIL_SEARCH_PARAMETER) || props.activeSavedViewId);

  const close = () => {
    clearSearch();
    manualMode = false;
    setOpened(false);
    releaseHeight();
    queueMicrotask(() => {
      if (!opened() && trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  };
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || props.enabled === false || event.isComposing) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
      ) {
        const focusTarget = opened() ? input : trigger;
        if (!focusTarget?.isConnected || focusTarget.getClientRects().length === 0) return;
        event.preventDefault();
        open();
      } else if (
        event.key === "Escape" &&
        opened() &&
        (target === input ||
          (!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') &&
            target.closest("[data-mail-head-search], [data-mail-head-search-options], [data-mail-conversation-list]")))
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", keydown);
    onCleanup(() => document.removeEventListener("keydown", keydown));
  });
  const clearSearch = () => {
    quickSearch.cancel();
    setValidationError(false);
    setSearchValue("");
    setScopeFolderId(null);
    if (!manualMode) {
      setOpened(false);
      releaseHeight();
    } else focusInput();
    const currentUrl = requestUrl();
    if (currentUrl.searchParams.has("q")) {
      // A new history entry, so Back after clearing returns to the search instead of repeating the starting view.
      void props.onOpenHref(buildMailSearchClearHref(currentUrl));
    } else if (quickSearchPending) {
      // Supersede the pending search before it can put the cleared text back.
      void props.onOpenHref(`${currentUrl.pathname}${currentUrl.search}`, true);
    }
  };

  const originFolder = createMemo(() => {
    const origin = mailRouteUrl(buildMailSearchClearHref(requestUrl()));
    if (origin.searchParams.has("view") || origin.searchParams.has("savedView")) return null;
    return props.folders.find((folder) => folder.id === origin.searchParams.get("folder")) ?? null;
  });
  const routeScope = () => {
    const expression = props.search.expression;
    if (!props.query.trim() || expression?.type !== "and" || expression.expressions.length !== 2) return null;
    const folder = expression.expressions.find((part) => part.type === "folder_id");
    const text = expression.expressions.find((part) => part.type !== "folder_id");
    return folder &&
      JSON.stringify(text) === JSON.stringify(simpleMailSearchExpression(props.query, selectedQuickSearchFields(requestUrl())))
      ? folder.folderId
      : null;
  };
  const [scopeFolderId, setScopeFolderId] = createSignal<string | null>(routeScope());
  const updateScope = (folderId: string | null) => {
    if (searchValue().trim()) props.onNavigationStart?.();
    setScopeFolderId(folderId);
    if (searchValue().trim()) quickSearch.trigger(searchValue(), searchFields(), replaceLiveSearchRoute());
  };
  const applyQuickSearch = (query: string, fields: MailQuickSearchField[], replace: boolean) => {
    const currentUrl = requestUrl();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      clearSearch();
      return;
    }
    const search: Record<string, string> = { q: normalizedQuery };
    if (!isDefaultQuickSearch(fields)) search[MAIL_QUICK_SEARCH_FIELDS_PARAMETER] = fields.join(",");
    const folderId = scopeFolderId();
    const text = simpleMailSearchExpression(normalizedQuery, fields);
    if (folderId && text)
      search.search = JSON.stringify({ expression: { type: "and", expressions: [{ type: "folder_id", folderId }, text] }, sort: "newest" });
    const href = buildMailSearchHref(currentUrl, search);
    if (
      (search.search && encodedParameterLength(search.search) > MAX_MAIL_SEARCH_PARAMETER_LENGTH) ||
      href.length > MAX_MAIL_WORKSPACE_HREF_LENGTH
    ) {
      setValidationError(true);
      return;
    }
    setValidationError(false);
    if (href === `${currentUrl.pathname}${currentUrl.search}`) return;
    quickSearchPending = true;
    void props.onOpenHref(href, replace);
  };

  const quickSearch = timed.debounce(
    (query: string, fields: MailQuickSearchField[], replace: boolean) => applyQuickSearch(query, fields, replace),
    300,
  );
  const controls = {
    edit: (state: MailSearchState, source: URL) => void openAdvancedSearch(state, source),
    cancelPending: () => {
      quickSearch.cancel();
      quickSearchPending = false;
      setValidationError(false);
      setSearchValue(props.query);
      manualMode = false;
      setOpened(false);
      releaseHeight();
    },
  };

  createEffect(
    on(
      () => [props.query, props.requestUrl],
      () => {
        quickSearch.cancel();
        quickSearchPending = false;
        setSearchValue(props.query);
        setSearchFields(selectedQuickSearchFields(requestUrl()));
        setScopeFolderId(routeScope());
        if (props.query.trim()) setOpened(true);
        else if (!manualMode) {
          setOpened(false);
          releaseHeight();
        }
      },
    ),
  );

  const replaceLiveSearchRoute = () => requestUrl().searchParams.has("q");

  const updateSearchValue = (next: string) => {
    if (next.trim() !== props.query.trim()) props.onNavigationStart?.();
    setSearchValue(next);
    if (!next.trim()) {
      quickSearch.trigger("", searchFields(), replaceLiveSearchRoute());
      return;
    }
    quickSearch.debouncedFn(next, searchFields(), replaceLiveSearchRoute());
  };

  const submitSearch = (event: SubmitEvent) => {
    event.preventDefault();
    quickSearch.trigger(searchValue(), searchFields(), replaceLiveSearchRoute());
  };

  const updateSearchFields = (next: string[]) => {
    const allowed = new Set<string>(MAIL_QUICK_SEARCH_FIELDS);
    const selected = next.filter((field): field is MailQuickSearchField => allowed.has(field));
    const normalized = selected.length > 0 ? selected : [...DEFAULT_MAIL_QUICK_SEARCH_FIELDS];
    if (searchValue().trim() && normalized.join(",") !== searchFields().join(",")) props.onNavigationStart?.();
    setSearchFields(normalized);
    if (searchValue().trim()) quickSearch.trigger(searchValue(), normalized, replaceLiveSearchRoute());
    else quickSearch.cancel();
  };
  const searchFieldsLabel = () =>
    quickSearchFieldOptions()
      .filter((option) => searchFields().includes(option.value))
      .map((option) => option.label)
      .join(", ");

  const [searchBuilderLoading, setSearchBuilderLoading] = createSignal(false);
  const openAdvancedSearch = async (initialState?: MailSearchState, source?: URL) => {
    // The builder loads on first use; until its modal opens, a second activation must not open another one.
    if (searchBuilderLoading()) return;
    setSearchBuilderLoading(true);
    const builder = await importOnDemand(() => import("./MailSearchBuilder"));
    setSearchBuilderLoading(false);
    if (!builder) return;
    const result = await builder.openMailSearchBuilder({
      mailboxId: props.mailboxId,
      initialState: initialState ?? currentSearchState(),
      initialQuery: props.query,
      initialSavedView: activeSavedView(),
      canWrite: props.canWrite,
    });
    if (!result) return;
    const currentUrl = source ?? requestUrl();
    const href =
      result.action === "apply"
        ? buildMailSearchHref(currentUrl, { search: result.serialized })
        : result.action === "saved"
          ? buildMailSearchHref(currentUrl, { savedView: result.view.id })
          : buildMailSearchClearHref(currentUrl);
    manualMode = false;
    setOpened(false);
    releaseHeight();
    void props.onOpenHref(href);
  };

  return {
    ...controls,
    opened,
    open,
    close,
    lockHeight,
    releaseHeight,
    inputRef: (element: HTMLInputElement) => {
      input = element;
    },
    triggerRef: (element: HTMLButtonElement) => {
      trigger = element;
    },
    originFolder,
    scopeFolder: () => props.folders.find((folder) => folder.id === scopeFolderId()) ?? null,
    scopeFolderId,
    updateScope,
    searchValue,
    validationError,
    searchFields,
    quickSearchFieldOptions,
    structuredSummary,
    searchActive,
    clearSearch,
    updateSearchValue,
    submitSearch,
    updateSearchFields,
    searchFieldsLabel,
    searchBuilderLoading,
    openAdvancedSearch,
  };
}
