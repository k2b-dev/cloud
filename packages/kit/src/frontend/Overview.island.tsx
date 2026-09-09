import { createSignal, For, Show } from "solid-js";
import { AppOverview, Button, ButtonLink, TextInput, prompts, useLocale } from "@k2b/ui";
import { mutation } from "@k2b/stdlib/solid";
import type { Project } from "../contracts";
import { blankStarter, starter } from "../starter";
import { client, checked, displayError } from "./client";
import { messages } from "./messages";

export default function Overview(props: { items: Project[]; page: number; hasNext: boolean; query?: string }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const [query, setQuery] = createSignal(props.query ?? "");
  const create = mutation.create({
    mutation: async (input: { name: string; description: string; blank: boolean }) => {
      const { blank, ...metadata } = input;
      return checked(await client.projects.$post({ json: { ...(blank ? blankStarter : starter), ...metadata } }));
    },
    onSuccess: (app) => location.assign(`/app/kit/${app.id}/edit`),
    onError: (error) => prompts.error(displayError(error, locale())),
  });
  async function createApp(blank: boolean) {
    const input = await prompts.form({
      title: t().create,
      icon: "ti ti-code",
      confirmText: t().create,
      fields: {
        name: { type: "text", label: t().name, required: true },
        description: { type: "text", label: t().description, multiline: true },
      },
    });
    if (input) create.mutate({ name: String(input.name).trim(), description: String(input.description ?? "").trim(), blank });
  }
  const pageHref = (page: number) => `?${new URLSearchParams({ page: String(page), ...(props.query ? { q: props.query } : {}) })}`;
  const permission = (app: Project) =>
    app.permission === "admin" ? t().accessAdmin : app.permission === "write" ? t().accessWrite : t().accessRead;
  return (
    <AppOverview title="Kit" subtitle={t().overviewDescription} icon="ti ti-code">
      <AppOverview.Main
        title={t().all}
        toolbar={
          <form method="get" action="/app/kit" class="flex items-center gap-2">
            <TextInput
              type="search"
              name="q"
              value={query}
              onValueChange={setQuery}
              aria-label={t().search}
              placeholder={t().searchPlaceholder}
              maxlength={120}
            />
            <Button type="submit" variant="secondary" size="sm" aria-label={t().search}>
              <i class="ti ti-search" aria-hidden="true" />
            </Button>
          </form>
        }
      >
        <Show
          when={props.items.length}
          fallback={
            <AppOverview.EmptyState
              title={props.query ? t().noResults : t().empty}
              description={props.query ? undefined : t().starterHint}
              icon="ti ti-code"
            />
          }
        >
          <div class="grid gap-2 sm:grid-cols-2">
            <For each={props.items}>
              {(app) => {
                const card = () => (
                  <>
                    <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                      <i class={`ti ${app.permission === "read" ? "ti-lock" : "ti-code"} text-lg app-accent-text`} aria-hidden="true" />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-semibold text-primary truncate">{app.name}</span>
                      <span class="block text-xs text-dimmed line-clamp-2 mt-1">{app.description || t().noDescription}</span>
                      <span class="tag mt-2">{permission(app)}</span>
                    </span>
                    <i class="ti ti-chevron-right text-dimmed" aria-hidden="true" />
                  </>
                );
                return (
                  <Show
                    when={app.permission === "write" || app.permission === "admin"}
                    fallback={
                      <div class="paper flex min-h-32 items-center gap-4 p-4 opacity-60" aria-disabled="true">
                        {card()}
                      </div>
                    }
                  >
                    <a
                      href={`/app/kit/${app.id}`}
                      class="paper flex min-h-32 items-center gap-4 p-4 no-underline hover:paper-highlighted focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {card()}
                    </a>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={props.page > 1 || props.hasNext}>
          <nav class="flex gap-2 mt-4" aria-label={t().pagination}>
            <Show when={props.page > 1}>
              <ButtonLink href={pageHref(props.page - 1)} variant="secondary" size="sm">
                {t().previous}
              </ButtonLink>
            </Show>
            <Show when={props.hasNext}>
              <ButtonLink href={pageHref(props.page + 1)} variant="secondary" size="sm">
                {t().next}
              </ButtonLink>
            </Show>
          </nav>
        </Show>
      </AppOverview.Main>
      <AppOverview.Aside title={t().create} description={t().chooseStarter}>
        <div class="grid gap-2">
          <For each={[true, false]}>
            {(blank) => (
              <button
                type="button"
                class="paper flex items-start gap-3 p-4 text-left hover:paper-highlighted disabled:opacity-50"
                disabled={create.loading()}
                onClick={() => createApp(blank)}
              >
                <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center">
                  <i
                    class={`ti ${create.loading() ? "ti-loader-2 animate-spin" : blank ? "ti-plus" : "ti-table"} app-accent-text`}
                    aria-hidden="true"
                  />
                </span>
                <span>
                  <span class="block text-sm font-semibold">{blank ? t().blankApp : t().csvWorkshop}</span>
                  <span class="block text-xs text-dimmed mt-1">{blank ? t().blankAppDescription : t().csvAppDescription}</span>
                </span>
              </button>
            )}
          </For>
          <ButtonLink href="/app/kit/help" variant="ghost">
            <i class="ti ti-help" aria-hidden="true" />
            {t().help}
          </ButtonLink>
        </div>
      </AppOverview.Aside>
    </AppOverview>
  );
}
