import type { AiProject } from "@k2b/cloud/ai";
import { query } from "@k2b/stdlib/solid";
import { Button, IconButton, InlineGuidance, NoticeCard, prompts, ScrollArea, TextInput } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { AssistantContextEmpty, AssistantContextRow, AssistantContextRows, AssistantContextSection } from "./AssistantContextContent";
import { useAssistantText } from "./ui-copy";

export type ProjectLinkPage = {
  items: { id: string; title: string; icon: string; canManage: boolean; description?: string }[];
  page: number;
  hasNext: boolean;
};
type Props = {
  icon: string;
  project: AiProject;
  initialPage: ProjectLinkPage;
  title: string;
  addLabel: string;
  searchLabel: string;
  notice: string;
  emptyLabel: string;
  noResultsLabel: string;
  load: (page: number, search: string, available: boolean, signal: AbortSignal) => Promise<ProjectLinkPage>;
  change: (id: string, linked: boolean) => Promise<unknown>;
};

function ProjectLinkPicker(props: Props & { choose: (id: string) => void }) {
  const text = useAssistantText();
  const [search, setSearch] = createSignal("");
  const apps = query.createInfinite<string, ProjectLinkPage, number>({
    source: search,
    loadPage: (search, { cursor, abortSignal }) => props.load(cursor ?? 1, search, true, abortSignal),
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
  });
  return (
    <div class="flex min-h-0 flex-col gap-3">
      <NoticeCard tone="info" title={text("Access for project members")} detail={props.notice} />
      <TextInput aria-label={props.searchLabel} placeholder={props.searchLabel} value={search()} onValueChange={setSearch} />
      <ScrollArea class="max-h-80">
        <div class="flex flex-col gap-1">
          <Show when={apps.error()}>
            <InlineGuidance tone="danger">
              {text("Could not load linked resources.")}
              <Button size="sm" variant="ghost" onClick={() => void apps.refresh()}>
                {text("Retry")}
              </Button>
            </InlineGuidance>
          </Show>
          <Show when={apps.loading()}>
            <InlineGuidance loading>{text("Loading…")}</InlineGuidance>
          </Show>
          <Show when={!apps.loading() && !apps.error()}>
            <For
              each={apps.pages().flatMap((page) => page.items)}
              fallback={<AssistantContextEmpty>{props.noResultsLabel}</AssistantContextEmpty>}
            >
              {(app) => (
                <Button wrap variant="ghost" class="w-full assistant-project-link-choice" onClick={() => props.choose(app.id)}>
                  <i class={app.icon || "ti ti-app-window"} aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-left">{app.title}</span>
                  <i class="ti ti-plus" aria-hidden="true" />
                </Button>
              )}
            </For>
            <Show when={apps.hasMore()}>
              <Button size="sm" variant="ghost" disabled={apps.loadingMore()} onClick={() => void apps.loadMore()}>
                {text("Show more")}
              </Button>
            </Show>
          </Show>
        </div>
      </ScrollArea>
    </div>
  );
}

export function AssistantProjectLinks(props: Props) {
  const text = useAssistantText();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const apps = query.createInfinite<string, ProjectLinkPage, number>({
    source: () => props.project.id,
    initial: { source: props.project.id, pages: [props.initialPage] },
    loadPage: (_id, { cursor, abortSignal }) => props.load(cursor ?? 1, "", false, abortSignal),
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
  });
  const items = createMemo(() => apps.pages().flatMap((page) => page.items));
  const [busy, setBusy] = createSignal(false);
  const changeLink = async (id?: string) => {
    if (busy()) return;
    setBusy(true);
    try {
      const selected = id
        ? undefined
        : await prompts.dialog<string>((close) => <ProjectLinkPicker {...props} choose={close} />, {
            title: props.addLabel,
            icon: props.icon,
            size: "medium",
            signal: lifetime.signal,
          });
      const appId = id ?? selected;
      if (!appId) return;
      await props.change(appId, !id);
      await apps.refresh();
    } catch (failure) {
      if (!lifetime.signal.aborted)
        await prompts.error(failure instanceof Error ? failure.message : text("Could not update Project links."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AssistantContextSection
      title={props.title}
      action={
        <Show when={props.project.permission === "admin"}>
          <IconButton size="xs" label={props.addLabel} disabled={busy()} onClick={() => void changeLink()}>
            <i class="ti ti-plus" aria-hidden="true" />
          </IconButton>
        </Show>
      }
    >
      <Show when={apps.error()}>
        <InlineGuidance tone="danger">
          {text("Could not load linked resources.")}
          <Button size="sm" variant="ghost" onClick={() => void apps.refresh()}>
            {text("Retry")}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={apps.loading()}>
        <InlineGuidance loading>{text("Loading…")}</InlineGuidance>
      </Show>
      <Show when={!apps.loading() && !apps.error() && !items().length}>
        <AssistantContextEmpty>{props.emptyLabel}</AssistantContextEmpty>
      </Show>
      <AssistantContextRows>
        <For each={items()}>
          {(app) => (
            <AssistantContextRow
              icon={app.icon || "ti ti-app-window"}
              title={app.title}
              description={app.description}
              trailing={
                <Show when={props.project.permission === "admin" && app.canManage}>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label={`${text("Unlink")} · ${app.title}`}
                    disabled={busy()}
                    onClick={() => void changeLink(app.id)}
                  >
                    <i class="ti ti-unlink" aria-hidden="true" />
                  </IconButton>
                </Show>
              }
            />
          )}
        </For>
        <Show when={apps.hasMore()}>
          <Button size="sm" variant="ghost" disabled={apps.loadingMore()} onClick={() => void apps.loadMore()}>
            {text("Show more")}
          </Button>
        </Show>
      </AssistantContextRows>
    </AssistantContextSection>
  );
}
