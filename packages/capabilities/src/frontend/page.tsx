import { AppOverview, ButtonLink, LinkCard } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { For, Show } from "solid-js";
import { loadCapabilityApps } from "../catalog";
import { ssr } from "../config";
import { capabilityHref } from "../routes";
import CapabilitySearchButton, { type CapabilitySearchEntry } from "./CapabilitySearchButton.island";
import { capabilityUiMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = capabilityUiMessages.resolve([getLocale(c)]);
  const catalog = await loadCapabilityApps(new URL(c.req.url), getLocale(c));
  const searchEntries: CapabilitySearchEntry[] = catalog.apps.map((app) => ({
    href: capabilityHref({ appId: app.id }),
    label: app.name,
    description: app.description,
    icon: app.icon || "ti ti-apps",
  }));
  c.get("page").title = t.capabilities;

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.capabilities }]}>
      <div class="k2b-ui min-w-0 flex-1">
        <AppOverview title={t.capabilities} subtitle={t.overview} icon="ti ti-api-app">
          <AppOverview.Main
            title={t.apps}
            description={t.appsOnPage({ count: catalog.apps.length })}
            toolbar={<CapabilitySearchButton entries={searchEntries} registerShortcut />}
          >
            <Show
              when={catalog.apps.length > 0}
              fallback={<AppOverview.EmptyState title={t.noLive} description={t.noLiveDescription} icon="ti ti-api-app" />}
            >
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <For each={catalog.apps}>
                  {(app) => (
                    <LinkCard
                      href={capabilityHref({ appId: app.id })}
                      title={app.name}
                      description={app.description}
                      icon={app.icon || "ti ti-apps"}
                      color="violet"
                    />
                  )}
                </For>
              </div>
              <Show when={catalog.cursor || catalog.nextCursor}>
                <nav class="mt-4 flex items-center gap-2" aria-label={t.appPages}>
                  <Show when={catalog.cursor}>
                    <ButtonLink variant="secondary" size="sm" href={capabilityHref({})}>
                      <i class="ti ti-chevrons-left" aria-hidden="true" /> {t.firstPage}
                    </ButtonLink>
                  </Show>
                  <Show when={catalog.nextCursor}>
                    {(cursor) => (
                      <ButtonLink variant="secondary" size="sm" href={capabilityHref({ cursor: cursor() })}>
                        {t.nextPage} <i class="ti ti-chevron-right" aria-hidden="true" />
                      </ButtonLink>
                    )}
                  </Show>
                </nav>
              </Show>
            </Show>
          </AppOverview.Main>
          <AppOverview.Aside title={t.reference} description={t.referenceDescription}>
            <LinkCard href="/app/api-docs" title={t.apiDocs} description={t.apiDocsDescription} icon="ti ti-book-2" color="blue" />
          </AppOverview.Aside>
        </AppOverview>
      </div>
    </Layout>
  );
});
