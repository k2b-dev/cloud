/**
 * Sidebar entry for tags — clicking opens a modal with the full tag
 * list (compact floating grid + live search). Each tag is a link to
 * `/app/notebooks/<id>/tags/<tag>`.
 *
 * Live-search uses `timed.debounce` from stdlib so we don't re-filter
 * on every keystroke. The list itself is fully client-side because the
 * tag-count is bounded — even a notebook with thousands of tags fits
 * in one fetch and a memo-based filter.
 */

import { timed } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Placeholder, prompts, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { buildTagPageUrl } from "../../../params";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { TagSummary } from "./types";
import { notebookWorkspaceMessages } from "../../messages";

type Variant = "sidebar" | "sidebar-mobile" | "icon";

type Props = {
  notebookId: string;
  tags: TagSummary[];
  variant: Variant;
  viewTransitionName?: string;
  presentationMode?: PresentationMode;
};

const TagsModal = (props: { notebookId: string; tags: TagSummary[]; presentationMode?: PresentationMode }) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  // Two signals: `query` is the live input (immediate UI feedback),
  // `debouncedQuery` is what drives the filter — updated 150ms after
  // typing pause so the memo doesn't churn on every keystroke.
  const [query, setQuery] = createSignal("");
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const { debouncedFn: setQueryDebounced } = timed.debounce((v: string) => setDebouncedQuery(v), 150);

  const filtered = createMemo(() => {
    const q = debouncedQuery().trim().toLowerCase();
    const list = props.tags;
    if (q.length === 0) return list;
    return list.filter((t) => t.tag.includes(q));
  });

  const onInput = (v: string) => {
    setQuery(v);
    setQueryDebounced(v);
  };

  return (
    <div class="flex min-w-[24rem] w-full max-w-full flex-col gap-2">
      <TextInput
        aria-label={t().searchTags}
        placeholder={t().searchTagsPlaceholder}
        autofocus
        value={query}
        onValueChange={onInput}
        icon="ti ti-search"
      />

      <Show
        when={filtered().length > 0}
        fallback={
          <Placeholder
            align="left"
            icon="ti ti-tags"
            class="py-2"
            description={props.tags.length === 0 ? t().noTags : t().noMatchingTags({ query: query() })}
          />
        }
      >
        {/* Compact floating grid — flex-wrap pills so many tags fit
              into the same modal without per-tag rows. Same visual as
              the read-mode pills + the editor pills. */}
        <ul class="flex flex-wrap gap-2 max-h-[60vh] overflow-y-auto content-start">
          <For each={filtered()}>
            {(t) => (
              <li>
                <a
                  href={buildTagPageUrl(props.notebookId, t.tag, props.presentationMode)}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 no-underline transition-colors"
                >
                  <i class="ti ti-hash text-sm" />
                  <span>{t.tag}</span>
                  <span class="text-emerald-500/80 dark:text-emerald-400/80 tabular-nums">{t.count}</span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};

const openTagsModal = (notebookId: string, tags: TagSummary[], locale: string, presentationMode?: PresentationMode) => {
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return prompts.dialog<void>(() => <TagsModal notebookId={notebookId} tags={tags} presentationMode={presentationMode} />, {
    title: t.tags,
    icon: "ti ti-hash",
  });
};

export default function TagsButton(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const tagCount = () => props.tags.length;
  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        label={t().tagCount({ count: tagCount() })}
        icon="ti ti-hash"
        onClick={() => void openTagsModal(props.notebookId, props.tags, locale(), props.presentationMode)}
        viewTransitionName={props.viewTransitionName}
      />
    );
  }

  if (props.variant === "sidebar-mobile") {
    return (
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-start"
        onClick={() => void openTagsModal(props.notebookId, props.tags, locale(), props.presentationMode)}
      >
        <i class="ti ti-hash" />
        {t().tags} ({tagCount()})
      </Button>
    );
  }
  return (
    <AppWorkspace.SidebarItem
      icon="ti ti-hash"
      meta={tagCount()}
      onClick={() => void openTagsModal(props.notebookId, props.tags, locale(), props.presentationMode)}
      title={t().tagCount({ count: tagCount() })}
    >
      {t().tags}
    </AppWorkspace.SidebarItem>
  );
}
