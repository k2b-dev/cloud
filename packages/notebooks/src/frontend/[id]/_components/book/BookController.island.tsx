import { query } from "@k2b/stdlib/solid";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { BOOK_CONTENT_EVENT, BOOK_SNAPSHOT_EVENT, type BookMetadata, type BookSnapshot, bookNavigationTarget } from "./book-state";
import { bookMessages } from "./messages";

type Props = { notebookId: string; initial: BookMetadata };
type ScrollPosition = { top: number; left: number; windowX: number; windowY: number };
type PendingNavigation = { href: string; hash: string; kind: "push" | "pop"; scroll?: ScrollPosition };
const SCROLL_KEY = "notebooksBookScroll";

/** Only metadata crosses the island boundary; the article stays server HTML. */
export default function BookController(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const initialHref = withPresentationMode(props.initial.href, "book");
  const [source, setSource] = createSignal(initialHref);
  const initial: { source: string; snapshot: BookSnapshot } = {
    source: initialHref,
    snapshot: { ...props.initial, href: initialHref, html: null },
  };
  let pending: PendingNavigation | undefined;
  let lastApplied = initial;
  let article: HTMLElement | null = null;
  let scrollContainer: HTMLElement | null = null;
  let mounted = false;

  const workspace = query.create({
    source,
    initial: { source: initialHref, data: initial },
    load: async (href, { abortSignal }) => {
      const response = await apiClient[":id"].book.$get(
        { param: { id: props.notebookId }, query: { href } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status) && !abortSignal.aborted) {
          article?.replaceChildren();
          window.location.assign(pending?.href ?? window.location.href);
        }
        throw new Error(t().loadFailed);
      }
      const snapshot: BookSnapshot = await response.json();
      return { source: href, snapshot };
    },
  });

  const saveScroll = () => {
    if (!scrollContainer || pending) return;
    const scroll: ScrollPosition = {
      top: scrollContainer.scrollTop,
      left: scrollContainer.scrollLeft,
      windowX: window.scrollX,
      windowY: window.scrollY,
    };
    const state = typeof history.state === "object" && history.state !== null ? history.state : {};
    history.replaceState({ ...state, [SCROLL_KEY]: scroll }, "");
  };

  createEffect(() => {
    const loaded = workspace.data();
    if (!mounted || !article || !loaded || loaded === lastApplied || loaded.source !== source()) return;
    lastApplied = loaded;
    const { html, ...metadata } = loaded.snapshot;
    const navigating = pending;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    const scrollLeft = scrollContainer?.scrollLeft ?? 0;
    const focused = document.activeElement;
    const searchInput = !navigating && focused instanceof HTMLInputElement && article.contains(focused) ? focused : null;
    const draft = searchInput
      ? { name: searchInput.name, value: searchInput.value, start: searchInput.selectionStart, end: searchInput.selectionEnd }
      : null;
    // This string is produced only by the permission-aware server renderer.
    if (html !== null) article.innerHTML = html;
    else article.textContent = metadata.tree.length ? t().selectNote : t().empty;
    article.setAttribute("aria-label", metadata.title ?? metadata.notebookName);
    const historyWarning = document.getElementById("notebook-book-history-warning");
    if (historyWarning) historyWarning.hidden = !metadata.historyIncomplete;
    const heading = document.getElementById("notebook-book-name");
    if (heading) heading.textContent = metadata.notebookName;
    document.title = metadata.title ? `${metadata.title} · ${metadata.notebookName}` : metadata.notebookName;
    pending = undefined;
    if (navigating?.kind === "push") history.pushState({}, "", `${metadata.href}${navigating.hash}`);
    window.dispatchEvent(new CustomEvent<BookMetadata>(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
    window.dispatchEvent(new CustomEvent(BOOK_CONTENT_EVENT));
    if (!navigating) scrollContainer?.scrollTo(scrollLeft, scrollTop);
    if (navigating) {
      const drawer = article
        .closest(".notebook-book-shell")
        ?.querySelector<HTMLDetailsElement>(".k2b-app-workspace__sidebar-mobile details");
      if (drawer) drawer.open = false;
      article.focus({ preventScroll: true });
      if (navigating.kind === "pop" && navigating.scroll) {
        scrollContainer?.scrollTo(navigating.scroll.left, navigating.scroll.top);
        window.scrollTo(navigating.scroll.windowX, navigating.scroll.windowY);
      } else if (navigating.hash) {
        let id = navigating.hash.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          /* Keep a literal malformed anchor harmless. */
        }
        document.getElementById(id)?.scrollIntoView();
      } else {
        scrollContainer?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      }
    } else if (draft) {
      const restored = article.querySelector<HTMLInputElement>(`input[name="${CSS.escape(draft.name)}"]`);
      if (restored) {
        restored.value = draft.value;
        restored.focus({ preventScroll: true });
        if (restored.type === "text" || restored.type === "search") restored.setSelectionRange(draft.start, draft.end);
      }
    }
    saveScroll();
  });

  onMount(() => {
    mounted = true;
    article = document.getElementById("notebook-book-content");
    scrollContainer = article?.closest<HTMLElement>(".notebook-book-main") ?? null;
    const previousScrollRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    history.replaceState(history.state, "", `${initialHref}${window.location.hash}`);

    const navigate = (url: URL, kind: "push" | "pop", scroll?: ScrollPosition) => {
      if (kind === "push") saveScroll();
      pending = { href: url.href, hash: url.hash, kind, scroll };
      const next = `${url.pathname}${url.search}`;
      if (source() === next) void workspace.refresh();
      else setSource(next);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (
        !anchor ||
        !anchor.closest(".notebook-book-shell") ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      if (anchor.getAttribute("href")?.startsWith("#")) {
        saveScroll();
        return;
      }
      const url = bookNavigationTarget(anchor.href, window.location.href, props.notebookId);
      if (!url) return;
      // Notebook entry applies homepage/last-note redirects on the server.
      if (url.pathname.replace(/\/$/, "") === `/app/notebooks/${props.notebookId}`) return;
      const current = new URL(window.location.href);
      if (url.pathname === current.pathname && url.search === current.search && url.hash) return;
      event.preventDefault();
      navigate(url, "push");
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !article?.contains(form) || form.method.toLowerCase() !== "get")
        return;
      const url = new URL(form.action, window.location.href);
      const values = new FormData(form);
      url.search = "";
      values.forEach((value, key) => {
        if (typeof value === "string") url.searchParams.append(key, value);
      });
      const target = bookNavigationTarget(url.href, window.location.href, props.notebookId);
      if (!target) return;
      event.preventDefault();
      navigate(target, "push");
    };
    const onPopState = (event: PopStateEvent) => {
      const url = bookNavigationTarget(window.location.href, window.location.href, props.notebookId);
      if (!url) {
        window.location.reload();
        return;
      }
      if (!pending && `${url.pathname}${url.search}` === source()) {
        const scroll = event.state?.[SCROLL_KEY] as ScrollPosition | undefined;
        if (scroll) {
          scrollContainer?.scrollTo(scroll.left, scroll.top);
          window.scrollTo(scroll.windowX, scroll.windowY);
        }
        return;
      }
      navigate(url, "pop", event.state?.[SCROLL_KEY]);
    };
    const onWorkspaceEvent = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
      if (detail.event.notebookId !== props.notebookId) return;
      if (detail.event.type === "note.comments.changed" || detail.event.type === "note.favorite.changed") {
        detail.cover(Promise.resolve());
      } else {
        detail.cover(workspace.invalidate());
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    scrollContainer?.addEventListener("scroll", saveScroll, { passive: true });
    window.addEventListener("scroll", saveScroll, { passive: true });
    onCleanup(() => {
      mounted = false;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      scrollContainer?.removeEventListener("scroll", saveScroll);
      window.removeEventListener("scroll", saveScroll);
      history.scrollRestoration = previousScrollRestoration;
    });
  });

  createEffect(() => {
    const loading = workspace.loading() || workspace.refreshing();
    article?.setAttribute("aria-busy", String(loading));
  });

  return (
    <div aria-live="polite">
      <Show when={workspace.error()}>
        <NoticeCard tone="warning">
          <span>{t().loadFailed}</span>
          <Button variant="ghost" size="xs" onClick={() => void workspace.refresh()} loading={workspace.refreshing()}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
    </div>
  );
}
