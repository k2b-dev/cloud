import { For, Show } from "solid-js";
import { AppWorkspace, Button, ButtonLink, Placeholder, prompts, openSpotlightSearch, useLocale } from "@k2b/ui";
import { mutation } from "@k2b/stdlib/solid";
import type { Project } from "../contracts";
import { starter } from "../starter";
import { client, checked, displayError } from "./client";
import { messages } from "./messages";

export default function Overview(props: { items: Project[]; page: number; hasNext: boolean }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const create = mutation.create({
    mutation: async (input: { name: string; description: string }) =>
      checked(await client.projects.$post({ json: { ...starter, ...input } })),
    onSuccess: (app) => location.assign(`/app/kit/${app.id}/edit`),
    onError: (error) => prompts.error(displayError(error, locale())),
  });
  async function createApp() {
    const input = await prompts.form({
      title: t().create,
      icon: "ti ti-code",
      fields: {
        name: { type: "text", label: t().name, required: true },
        description: { type: "text", label: t().description, multiline: true },
      },
      confirmText: t().create,
    });
    if (input)
      create.mutate({
        name: String(input.name).trim(),
        description: String(input.description ?? "").trim(),
      });
  }
  async function search() {
    const selected = await openSpotlightSearch<{ href: string }>({
      title: t().search,
      icon: "ti ti-search",
      placeholder: t().searchPlaceholder,
      minQueryLength: 1,
      noResultsText: t().noResults,
      resolve: async ({ query, abortSignal }) => {
        const response = await checked(await client.projects.$get({ query: { q: query } }, { init: { signal: abortSignal } }));
        return response.items
          .filter((p) => p.permission === "write" || p.permission === "admin")
          .map((p) => ({
            label: p.name,
            desc: p.description,
            icon: "ti ti-code",
            value: { href: `/app/kit/${p.id}` },
          }));
      },
    });
    if (selected?.value) location.assign(selected.value.href);
  }
  return (
    <AppWorkspace class="kit-overview-workspace" resizable={false}>
      <h1 class="sr-only">Kit</h1>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="kit-overview-main">
          <header class="kit-overview-section">
            <div class="kit-overview-heading">
              <div>
                <h2>{t().all}</h2>
                <p>{t().overviewDescription}</p>
              </div>
              <Button variant="secondary" size="sm" aria-label={t().search} onClick={search}>
                <i class="ti ti-search" aria-hidden="true" />
                {t().search}
              </Button>
            </div>
            <nav class="kit-overview-apps" aria-label={t().all}>
              <For each={props.items}>
                {(app) => (
                  <Show
                    when={app.permission === "write" || app.permission === "admin"}
                    fallback={
                      <Button variant="secondary" size="sm" disabled title={t().accessRead}>
                        <i class="ti ti-lock" aria-hidden="true" />
                        {app.name}
                      </Button>
                    }
                  >
                    <ButtonLink href={`/app/kit/${app.id}`} variant="secondary" size="sm" title={app.description || app.name}>
                      <i class="ti ti-code app-accent-text" aria-hidden="true" />
                      <span class="truncate">{app.name}</span>
                    </ButtonLink>
                  </Show>
                )}
              </For>
              <Button variant="secondary" size="sm" aria-label={t().create} loading={create.loading()} onClick={createApp}>
                <i class="ti ti-plus app-accent-text" aria-hidden="true" />
                {t().create}
              </Button>
            </nav>
            <Show when={!props.items.length}>
              <Placeholder state="empty" title={t().empty} description={t().starterHint} icon="ti ti-code" />
            </Show>
            <Show when={props.page > 1 || props.hasNext}>
              <div class="kit-overview-apps">
                <Show when={props.page > 1}>
                  <ButtonLink href={`?page=${props.page - 1}`} variant="secondary" size="sm">
                    {t().previous}
                  </ButtonLink>
                </Show>
                <Show when={props.hasNext}>
                  <ButtonLink href={`?page=${props.page + 1}`} variant="secondary" size="sm">
                    {t().next}
                  </ButtonLink>
                </Show>
              </div>
            </Show>
          </header>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
