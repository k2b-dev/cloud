import { AppAccessEditor } from "@k2b/cloud/access/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, Input, type NavProps, Notice, Pane, StatusRow, Table, Tabs, Text, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { adminToasts } from "../_area/toasts";
import AddApp from "./AddApp";
import { AppOverview, ErrorsView, EventsView, RoutesView, RuntimeView, StatusChip, statusLabel } from "./app-views";
import Domains from "./Domains";
import DomainsAdd from "./DomainsAdd";
import { appsFormat } from "./format";
import { hintShort } from "./hints";
import Keys from "./Keys";
import KeysCreate from "./KeysCreate";
import { type AppEntry, type AppView, appsHref, countStatuses, hasProblem, matchesSearch, routeSummary } from "./model";
import { appsPageMessages } from "./page-messages";
import type { AppsViewData } from "./view-data";

const VIEWS: AppView[] = ["access", "keys", "domains", "events", "routes", "runtime", "errors"];

/**
 * Apps on v2: the registered apps with search and the "Problems" view, and the open app beside them as a record whose
 * tabs are its overview and its views. Search, view, open app and open tab all live in the address.
 */
export default function AppsScreen(props: { nav: NavProps; data: AppsViewData }) {
  const locale = useLocale();
  const t = () => appsPageMessages.resolve([locale()]).t;
  const toast = useToast();
  const n = () => adminToasts.resolve([locale()]).t;
  const f = createMemo(() => appsFormat({ ...props.data.dateConfig, locale: locale() }, props.data.now));
  const query = () => props.data.query;
  const list = () => query().list;
  const app = () => props.data.app;
  const detail = () => props.data.detail;
  const accessDetail = () => {
    const current = detail();
    return current?.view === "access" ? current : undefined;
  };
  const keysDetail = () => {
    const current = detail();
    return current?.view === "keys" ? current : undefined;
  };
  const domainsDetail = () => {
    const current = detail();
    return current?.view === "domains" ? current : undefined;
  };
  const routesDetail = () => {
    const current = detail();
    return current?.view === "routes" ? current : undefined;
  };
  const runtimeDetail = () => {
    const current = detail();
    return current?.view === "runtime" ? current : undefined;
  };
  const errorsDetail = () => {
    const current = detail();
    return current?.view === "errors" ? current : undefined;
  };
  const apps = () => (props.data.list.state === "ok" ? props.data.list.apps : []);
  const shown = () => apps().filter((entry) => (!list().problems || hasProblem(entry)) && matchesSearch(entry, list().q, locale()));
  const problemCount = () => apps().filter(hasProblem).length;
  const ctx = () => ({ t: t(), f: f(), locale: locale(), list: list() });
  const [redelivering, setRedelivering] = createSignal<string | null>(null);
  const redeliver = async (id: string) => {
    setRedelivering(id);
    const response = await apiClient["app-events"].deliveries[":id"].redeliver.$post({ param: { id } }).catch(() => null);
    setRedelivering(null);
    if (response?.ok) return navigateTo(appsHref({ app: app()?.entry.id, view: "events", list: list() }));
    toast(response?.status === 409 ? n().notRedeliverable : n().notQueued, { status: "bad" });
  };
  const search = (value: string) => navigateTo(appsHref({ app: query().app, view: query().view, list: { ...list(), q: value.trim() } }));
  const viewLabel = (view: AppView | null) =>
    view === null
      ? t().overview
      : (
          {
            access: t().access,
            keys: t().keys,
            domains: t().domains,
            events: t().events,
            routes: t().routes,
            runtime: t().runtime,
            errors: t().errors,
          } as const
        )[view];
  const views = (): AppView[] =>
    VIEWS.filter((view) => (view === "domains" ? app()?.domains !== null : view === "keys" ? app()?.keysSupported : true));
  const routesLine = (entry: AppEntry) => {
    const routes = routeSummary(entry.routes);
    return entry.neverStarted
      ? entry.firstKnownAt
        ? t().addedOn({ date: f().date(entry.firstKnownAt) })
        : t().statusIdle
      : entry.routes.length
        ? `${routes.shown}${routes.more ? ` +${routes.more}` : ""}`
        : t().noRoutes;
  };
  const problemLine = (entry: AppEntry) => {
    const first = entry.hints[0];
    return first
      ? `${hintShort(t(), f(), first)}${entry.hints.length > 1 ? ` · ${t().moreHints({ count: entry.hints.length - 1 })}` : ""}`
      : "–";
  };
  const known = () => apps().map((entry) => ({ id: entry.id, name: entry.name }));

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={520}
      detailEmpty={{ icon: "apps", text: t().noneOpen }}
      head={
        <Bar
          start={
            <Tabs
              label={t().apps}
              items={[
                {
                  label: t().allApps,
                  count: apps().length,
                  href: appsHref({ app: query().app, list: { ...list(), problems: false } }),
                  current: !list().problems,
                },
                {
                  label: t().problemsTab,
                  count: problemCount(),
                  href: appsHref({ app: query().app, list: { ...list(), problems: true } }),
                  current: list().problems,
                },
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().search}
                placeholder={t().search}
                value={list().q}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              {/* The add flow is still the v1 dialog; it moves to v2 with the keys. */}
              <AddApp known={known()} list={list()} />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().apps}
          width={{ min: 420, default: 620 }}
          scrollKey="admin-apps"
          status={
            <StatusRow lead={props.data.list.state === "ok" ? t().summary({ total: apps().length, ...countStatuses(apps()) }) : t().apps} />
          }
        >
          <Show when={query().moved}>
            {(moved) => <Notice tone="note">{moved() === "gateway" ? t().movedGateway : t().movedCredentials}</Notice>}
          </Show>
          <Show
            when={props.data.list.state === "ok" && props.data.list}
            fallback={<Failed text={t().listFailed} onRetry={() => navigateTo(appsHref({ list: list() }))} />}
          >
            {(ok) => (
              <>
                <Show when={ok().issues.length > 0}>
                  <Notice
                    tone="bad"
                    title={t().rejected({ count: ok().issues.length })}
                    actions={ok().logsHref ? [{ label: t().showLogs, href: ok().logsHref ?? undefined }] : undefined}
                  >
                    {`${ok()
                      .issues.map((issue) => `${issue.key} – ${issue.reason}`)
                      .join(" · ")}. ${t().rejectedHint}`}
                  </Notice>
                </Show>
                <Table
                  label={t().apps}
                  rows={shown()}
                  rowKey={(entry) => entry.id}
                  current={app()?.entry.id}
                  open={(entry) => ({ href: appsHref({ app: entry.id, list: list() }) })}
                  empty={
                    apps().length === 0
                      ? { icon: "apps", text: t().empty }
                      : { icon: "filter-off", text: t().noMatch, action: { label: t().showAllApps, href: appsHref({ app: query().app }) } }
                  }
                  phone={(entry) => ({
                    lines: [entry.name, `${statusLabel(t(), entry.status)} · ${entry.hints[0] ? problemLine(entry) : routesLine(entry)}`],
                  })}
                  columns={[
                    {
                      title: t().columnApp,
                      width: { min: 160, default: 200 },
                      cell: (entry) => ({ lines: [entry.name, routesLine(entry)] }),
                    },
                    {
                      title: t().columnStatus,
                      width: { min: 110, default: 120 },
                      cell: (entry) => <StatusChip t={t()} status={entry.status} />,
                    },
                    { title: t().columnProblem, drop: true, cell: problemLine },
                  ]}
                />
                <Show when={ok().unchecked > 0}>
                  <Text type="meta" muted>
                    {t().unchecked({ count: ok().unchecked })}
                  </Text>
                </Show>
              </>
            )}
          </Show>
        </Pane>
        {app() ? (
          <Pane
            detail
            label={app()!.entry.name}
            back={{ label: t().apps, href: appsHref({ list: list() }) }}
            head={
              <Bar
                start={<Text type="body">{app()!.entry.name}</Text>}
                end={
                  <>
                    <Show when={keysDetail()}>
                      {(keys) => (
                        <KeysCreate
                          app={keys().keys.app}
                          active={(keys().keys.initialKeys ?? []).filter((key) => key.status === "active").length}
                          disabledAccount={keys().keys.accountStatus === "disabled"}
                          neverStarted={keys().keys.neverStarted}
                        />
                      )}
                    </Show>
                    <Show when={domainsDetail()}>
                      {(domains) => <DomainsAdd app={domains().domains.app} initial={domains().domains.initial ?? []} />}
                    </Show>
                    <Button variant="ghost" icon="x" label={t().closeDetail} href={appsHref({ list: list() })} />
                  </>
                }
              />
            }
            status={
              <Tabs
                label={app()!.entry.name}
                items={[
                  { label: viewLabel(null), href: appsHref({ app: app()!.entry.id, list: list() }), current: !detail() },
                  ...views().map((view) => ({
                    label: viewLabel(view),
                    href: appsHref({ app: app()!.entry.id, view, list: list() }),
                    current: detail()?.view === view,
                  })),
                ]}
              />
            }
          >
            <Switch fallback={<AppOverview {...ctx()} app={app()!} />}>
              <Match when={accessDetail()}>
                {(access) => (
                  <Show when={access().editor} fallback={<Text>{t().fixedRule({ rule: access().rule })}</Text>}>
                    {(editor) => (
                      <>
                        <Notice tone="note" icon="shield-check">
                          {t().accessAdmin}
                        </Notice>
                        <Show when={app()!.entry.hints.some((hint) => hint.kind === "accessUnmanaged")}>
                          <Notice tone="warn" icon="lock-exclamation" title={t().hintAccessUnmanagedLead}>
                            {t().hintAccessUnmanagedText}
                          </Notice>
                        </Show>
                        {/* k2b-ui gap: the access editor is not on v2 yet; the v1 editor stands in. */}
                        <AppAccessEditor {...editor()} />
                      </>
                    )}
                  </Show>
                )}
              </Match>
              <Match when={keysDetail()}>
                {/* The keys list is still the v1 island; it moves to v2 next. */}
                {(keys) => <Keys {...keys().keys} />}
              </Match>
              <Match when={domainsDetail()}>
                {/* The domains list is still the v1 island; it moves to v2 next. */}
                {(domains) => <Domains {...domains().domains} />}
              </Match>
              <Match when={detail()?.view === "events"}>
                <EventsView {...ctx()} app={app()!} redeliver={(id) => void redeliver(id)} busy={(id) => redelivering() === id} />
              </Match>
              <Match when={routesDetail()}>{(routes) => <RoutesView {...ctx()} detail={routes()} app={app()!} />}</Match>
              <Match when={runtimeDetail()}>{(runtime) => <RuntimeView {...ctx()} detail={runtime()} app={app()!} />}</Match>
              <Match when={errorsDetail()}>{(errors) => <ErrorsView {...ctx()} detail={errors()} app={app()!} />}</Match>
            </Switch>
          </Pane>
        ) : undefined}
      </Pane.Split>
    </AdminWorkspace>
  );
}
