import { prompts, ScrollArea, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { platformMessages } from "./platform-messages";

export type GlobalSearchHelpApp = {
  appId: string;
  appName: string;
  appIcon: string;
  tags: string[];
  help?: string;
  tagHelp?: Array<{ tag: string; help: string }>;
};

type GlobalSearchHelpDialogProps = { apps: GlobalSearchHelpApp[] };

export default function GlobalSearchHelpDialog(props: GlobalSearchHelpDialogProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const apps = createMemo(() =>
    props.apps
      .filter((app) => app.tags.length > 0)
      .map((app) => ({
        ...app,
        help: app.help?.trim() || undefined,
        tags: [...new Set(app.tags.map((tag) => tag.toLowerCase()))].sort(),
        tagHelp: [...new Map((app.tagHelp ?? []).map((entry) => [entry.tag.trim().toLowerCase(), entry.help.trim()])).entries()]
          .filter(([tag, help]) => tag.length > 0 && help.length > 0)
          .map(([tag, help]) => ({ tag, help })),
      }))
      .sort((a, b) => a.appName.localeCompare(b.appName)),
  );

  return (
    <div class="flex max-h-[min(42rem,var(--ui-dialog-available-height))] min-h-0 flex-col gap-4 text-zinc-900 dark:text-zinc-100">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-dimmed">{t().searchTagsDescription({ tag: "#tag" })}</p>
        </div>
      </div>

      <ScrollArea class="min-h-0 flex-1 pr-1">
        <div class="flex flex-col gap-2">
          <For each={apps()}>
            {(app) => (
              <section class="rounded-lg ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-3 bg-zinc-50/50 dark:bg-zinc-900/35">
                <header class="flex items-center gap-2 text-sm">
                  <i class={app.appIcon} />
                  <span>{app.appName}</span>
                </header>
                <Show when={app.help}>
                  <p class="mt-1 text-xs text-dimmed">{app.help}</p>
                </Show>
                <Show
                  when={(app.tagHelp?.length ?? 0) > 0}
                  fallback={
                    <p class="mt-1 text-xs text-dimmed">
                      {t().tags}:{" "}
                      <For each={app.tags}>
                        {(tag, index) => (
                          <>
                            <code>#{tag}</code>
                            <Show when={index() < app.tags.length - 1}>, </Show>
                          </>
                        )}
                      </For>
                    </p>
                  }
                >
                  <div class="mt-2 space-y-1 text-xs">
                    <For each={app.tagHelp}>
                      {(entry) => (
                        <div class="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                          <code>#{entry.tag}</code>
                          <span class="text-dimmed">{entry.help}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
          <Show when={apps().length === 0}>
            <div class="rounded-lg ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-3 text-xs text-dimmed bg-zinc-50/50 dark:bg-zinc-900/35">
              {t().noAppSearchTags}
            </div>
          </Show>
        </div>
      </ScrollArea>
    </div>
  );
}

export const openGlobalSearchHelpDialog = (
  apps: GlobalSearchHelpApp[],
  locale = typeof document === "undefined" ? "en" : document.documentElement.lang || "en",
) => {
  const t = platformMessages.resolve([locale]).t;
  void prompts.dialog<void>(() => <GlobalSearchHelpDialog apps={apps} />, {
    title: t.searchTags,
    icon: "ti ti-help-circle",
    size: "large",
  });
};
