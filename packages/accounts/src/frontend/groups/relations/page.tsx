import type { GroupRelations } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ButtonLink, NoticeCard, Placeholder } from "@k2b/ui";
import { Show } from "solid-js";
import { ssr } from "../../../config";
import { toAccountsActor } from "../../../shared/actor";
import AccountsWorkspace from "../../AccountsWorkspace";
import { accountsMessages } from "../../messages";
import GroupsViewTabs from "../GroupsViewTabs";
import NewGroup from "../NewGroup.island";
import RelationDetails from "./RelationDetails";
import RelationLevels from "./RelationLevels";
import RelationsControls from "./RelationsControls.island";
import RelationsTree from "./RelationsTree.island";
import { relationsMessages } from "./relations-messages";
import { parseRelationsUrl, relationsHref } from "./relations-view";

/** Administrators: which groups contain which, in levels around one group or as a tree. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const accountsText = accountsMessages.resolve([locale]).t;
  const { t } = relationsMessages.resolve([locale]);
  const sessionUser = expectUserBackedActor(c);
  const state = parseRelationsUrl((name) => c.req.query(name));
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const linuxEnabled = (await linuxIdentities.configuration(sessionUser)).enabled;
  const pendingRequests = await accountsService.accountRequest.countPending();

  // Stays null when the read fails; the page then offers to try again.
  let relations: GroupRelations | null = null;
  try {
    const result = await accountsService.group.relations({
      actor: toAccountsActor(sessionUser),
      focus: state.focus,
      selected: state.sel,
      depth: state.depth,
      managers: state.managers,
      view: state.view,
      expand: state.expand,
      signal: c.req.raw.signal,
    });
    // A deleted or personal group in an old link: start again from the default focus.
    if (!result.ok && result.error.status === 404)
      return c.redirect(relationsHref({ ...state, focus: undefined, sel: undefined, expand: [] }));
    if (result.ok) relations = result.data;
  } catch {
    relations = null;
  }

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[
        { title: accountsText.start, href: "/" },
        { title: accountsText.accounts, href: "/app/accounts" },
        { title: accountsText.groups, href: "/app/accounts/groups" },
        { title: t.relations },
      ]}
    >
      <AccountsWorkspace active="groups" isAdmin={true} pendingRequests={pendingRequests} scrollPreserveKey="accounts-group-relations">
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="min-w-0 flex-1 text-base font-semibold text-primary" style="view-transition-name: accounts-groups-title">
              {accountsText.groups}
            </h1>
            <NewGroup freeIpaEnabled={freeIpaEnabled} linuxEnabled={linuxEnabled} />
          </div>
          <GroupsViewTabs current="relations" locale={locale} />

          <Show
            when={relations}
            fallback={
              <Placeholder
                surface="paper"
                state="error"
                icon="ti ti-alert-triangle"
                title={t.errorTitle}
                description={t.errorText}
                action={
                  <div class="flex flex-wrap justify-center gap-2">
                    <ButtonLink size="sm" variant="secondary" href={relationsHref(state)}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {t.retry}
                    </ButtonLink>
                    <ButtonLink size="sm" variant="secondary" href="/app/accounts/groups">
                      {t.toList}
                    </ButtonLink>
                  </div>
                }
              />
            }
          >
            {(current) => (
              <Show
                when={current().focus}
                fallback={
                  <Placeholder
                    surface="paper"
                    icon="ti ti-hierarchy-3"
                    title={t.emptyTitle}
                    description={t.emptyText}
                    action={
                      <ButtonLink size="sm" variant="secondary" href="/app/accounts/groups">
                        {t.toList}
                      </ButtonLink>
                    }
                  />
                }
              >
                <RelationsControls
                  state={state}
                  groupCount={current().groupCount}
                  cycleCount={current().cycles.count}
                  firstCycleGroup={current().cycles.first}
                  cyclesComplete={current().cyclesComplete}
                />
                <div class="flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-dimmed" aria-hidden="true">
                  <span class="inline-flex items-center gap-1">
                    <i class="inline-block w-6 border-t-2 border-[var(--ui-border-strong)]" />
                    {t.legendContains}
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <i class="inline-block w-6 border-t-2 border-dashed border-[var(--k2b-warning-text)]" />
                    {t.legendCycle}
                  </span>
                  <Show when={state.view === "graph"}>
                    <span>{t.legendShown}</span>
                  </Show>
                </div>
                <Show when={current().truncated || !current().managerCyclesComplete}>
                  <NoticeCard tone="warning" icon={true}>
                    {t.truncated}
                  </NoticeCard>
                </Show>
                <Show when={state.view === "graph"} fallback={<RelationsTree relations={current()} state={state} />}>
                  <div class="flex flex-col gap-3 md:flex-row">
                    <div class="min-h-[24rem] min-w-0 flex-1 overflow-auto rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)]">
                      <RelationLevels relations={current()} state={state} t={t} />
                    </div>
                    <aside class="w-full shrink-0 md:w-[17.5rem]" aria-label={t.details}>
                      <RelationDetails
                        relations={current()}
                        t={t}
                        pick={(id, name) => (
                          <a
                            href={relationsHref(state, { sel: id })}
                            class="-ml-1.5 block max-w-full truncate rounded-[var(--ui-radius-control)] px-1.5 py-0.5 text-[var(--k2b-action)] hover:bg-[var(--ui-hover)] focus-visible:outline-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                          >
                            {name}
                          </a>
                        )}
                        focusHref={
                          current().selected && current().selected!.id !== current().focus
                            ? relationsHref(state, { focus: current().selected!.id, sel: undefined, expand: [] })
                            : undefined
                        }
                      />
                    </aside>
                  </div>
                </Show>
              </Show>
            )}
          </Show>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
