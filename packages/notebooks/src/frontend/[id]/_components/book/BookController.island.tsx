import { registerSearchNavigation } from "@k2b/cloud/browser/search";
import { query } from "@k2b/stdlib/solid";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { formatQueryPages, parseQueryPages, QUERY_PAGES_PARAM } from "../../../../lib/query-blocks";
import { attachmentFromContentUrl } from "../../../lib/editor/attachment-url";
import { notebookWorkspaceMessages } from "../../messages";
import { followFullWidth } from "../full-width";
import { NAVIGATION_VISIBILITY_EVENT, NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT } from "../sidebar/navigation-visibility";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { keepBookReadingPosition } from "./book-reading-position";
import {
  BOOK_CONTENT_EVENT,
  BOOK_SNAPSHOT_EVENT,
  type BookMetadata,
  type BookSnapshot,
  bookNavigationTarget,
  handleBookNavigationRequests,
} from "./book-state";
import { bookMessages } from "./messages";

type Props = { notebookId: string; initial: BookMetadata };
type ScrollPosition = { top: number; left: number; windowX: number; windowY: number };
type PendingNavigation = { href: string; hash: string; kind: "push" | "pop"; scroll?: ScrollPosition; settled?: (error?: Error) => void };
const SCROLL_KEY = "notebooksBookScroll";

/** Only metadata crosses the island boundary; the article stays server HTML. */
export default function BookController(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const workspaceText = () => notebookWorkspaceMessages.resolve([locale()]).t;
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
        if ([401, 403, 404].includes(response.status) && !abortSignal.aborted && !pending?.settled) {
          article?.removeAttribute("data-print-region");
          document.getElementById("notebook-book-history-warning")?.removeAttribute("data-print-region");
          article?.replaceChildren();
          window.location.assign(pending?.href ?? window.location.href);
        }
        throw new Error(t().loadFailed);
      }
      const snapshot: BookSnapshot = await response.json();
      return { source: href, snapshot };
    },
  });

  const anchorTarget = (hash: string): HTMLElement | null => {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* Keep a literal malformed anchor harmless. */
    }
    return id ? document.getElementById(id) : null;
  };
  const scrollToTop = () => {
    scrollContainer?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  };

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
    // A focused page button keeps focus through the new HTML, and a paged list never gets shorter, so turning pages or
    // a live change moves nothing.
    const pagerButton = !navigating && focused instanceof HTMLButtonElement && article.contains(focused) ? focused : null;
    const pagerFocus = pagerButton?.dataset.queryLine
      ? {
          line: pagerButton.dataset.queryLine,
          index: [...(pagerButton.closest(".notebook-query-pager")?.querySelectorAll("button[data-query-page]") ?? [])].indexOf(
            pagerButton,
          ),
        }
      : null;
    const listHeights = navigating
      ? new Map<string, number>()
      : new Map(
          [...article.querySelectorAll<HTMLElement>(".notebook-book-query[data-query-line]")].map(
            (block) => [block.dataset.queryLine!, block.getBoundingClientRect().height] as const,
          ),
        );
    // This string is produced only by the permission-aware server renderer.
    if (html !== null) article.innerHTML = html;
    else article.textContent = metadata.tree.length ? t().selectNote : t().empty;
    for (const block of article.querySelectorAll<HTMLElement>(".notebook-book-query[data-query-line]")) {
      const height = listHeights.get(block.dataset.queryLine!);
      if (height && block.querySelector(".notebook-query-pager") && block.getBoundingClientRect().height < height)
        block.style.minHeight = `${height}px`;
    }
    article.toggleAttribute("data-print-region", html !== null);
    article.setAttribute("aria-label", metadata.title ?? metadata.notebookName);
    const historyWarning = document.getElementById("notebook-book-history-warning");
    if (historyWarning) {
      historyWarning.hidden = !metadata.historyIncomplete;
      // The warning prints with the note it qualifies, never on its own.
      historyWarning.toggleAttribute("data-print-region", html !== null && metadata.historyIncomplete);
    }
    const heading = document.getElementById("notebook-book-name");
    if (heading) heading.textContent = metadata.notebookName;
    document.title = metadata.title ? `${metadata.title} · ${metadata.notebookName}` : metadata.notebookName;
    pending = undefined;
    if (navigating?.kind === "push") history.pushState({}, "", `${metadata.href}${navigating.hash}`);
    window.dispatchEvent(new CustomEvent<BookMetadata>(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
    window.dispatchEvent(new CustomEvent(BOOK_CONTENT_EVENT));
    if (!navigating) scrollContainer?.scrollTo(scrollLeft, scrollTop);
    if (navigating) {
      article.focus({ preventScroll: true });
      if (navigating.kind === "pop" && navigating.scroll) {
        scrollContainer?.scrollTo(navigating.scroll.left, navigating.scroll.top);
        window.scrollTo(navigating.scroll.windowX, navigating.scroll.windowY);
      } else {
        // A link to a heading the note does not have opens the note at its top.
        const target = anchorTarget(navigating.hash);
        if (target) target.scrollIntoView();
        else scrollToTop();
      }
    } else if (pagerFocus && pagerFocus.index >= 0) {
      const buttons = [
        ...article.querySelectorAll<HTMLButtonElement>(".notebook-book-query[data-query-line] button[data-query-page]"),
      ].filter((button) => button.dataset.queryLine === pagerFocus.line);
      // At the first or last page its own button turns off; the other one takes focus.
      const button = buttons[pagerFocus.index]?.disabled ? buttons[1 - pagerFocus.index] : buttons[pagerFocus.index];
      button?.focus({ preventScroll: true });
    } else if (draft) {
      const restored = article.querySelector<HTMLInputElement>(`input[name="${CSS.escape(draft.name)}"]`);
      if (restored) {
        restored.value = draft.value;
        restored.focus({ preventScroll: true });
        if (restored.type === "text" || restored.type === "search") restored.setSelectionRange(draft.start, draft.end);
      }
    }
    saveScroll();
    navigating?.settled?.();
  });

  createEffect(() => {
    const error = workspace.error();
    if (!error || !pending?.settled) return;
    const failed = pending;
    pending = undefined;
    setSource(lastApplied.source);
    failed.settled?.(error);
  });

  onMount(() => {
    mounted = true;
    article = document.getElementById("notebook-book-content");
    scrollContainer = article?.closest<HTMLElement>(".notebook-book-main") ?? null;
    if (scrollContainer) {
      followFullWidth(
        scrollContainer,
        () => (article && scrollContainer ? keepBookReadingPosition(article, scrollContainer) : null),
        workspaceText,
      );
    }
    const previousScrollRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    history.replaceState(history.state, "", `${initialHref}${window.location.hash}`);

    const navigate = (url: URL, kind: "push" | "pop", scroll?: ScrollPosition, settled?: (error?: Error) => void) => {
      pending?.settled?.();
      if (kind === "push") saveScroll();
      pending = { href: url.href, hash: url.hash, kind, scroll, settled };
      const next = `${url.pathname}${url.search}`;
      if (source() === next) void workspace.refresh();
      else setSource(next);
    };
    // Search results and the phone navigation sheet open reading routes in this shell.
    const shellTarget = (href: string) => {
      const target = bookNavigationTarget(href, window.location.href, props.notebookId);
      return target && target.pathname.replace(/\/$/, "") !== `/app/notebooks/${props.notebookId}` ? target : null;
    };
    // Search waits for the article so its dialog can report a failure in place.
    onCleanup(
      registerSearchNavigation(({ href }) => {
        const target = shellTarget(href);
        if (!target) return false;
        return new Promise<boolean>((resolve, reject) => {
          navigate(target, "push", undefined, (error) => (error ? reject(error) : resolve(true)));
        });
      }),
    );
    // The sheet is already closed, so its pages load like a link in the page, with the same retry and access fallback.
    onCleanup(
      handleBookNavigationRequests((href) => {
        const target = shellTarget(href);
        if (target) navigate(target, "push");
        return target !== null;
      }),
    );
    let previewLoading = false;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      // A query's page buttons turn its page in the address, so a reload or a live change shows the same rows.
      const pager = target?.closest<HTMLButtonElement>("button[data-query-page]");
      if (pager && article?.contains(pager)) {
        event.preventDefault();
        const line = Number(pager.dataset.queryLine);
        const page = Number(pager.dataset.queryPage);
        if (pager.disabled || !Number.isInteger(line) || !Number.isInteger(page) || page < 1) return;
        const url = new URL(window.location.href);
        // Only the queries on this page keep a page, so lines that moved away never crowd out the current ones.
        const lines = new Set(
          [...article.querySelectorAll<HTMLElement>(".notebook-book-query[data-query-line]")].map((block) =>
            Number(block.dataset.queryLine),
          ),
        );
        const pages = new Map([...parseQueryPages(url.searchParams.get(QUERY_PAGES_PARAM))].filter(([entry]) => lines.has(entry)));
        pages.set(line, page);
        const value = formatQueryPages(pages);
        if (value) url.searchParams.set(QUERY_PAGES_PARAM, value);
        else url.searchParams.delete(QUERY_PAGES_PARAM);
        history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
        pager.focus({ preventScroll: true });
        setSource(`${url.pathname}${url.search}`);
        return;
      }
      // The tree's chevron sits inside its row link; the tree folds the branch and cancels that link itself.
      if (target?.closest("[data-k2b-nav-tree-toggle]")) return;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]") ?? null;
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
      // An attachment opens its preview in place; an image of one opens in the lightbox. The previews load on the
      // first use, so reading never waits for them.
      const href = anchor.getAttribute("href") ?? "";
      const attachment = article?.contains(anchor) ? attachmentFromContentUrl(href, window.location.href) : null;
      if (attachment) {
        event.preventDefault();
        // One click opens one preview, also while its code loads for the first time.
        if (previewLoading) return;
        previewLoading = true;
        const image = anchor.classList.contains("notebook-book-image-link") ? anchor.querySelector("img") : null;
        import("../../../lib/attachment-preview")
          .then((preview) => {
            if (image) preview.openAttachedImage(image, attachment.notebookId, attachment.attachmentId, image.alt);
            else void preview.openAttachmentById(attachment.notebookId, attachment.attachmentId, anchor.textContent ?? "");
          })
          // Without the preview code, for example after a release replaced it, the link downloads the file as before.
          .catch(() => window.location.assign(href))
          .finally(() => {
            previewLoading = false;
          });
        return;
      }
      const url = bookNavigationTarget(anchor.href, window.location.href, props.notebookId);
      if (!url) return;
      // Notebook entry applies homepage/last-note redirects on the server.
      if (url.pathname.replace(/\/$/, "") === `/app/notebooks/${props.notebookId}`) return;
      const current = new URL(window.location.href);
      if (url.pathname === current.pathname && url.search === current.search && url.hash) {
        // The browser scrolls to a heading of this note; a heading it does not have leaves the reader at the top.
        if (!anchorTarget(url.hash)) scrollToTop();
        return;
      }
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
    // Showing or hiding the navigation can rewrap the article; the same text stays at the top.
    let restoreReadingPosition: (() => void) | null = null;
    const onNavigationWillChange = () => {
      restoreReadingPosition = article && scrollContainer ? keepBookReadingPosition(article, scrollContainer) : null;
    };
    const onNavigationChanged = () => {
      const restore = restoreReadingPosition;
      restoreReadingPosition = null;
      // After every listener of this event, so the navigation has already changed.
      if (restore) queueMicrotask(restore);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    window.addEventListener(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT, onNavigationWillChange);
    window.addEventListener(NAVIGATION_VISIBILITY_EVENT, onNavigationChanged);
    scrollContainer?.addEventListener("scroll", saveScroll, { passive: true });
    window.addEventListener("scroll", saveScroll, { passive: true });
    onCleanup(() => {
      mounted = false;
      pending?.settled?.();
      pending = undefined;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      window.removeEventListener(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT, onNavigationWillChange);
      window.removeEventListener(NAVIGATION_VISIBILITY_EVENT, onNavigationChanged);
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
