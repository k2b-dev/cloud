import { coreClient } from "@k2b/cloud/clients/core";
import type { serviceAccountCredentials } from "@k2b/cloud/services";
import { formatDateTime } from "@k2b/cloud/shared";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { credentialMessages } from "./messages";

type Listing = Awaited<ReturnType<typeof serviceAccountCredentials.listOverview>>;
type Entry = Listing["items"][number];
type Props = { apps: Array<{ id: string; name: string }>; initial: Listing };
const api = coreClient.admin.identity.workloads;

function CredentialDialog(props: {
  appId: string;
  apps: Props["apps"];
  entry?: Entry;
  close: () => void;
  onCreated: () => void;
  setDismissHandler: (handler: () => void) => void;
}) {
  const locale = useLocale();
  const t = () => credentialMessages.resolve([locale()]).t;
  const [selectedApp, setSelectedApp] = createSignal(props.appId);
  const [name, setName] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal("");
  const [created, setCreated] = createSignal<{ appId: string; token: string } | null>(null);
  const create = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const selected = selectedApp();
      const response = await api[":appId"].credentials.$post(
        {
          param: { appId: selected },
          json: { name: name().trim(), scopes: ["identity:invoke"], ...(expiresAt().trim() ? { expiresAt: expiresAt().trim() } : {}) },
        },
        { init: { signal: abortSignal } },
      );
      const result = await response.json();
      if (!response.ok || !("token" in result)) throw new Error("message" in result ? result.message : t().failed);
      return { appId: selected, token: result.token };
    },
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      props.onCreated();
    },
  });
  const revoke = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      if (!props.entry) return;
      const response = await api[":appId"].credentials[":credentialId"].$delete(
        { param: { appId: props.appId, credentialId: props.entry.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().failed);
    },
    onSuccess: () => {
      props.onCreated();
      props.close();
    },
  });
  onCleanup(() => {
    create.abort();
    revoke.abort();
  });
  const busy = () => create.loading() || revoke.loading();
  const close = () => {
    if (!busy()) props.close();
  };
  props.setDismissHandler(() => {
    if (!created()) close();
  });
  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy() && !created() && !props.entry && selectedApp() && name().trim()) void create.mutate(undefined);
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={created() ? t().once : props.entry ? t().revoke : t().create}
          subtitle={props.entry ? (props.apps.find((app) => app.id === props.appId)?.name ?? props.appId) : undefined}
          icon="ti ti-key"
          close={created() ? undefined : close}
        />
        <PanelDialog.Body>
          <Show
            when={created()}
            fallback={
              <Show
                when={props.entry}
                fallback={
                  <>
                    <Select
                      label={t().app}
                      value={selectedApp()}
                      options={props.apps.map((app) => ({ id: app.id, label: app.name }))}
                      disabled={busy()}
                      onValueChange={(value) => {
                        if (value) setSelectedApp(value);
                      }}
                    />
                    <TextInput
                      label={t().name}
                      icon="ti ti-tag"
                      value={name()}
                      onValueChange={setName}
                      disabled={busy()}
                      required
                      maxLength={120}
                    />
                    <TextInput
                      label={t().expires}
                      icon="ti ti-calendar"
                      value={expiresAt()}
                      onValueChange={setExpiresAt}
                      disabled={busy()}
                      placeholder="2027-01-01T00:00:00Z"
                    />
                  </>
                }
              >
                {(entry) => (
                  <>
                    <p class="text-sm font-medium text-primary">{entry().name}</p>
                    <p class="text-xs font-mono text-dimmed">{entry().tokenPrefix}</p>
                    <NoticeCard tone="warning" title={t().confirm} />
                  </>
                )}
              </Show>
            }
          >
            {(value) => (
              <>
                <TextInput multiline label="CLOUD_APP_CREDENTIAL" value={value().token} readOnly />
                <p class="text-xs text-dimmed">{t().hint}</p>
              </>
            )}
          </Show>
          <Show when={create.error() ?? revoke.error()}>
            {(error) => <NoticeCard tone="danger" title={t().failed} detail={error().message} />}
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show
            when={created()}
            fallback={
              <>
                <Button type="button" variant="secondary" size="sm" onClick={close} disabled={busy()}>
                  {t().cancel}
                </Button>
                <Show
                  when={props.entry}
                  fallback={
                    <Button type="submit" size="sm" disabled={busy() || !selectedApp() || !name().trim()}>
                      <i class="ti ti-plus" aria-hidden="true" />
                      {t().create}
                    </Button>
                  }
                >
                  <Button type="button" variant="danger" size="sm" disabled={busy()} onClick={() => void revoke.mutate(undefined)}>
                    {t().revoke}
                  </Button>
                </Show>
              </>
            }
          >
            <Button type="button" size="sm" onClick={close}>
              {t().dismiss}
            </Button>
          </Show>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
}

export default function Credentials(props: Props) {
  const locale = useLocale();
  const t = () => credentialMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal(1);
  const [revision, setRevision] = createSignal(0);
  const entries = query.create({
    source: () => ({ page: page(), revision: revision() }),
    load: async (source, { abortSignal }): Promise<Listing> => {
      if (source.page === 1 && source.revision === 0) return props.initial;
      const response = await api.credentials.$get(
        { query: { page: String(source.page), perPage: "20" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().failed);
      return response.json();
    },
  });
  const blocked = () => entries.loading() || entries.refreshing() || !!entries.error();
  const open = (entry?: Entry) => {
    const selected = entry?.owner.type === "resource" ? entry.owner.appId : (props.apps[0]?.id ?? "");
    if (!selected || blocked()) return;
    void dialogCore.open<void>(
      (close, context) => (
        <CredentialDialog
          appId={selected}
          apps={props.apps}
          entry={entry}
          close={() => close()}
          setDismissHandler={context.setDismissHandler}
          onCreated={() => setRevision((v) => v + 1)}
        />
      ),
      panelDialogOptions,
    );
  };
  const columns = (): DataTableColumn<Entry>[] => [
    { id: "name", header: t().name, value: (row) => row.name },
    { id: "app", header: t().app, value: (row) => (row.owner.type === "resource" ? row.owner.appId : "") },
    { id: "status", header: t().status, value: (row) => row.status },
    { id: "expires", header: t().expiresColumn, value: (row) => row.expiresAt },
    { id: "lastUsed", header: t().lastUsed, value: (row) => row.lastUsedAt },
    { id: "actions", header: <span class="sr-only">{t().actions}</span>, cellClass: "text-right whitespace-nowrap max-w-none" },
  ];
  const status = (entry: Entry) =>
    entry.status === "revoked" ? "revoked" : entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now() ? "expired" : "active";
  return (
    <section class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-primary">{t().title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t().description}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={!props.apps.length || blocked()} onClick={() => open()}>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().create}
        </Button>
      </div>
      <Show when={entries.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t().failed} detail={error().message}>
            <Button size="sm" onClick={() => void entries.refresh()} disabled={entries.refreshing()}>
              {t().retry}
            </Button>
          </NoticeCard>
        )}
      </Show>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" surface="paper" title={t().loading} />}>
        <DataTable
          rows={entries.data()?.items ?? []}
          columns={columns()}
          getRowId={(row) => row.id}
          hoverRows
          highlightColumns={false}
          class="paper overflow-x-auto"
          tableClass="w-full text-sm"
          empty={t().empty}
          renderCell={({ row, col }) => {
            if (col.id === "app") {
              const appId = row.owner.type === "resource" ? row.owner.appId : "";
              return <span class="text-xs text-secondary">{props.apps.find((app) => app.id === appId)?.name ?? appId}</span>;
            }
            if (col.id === "name")
              return (
                <div class="min-w-0">
                  <p class="truncate text-xs font-medium text-primary">{row.name}</p>
                  <p class="mt-0.5 font-mono text-[10px] text-dimmed">{row.tokenPrefix}</p>
                </div>
              );
            if (col.id === "status")
              return (
                <span
                  class={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${status(row) === "active" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-zinc-500/10 text-dimmed"}`}
                >
                  {t()[status(row)]}
                </span>
              );
            if (col.id === "expires")
              return (
                <span class="text-xs tabular-nums text-dimmed">
                  {row.expiresAt ? formatDateTime(row.expiresAt, { locale: locale() }) : t().never}
                </span>
              );
            if (col.id === "lastUsed")
              return (
                <span class="text-xs tabular-nums text-dimmed">
                  {row.lastUsedAt ? formatDateTime(row.lastUsedAt, { locale: locale() }) : "—"}
                </span>
              );
            if (col.id === "actions")
              return (
                <div class="flex justify-end">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={blocked() || row.status === "revoked"}
                    onClick={() => open(row)}
                  >
                    {t().revoke}
                  </Button>
                </div>
              );
            return "";
          }}
        />
        <Show when={(entries.data()?.total ?? 0) > 20}>
          <div class="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={page() <= 1 || blocked()} onClick={() => setPage((v) => v - 1)}>
              {t().previous}
            </Button>
            <Button variant="secondary" size="sm" disabled={!entries.data()?.hasNext || blocked()} onClick={() => setPage((v) => v + 1)}>
              {t().next}
            </Button>
          </div>
        </Show>
      </Show>
      <p class="text-xs text-dimmed">{t().rotation}</p>
    </section>
  );
}
