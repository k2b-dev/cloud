import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { createMemo, For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type PaginationProps = {
  currentPage: number;
  totalPages: number;
  baseUrl: string;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
};

type PaginationLinkProps = {
  href: string;
  label: string;
  rel?: "prev" | "next";
  class?: string;
  onNavigate?: PaginationProps["onNavigate"];
  children: JSX.Element;
};

const PaginationLink = (props: PaginationLinkProps) =>
  props.onNavigate ? (
    <Link
      href={props.href}
      rel={props.rel}
      scroll="top"
      onNavigate={props.onNavigate}
      class={`k2b-pagination__page ${props.class ?? ""}`}
      aria-label={props.label}
    >
      {props.children}
    </Link>
  ) : (
    <a href={props.href} rel={props.rel} class={`k2b-pagination__page ${props.class ?? ""}`} aria-label={props.label}>
      {props.children}
    </a>
  );

/** Link-based pagination with directional navigation and compact mobile disclosure. */
export const Pagination = (props: PaginationProps): JSX.Element => {
  const messages = useUiMessages();
  const totalPages = createMemo(() => Math.max(1, Math.floor(Number.isFinite(props.totalPages) ? props.totalPages : 1)));
  const currentPage = createMemo(() =>
    Math.min(totalPages(), Math.max(1, Math.floor(Number.isFinite(props.currentPage) ? props.currentPage : 1))),
  );
  const href = (page: number) => `${props.baseUrl}${page}`;
  const visiblePages = createMemo(() =>
    [...new Set([1, currentPage() - 1, currentPage(), currentPage() + 1, totalPages()])]
      .filter((page) => page >= 1 && page <= totalPages())
      .sort((left, right) => left - right),
  );

  return (
    <Show when={totalPages() > 1}>
      <nav class="k2b-pagination" aria-label={messages().pagination}>
        <span class="k2b-sr-only">
          {messages().pageOf({ page: currentPage(), total: totalPages() })}
        </span>
        <div class="k2b-pagination__pages">
          <Show when={currentPage() > 1}>
            <PaginationLink href={href(currentPage() - 1)} rel="prev" label={messages().previousPage} onNavigate={props.onNavigate}>
              <i class="ti ti-chevron-left" aria-hidden="true" />
            </PaginationLink>
          </Show>

          <For each={visiblePages()}>
            {(page, index) => {
              const previousPage = () => visiblePages()[index() - 1];
              const hasGap = () => previousPage() !== undefined && page - previousPage()! > 1;
              const isCurrent = () => page === currentPage();
              const mobileVisible = () => page === 1 || page === totalPages() || isCurrent();

              return (
                <>
                  <Show when={hasGap()}>
                    <span class="k2b-pagination__ellipsis" aria-hidden="true">
                      …
                    </span>
                  </Show>
                  <Show
                    when={isCurrent()}
                    fallback={
                      <PaginationLink
                        href={href(page)}
                        label={messages().goToPage({ page })}
                        class={mobileVisible() ? "" : "k2b-pagination__page--wide-only"}
                        onNavigate={props.onNavigate}
                      >
                        {page}
                      </PaginationLink>
                    }
                  >
                    <span class="k2b-pagination__page is-current" aria-current="page">
                      {page}
                    </span>
                  </Show>
                </>
              );
            }}
          </For>

          <Show when={currentPage() < totalPages()}>
            <PaginationLink href={href(currentPage() + 1)} rel="next" label={messages().nextPage} onNavigate={props.onNavigate}>
              <i class="ti ti-chevron-right" aria-hidden="true" />
            </PaginationLink>
          </Show>
        </div>
      </nav>
    </Show>
  );
};
