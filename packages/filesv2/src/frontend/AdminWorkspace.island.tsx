import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import {
  Button,
  ButtonLink,
  DataTable,
  FilterChip,
  Format,
  IconButton,
  InlineGuidance,
  NoticeCard,
  Placeholder,
  prompts,
  Select,
  SettingsPage,
  SettingsSection,
  StatCell,
  StatGrid,
  StatusBadge,
  Tabs,
  TextInput,
} from "@k2b/ui";
import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema, InventoryStateSchema } from "../contracts";
import AdminBrowser from "./AdminBrowser";
import AdminIssue from "./AdminIssue";
import AdminShares from "./AdminShares";
import ArchiveTable from "./ArchiveTable";
import { createAdminActions } from "./admin-actions";
import { type AdminLocation, type AdminSnapshot, type AdminView, adminHref, parseAdminLocation } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import Inventory from "./Inventory";
import { useFilesMessages } from "./messages";
import Settings from "./Settings";
import { createWorkspaceState } from "./workspace-state";

export default function AdminWorkspace(props: { initial: AdminSnapshot }) {
  const a = useAdminMessages();
  const t = useFilesMessages();
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const read = async <T,>(response: { ok: boolean; json: () => Promise<T> }): Promise<T> => {
    if (response.ok) return response.json();
    const parsed = ErrorSchema.safeParse(await response.json());
    throw new Error(parsed.success && parsed.data.code !== "unavailable" ? parsed.data.message : a().connectionHint);
  };
  const workspace = createWorkspaceState({
    initial: props.initial,
    load: async (source, signal) => {
      const location = parseAdminLocation(source);
      const result = await read(
        await apiClient.admin.$get(
          {
            query: {
              includeEntries: location.view === "directories" && !location.name && !location.archiveId ? "true" : "false",
              area: location.area,
              kind: location.kind,
              after: location.view === "directories" && !location.name ? location.after : undefined,
              q: location.q,
              status: location.status,
            },
          },
          { init: { signal } },
        ),
      );
      const snapshot: AdminSnapshot = { source, result, archives: null, browse: null };
      if (!result.issue && (location.name || location.archiveId))
        snapshot.browse = await read(
          await apiClient.admin.entries.$get(
            {
              query: {
                area: location.area,
                kind: location.kind,
                name: location.name,
                archiveId: location.archiveId,
                path: location.path,
                after: location.after,
              },
            },
            { init: { signal } },
          ),
        );
      else if (!result.issue && location.view === "archive")
        snapshot.archives = await read(
          await apiClient.admin.archives.$get(
            { query: { area: location.area, q: location.q, after: location.after } },
            { init: { signal } },
          ),
        );
      if (location.view === "shares") {
        snapshot.shares = await read(await apiClient.admin.shares.$get({ query: {} }, { init: { signal } }));
        snapshot.uploads = await read(await apiClient.admin.uploads.$get({ query: {} }, { init: { signal } }));
      }
      return snapshot;
    },
  });
  const snapshot = workspace.snapshot;
  const location = () => parseAdminLocation(snapshot().source);
  const result = () => snapshot().result;
  const refresh = () => workspace.navigate(snapshot().source);
  const actions = createAdminActions({ snapshot, location, refresh });
  const navigate = async (source: string, commit: () => void, pop = false) => {
    if (saving() || actions.busy() || confirming()) {
      if (pop) commitHistory(workspace.committedSource(), { replace: true, scroll: "manual", viewTransition: false });
      return;
    }
    if (dirty()) {
      setConfirming(true);
      const discard = await prompts.confirm(a().dirtyLeave, { title: a().settings });
      setConfirming(false);
      if (!discard) {
        if (pop) commitHistory(workspace.committedSource(), { replace: true, scroll: "manual", viewTransition: false });
        return;
      }
    }
    const previous = workspace.committedSource();
    await workspace.navigate(source, commit, () => {
      if (pop) commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false });
    });
  };
  const onNavigate = (event: LinkNavigateEvent) =>
    navigate(`${event.url.pathname}${event.url.search}`, () => {
      if (event.replace || `${event.url.pathname}${event.url.search}` === `${window.location.pathname}${window.location.search}`)
        event.replaceWith(undefined, { scroll: "manual" });
      else event.push(undefined, { scroll: "manual" });
    });
  const change = (patch: Partial<AdminLocation>) => {
    const href = adminHref(location(), patch);
    return navigate(href, () =>
      commitHistory(href, {
        replace: href === `${window.location.pathname}${window.location.search}`,
        scroll: "manual",
        viewTransition: false,
      }),
    );
  };
  onMount(() =>
    onCleanup(
      listenPopState(({ url }) => {
        if (url.pathname !== "/admin/filesv2") return;
        const source = `${url.pathname}${url.search}`;
        if (source !== workspace.committedSource() || workspace.pending()) void navigate(source, () => {}, true);
      }),
    ),
  );
  const [search, setSearch] = createSignal(location().q ?? "");
  createEffect(() => setSearch(location().q ?? ""));
  const tabs = () => [
    { value: "overview" as const, label: a().overview, icon: "ti ti-chart-bar" },
    { value: "directories" as const, label: a().directories, icon: "ti ti-folders" },
    { value: "archive" as const, label: a().archives, icon: "ti ti-archive" },
    { value: "shares" as const, label: a().shares, icon: "ti ti-world-share" },
    { value: "settings" as const, label: a().settings, icon: "ti ti-settings" },
  ];
  const title = () => (location().view === "archive" ? a().archives : a()[location().view]);
  const description = () =>
    location().view === "shares" ? a().sharesDescription : location().view === "archive"
      ? a().archiveDescription
      : location().view === "directories"
        ? a().directoriesDescription
        : a().overviewDescription;
  const next = () =>
    snapshot().browse
      ? snapshot().browse!.next
      : snapshot().archives
        ? snapshot().archives!.next
        : location().view === "directories"
          ? result().next
          : null;
  const clearDetail = { name: undefined, archiveId: undefined, path: "", after: undefined };
  const pagination = () => (
    <div class="flex flex-wrap justify-between gap-2">
      <Show when={location().after}>
        <ButtonLink
          size="sm"
          variant="secondary"
          navigation="enhanced"
          onNavigate={onNavigate}
          href={adminHref(location(), { after: undefined })}
        >
          {t().first}
        </ButtonLink>
      </Show>
      <Show when={next()}>
        {(cursor) => (
          <ButtonLink
            size="sm"
            variant="secondary"
            navigation="enhanced"
            onNavigate={onNavigate}
            href={adminHref(location(), { after: cursor() })}
          >
            {t().next}
          </ButtonLink>
        )}
      </Show>
    </div>
  );
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="shrink-0 px-[var(--ui-space-shell)] pt-3">
        <Tabs<AdminView>
          value={() => location().view}
          onValueChange={(view) => void change({ ...clearDetail, view, q: undefined, status: undefined })}
          ariaLabel={t().admin}
          options={tabs()}
        />
      </div>
      <Show
        when={!workspace.pending()}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <Placeholder state="loading" variant="panel" description={a().loading} />
          </div>
        }
      >
        <Show
          when={!workspace.failure()}
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <Placeholder
                state="error"
                variant="panel"
                title={a().failed}
                description={workspace.failure()?.message}
                action={
                  <ButtonLink
                    size="sm"
                    href={workspace.failure()?.source ?? snapshot().source}
                    navigation="enhanced"
                    onNavigate={onNavigate}
                  >
                    {t().refresh}
                  </ButtonLink>
                }
              />
            </div>
          }
        >
          <Show
            when={location().view !== "settings"}
            fallback={
              <Settings
                configuration={result().configuration}
                availability={result().availability}
                onSaved={refresh}
                onDirtyChange={(value, busy) => {
                  setDirty(value);
                  setSaving(busy);
                }}
              />
            }
          >
            <SettingsPage
              title={title()}
              subtitle={description()}
              icon={location().view === "overview" ? "ti ti-chart-bar" : location().view === "archive" ? "ti ti-archive" : "ti ti-folders"}
              actions={
                <Show
                  when={location().view === "overview" && result().root}
                  fallback={
                    <ButtonLink size="sm" variant="secondary" href={snapshot().source} navigation="enhanced" onNavigate={onNavigate}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {t().refresh}
                    </ButtonLink>
                  }
                >
                  <Button size="sm" variant="secondary" disabled={actions.busy()} onClick={() => void actions.root("refresh")}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().refresh}
                  </Button>
                </Show>
              }
            >
              <Show when={location().view === "overview"}>
                <NoticeCard tone="info" title={a().modelTitle} detail={a().modelDetail} />
              </Show>
              <Show when={location().view !== "shares" && (location().view === "overview" || snapshot().browse || result().issue)}>
                <Select
                  label={a().area}
                  value={location().area}
                  onValueChange={(value) => {
                    if (value === "cloud" || value === "freeipa") void change({ ...clearDetail, area: value });
                  }}
                  options={[
                    { value: "cloud", label: t().cloud },
                    { value: "freeipa", label: t().freeipa },
                  ]}
                />
              </Show>
              <Show when={actions.error()}>
                {(error) => (
                  <InlineGuidance role="alert" tone="danger">
                    {error().message}
                  </InlineGuidance>
                )}
              </Show>
              <Show when={actions.notice()}>
                {(notice) => (
                  <InlineGuidance role="status" tone="success">
                    {notice()}
                  </InlineGuidance>
                )}
              </Show>
              <Show
                when={!result().issue || location().view === "shares"}
                fallback={
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={a().rootMissing}
                    description={<AdminIssue code={result().issue} />}
                    action={
                      <ButtonLink
                        size="sm"
                        href={adminHref(location(), { ...clearDetail, view: "settings" })}
                        navigation="enhanced"
                        onNavigate={onNavigate}
                      >
                        {a().settings}
                      </ButtonLink>
                    }
                  />
                }
              >
                <Switch>
                  <Match when={location().view === "shares"}><AdminShares shares={snapshot().shares ?? { items: [], next: null }} uploads={snapshot().uploads ?? { items: [], next: null }} /></Match>
                  <Match when={snapshot().browse}>
                    {(browse) => (
                      <>
                        <AdminBrowser
                          browse={browse()}
                          versioningEnabled={browse().versioningEnabled}
                          location={location()}
                          busy={actions.busy()}
                          onNavigate={onNavigate}
                          onDelete={(entry) => void actions.removeEntry(browse(), entry)}
                        />
                        {pagination()}
                      </>
                    )}
                  </Match>
                  <Match when={location().view === "overview"}>
                    <Show when={result().root}>
                      {(root) => (
                        <>
                          <NoticeCard
                            tone="info"
                            icon={location().area === "cloud" ? "ti ti-cloud" : "ti ti-server"}
                            title={location().area === "cloud" ? a().cloudPurpose : a().freeipaPurpose}
                            detail={location().area === "cloud" ? a().cloudExplanation : a().freeipaExplanation}
                          />
                          <StatGrid columns={3}>
                            <StatCell label={t().fileCount} value={<Format.Number value={root().files} fallback={t().unknown} />} />
                            <StatCell label={t().folderCount} value={<Format.Number value={root().directories} fallback={t().unknown} />} />
                            <StatCell label={t().storageBytes} value={<Format.Bytes value={root().bytes} fallback={t().unknown} />} />
                          </StatGrid>
                          <StatGrid columns={3}>
                            <StatCell label={a().available} value={<Format.Bytes value={root().available} fallback={t().unknown} />} />
                            <StatCell label={a().capacity} value={<Format.Bytes value={root().capacity} fallback={t().unknown} />} />
                            <StatCell label={a().transfers} value={<Format.Number value={root().activeUploads} fallback={t().unknown} />} />
                          </StatGrid>
                          <SettingsSection title={`${t().rootInformation}: ${root().name}`} subtitle={t().rootScope}>
                            <div class="flex flex-wrap items-center gap-3">
                              <StatusBadge tone="neutral" label={`${t().index}: ${root().indexEnabled ? t().on : t().off}`} />
                              <StatusBadge tone="neutral" label={`${t().history}: ${root().versioningEnabled ? t().on : t().off}`} />
                              <Button
                                size="sm"
                                variant="secondary"
                                class="ml-auto"
                                disabled={!root().indexEnabled || actions.busy()}
                                onClick={() => void actions.root("rebuild")}
                              >
                                {a().rebuild}
                              </Button>
                            </div>
                            <Show when={root().versioningEnabled}>
                              <dl class="mt-3 grid grid-cols-2 gap-3">
                                <div>
                                  <dt class="text-xs text-dimmed">{a().versions}</dt>
                                  <dd>
                                    <Format.Number value={root().versions} />
                                  </dd>
                                </div>
                                <div>
                                  <dt class="text-xs text-dimmed">{a().versionBytes}</dt>
                                  <dd>
                                    <Format.Bytes value={root().versionBytes} />
                                  </dd>
                                </div>
                              </dl>
                            </Show>
                          </SettingsSection>
                        </>
                      )}
                    </Show>
                  </Match>
                  <Match when={location().view === "directories" || location().view === "archive"}>
                    <Show when={location().view === "archive"}>
                      <NoticeCard tone="info" icon="ti ti-archive" title={a().archivePurpose} detail={a().archiveExplanation} />
                    </Show>
                    <DataTable.Panel>
                      <DataTable.Header title={title()} />
                      <DataTable.Controls>
                        <form
                          class="flex flex-wrap items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void change({ ...clearDetail, q: search().trim() || undefined });
                          }}
                        >
                          <Show when={location().view === "directories"}>
                            <FilterChip
                              label={location().status ? t()[location().status!] : a().filter}
                              icon="ti ti-filter"
                              value={[location().status ?? "all"]}
                              defaultValue={["all"]}
                              isActive={!!location().status}
                              onValueChange={(values) => {
                                const parsed = InventoryStateSchema.safeParse(values[0]);
                                void change({
                                  ...clearDetail,
                                  q: search().trim() || undefined,
                                  status: parsed.success ? parsed.data : undefined,
                                });
                              }}
                              options={[
                                {
                                  options: [
                                    { value: "all", label: a().all },
                                    ...InventoryStateSchema.options.map((value) => ({ value, label: t()[value] })),
                                  ],
                                },
                              ]}
                            />
                          </Show>
                          <FilterChip
                            label={`${a().area}: ${t()[location().area]}`}
                            icon={location().area === "cloud" ? "ti ti-cloud" : "ti ti-server"}
                            value={[location().area]}
                            defaultValue={["cloud"]}
                            isActive={false}
                            onValueChange={(values) => {
                              const area = values[0] ?? "cloud";
                              if (area === "cloud" || area === "freeipa")
                                void change({ ...clearDetail, q: search().trim() || undefined, area });
                            }}
                            options={[
                              {
                                options: [
                                  { value: "cloud", label: t().cloud },
                                  { value: "freeipa", label: t().freeipa },
                                ],
                              },
                            ]}
                          />
                          <Show when={location().view === "directories"}>
                            <FilterChip
                              label={`${a().kind}: ${location().kind === "users" ? t().users : t().groupPlural}`}
                              icon={location().kind === "users" ? "ti ti-user" : "ti ti-users"}
                              value={[location().kind]}
                              defaultValue={["users"]}
                              isActive={false}
                              onValueChange={(values) => {
                                const kind = values[0] ?? "users";
                                if (kind === "users" || kind === "groups")
                                  void change({ ...clearDetail, q: search().trim() || undefined, kind });
                              }}
                              options={[
                                {
                                  options: [
                                    { value: "users", label: t().users },
                                    { value: "groups", label: t().groupPlural },
                                  ],
                                },
                              ]}
                            />
                          </Show>
                          <div class="flex min-w-0 flex-[1_1_16rem] items-center gap-2">
                            <TextInput
                              type="search"
                              aria-label={a().search}
                              placeholder={a().search}
                              icon="ti ti-search"
                              activeIcon="ti ti-search"
                              class="min-w-0 flex-1"
                              value={search()}
                              onValueChange={setSearch}
                            />
                            <IconButton type="submit" variant="input" label={a().searchAction}>
                              <i class="ti ti-search" aria-hidden="true" />
                            </IconButton>
                          </div>
                        </form>
                      </DataTable.Controls>
                      <Show
                        when={location().view === "directories"}
                        fallback={
                          <ArchiveTable
                            items={snapshot().archives?.items ?? []}
                            location={location()}
                            busy={actions.busy()}
                            onNavigate={onNavigate}
                            onAction={(kind, row) => void actions.archive(kind, row)}
                          />
                        }
                      >
                        <Inventory
                          items={result().items}
                          location={location()}
                          busy={actions.busy()}
                          onNavigate={onNavigate}
                          onAction={(kind, row) => void actions.directory(kind, row)}
                        />
                      </Show>
                      <DataTable.Footer>{pagination()}</DataTable.Footer>
                    </DataTable.Panel>
                  </Match>
                </Switch>
              </Show>
            </SettingsPage>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
