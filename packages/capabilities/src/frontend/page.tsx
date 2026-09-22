import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { AppOverview, ButtonLink, LinkCard } from "@k2b/ui";
import { For, Show } from "solid-js";
import { loadCapabilityApps } from "../catalog";
import { ssr } from "../config";
import { capabilityHref } from "../routes";
import CapabilitySearchButton from "./CapabilitySearchButton.island";
import { capabilityUiMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = capabilityUiMessages.resolve([getLocale(c)]);
  const catalog = await loadCapabilityApps(new URL(c.req.url), getLocale(c));
  c.get("page").title = t.capabilities;

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.capabilities }]}>
      <div class="k2b-ui min-w-0 flex-1">
        <AppOverview
          title={t.capabilities}
          subtitle={t.overview}
          icon="ti ti-api-app"
          actions={
            <ButtonLink variant="secondary" href="/app/api-docs">
              <i class="ti ti-book-2" aria-hidden="true" /> {t.apiDocs}
            </ButtonLink>
          }
        >
          <AppOverview.Main
            title={t.apps}
            description={t.appsOnPage({ count: catalog.apps.length })}
            toolbar={<CapabilitySearchButton registerCommand />}
          >
            <Show
              when={catalog.apps.length > 0}
              fallback={<AppOverview.EmptyState title={t.noLive} description={t.noLiveDescription} icon="ti ti-api-app" />}
            >
              <AppOverview.Cards>
                <For each={catalog.apps}>
                  {(app) => (
                    <LinkCard
                      href={capabilityHref({ appId: app.id })}
                      title={app.name}
                      description={app.description}
                      icon={app.icon || "ti ti-apps"}
                      meta={t.capabilityCount({ count: app.capabilityCount })}
                    />
                  )}
                </For>
              </AppOverview.Cards>
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
        </AppOverview>
      </div>
    </Layout>
  );
});
