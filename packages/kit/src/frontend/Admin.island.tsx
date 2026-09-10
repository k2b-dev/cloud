import { createSignal, onMount, Show } from "solid-js";
import {
  Button,
  ButtonLink,
  Dropdown,
  CheckboxCard,
  DataPanel,
  DataTable,
  Pagination,
  PanelDialog,
  StatusBadge,
  NoticeCard,
  Placeholder,
  StatGrid,
  StatCell,
  TextInput,
  dialogCore,
  panelDialogOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { client, checked, displayError } from "./client";
import { AdminKitPermissions } from "./AdminKitPermissions";
import { databaseMessages } from "../database-messages";
export type AdminRow = {
  id: string;
  name: string;
  description: string;
  permissions: number;
  admins: number;
  database_enabled: boolean;
  transitioning: boolean;
};
export function AdminRsqlSettings(props: { close: () => void }) {
  const locale = useLocale(),
    t = () => databaseMessages.resolve([locale()]).t;
  const [loaded, setLoaded] = createSignal(false),
    [tokenSet, setTokenSet] = createSignal(false);
  const [enabled, setEnabled] = createSignal(false),
    [url, setUrl] = createSignal(""),
    [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(true),
    [error, setError] = createSignal(""),
    [success, setSuccess] = createSignal(false);
  onMount(async () => {
    try {
      const s = await checked(await client.admin.settings.$get());
      setEnabled(s.enabled);
      setUrl(s.url);
      setTokenSet(s.tokenSet);
      setLoaded(true);
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  });
  async function removeToken() {
    if (!(await prompts.confirm(t().tokenRemoveConfirm, { title: t().tokenRemove, variant: "danger", confirmText: t().tokenRemove })))
      return;
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      await checked(await client.admin.settings.$put({ json: { enabled: false, url: url(), token: "" } }));
      setTokenSet(false);
      setEnabled(false);
      setToken("");
    } catch (error) {
      setError(displayError(error, locale()));
    } finally {
      setBusy(false);
    }
  }
  async function save(test = false) {
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      const json = { enabled: enabled(), url: url(), ...(token() ? { token: token() } : {}) };
      if (test) {
        await checked(await client.admin.settings.test.$post({ json }));
        setSuccess(true);
      } else {
        await checked(await client.admin.settings.$put({ json }));
        props.close();
        await refreshCurrentPath();
      }
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().title}
        subtitle="Kit"
        icon="ti ti-database"
        close={() => {
          if (!busy()) props.close();
        }}
      />
      <PanelDialog.Body>
        <Show when={loaded()} fallback={error() ? null : <Placeholder state="loading" title={t().settings} />}>
          <CheckboxCard
            label={t().feature}
            icon="ti ti-database"
            value={enabled}
            onValueChange={(value) => {
              setEnabled(value);
              setSuccess(false);
            }}
            disabled={busy()}
          />
          <TextInput
            label={t().server}
            icon="ti ti-server"
            type="url"
            value={url}
            onValueChange={(value) => {
              setUrl(value);
              setSuccess(false);
            }}
            disabled={busy()}
          />
          <TextInput
            password
            label={t().token}
            icon="ti ti-key"
            description={t().tokenHint}
            value={token}
            onValueChange={(value) => {
              setToken(value);
              setSuccess(false);
            }}
            disabled={busy()}
          />
          <div class="flex flex-wrap items-center justify-between gap-2">
            <StatusBadge tone={tokenSet() ? "ok" : "warning"} label={tokenSet() ? t().tokenPresent : t().tokenMissing} />
            <Show when={tokenSet()}>
              <Button type="button" variant="danger" size="sm" disabled={busy()} onClick={removeToken}>
                <i class="ti ti-trash" aria-hidden="true" />
                {t().tokenRemove}
              </Button>
            </Show>
          </div>
        </Show>
        <Show when={error()}>
          <NoticeCard tone="danger" role="alert" title={error()} />
        </Show>
        <Show when={success()}>
          <div role="status">
            <StatusBadge tone="ok" label={t().connected} />
          </div>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button type="button" variant="secondary" size="sm" disabled={busy() || !loaded()} onClick={() => void save(true)}>
          <i class="ti ti-plug-connected" aria-hidden="true" />
          {t().test}
        </Button>
        <Button type="button" size="sm" loading={busy()} disabled={!loaded()} onClick={() => void save()}>
          <i class="ti ti-check" aria-hidden="true" />
          {t().save}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
export default function AdminKit(props: {
  userId: string;
  items: AdminRow[];
  summary: { total: number; orphaned: number; databases: number; cleanup: number };
  page: number;
  search: string;
}) {
  const locale = useLocale(),
    t = () => databaseMessages.resolve([locale()]).t;
  const [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  async function permissions(row: AdminRow) {
    await prompts.dialog<void>(() => <AdminKitPermissions id={row.id} />, { title: row.name, icon: "ti ti-shield" });
    await refreshCurrentPath();
  }
  async function remove(row: AdminRow) {
    if (!(await prompts.confirm(t().deleteConfirm, { title: `${t().remove}: ${row.name}`, variant: "danger", confirmText: t().remove })))
      return;
    setBusy(true);
    try {
      await checked(await client.projects[":id"].$delete({ param: { id: row.id } }));
      await refreshCurrentPath();
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="app-rows">
      <h1 class="text-base font-semibold">{t().apps}</h1>
      <StatGrid columns={3}>
        <StatCell label={t().apps} value={props.summary.total} />
        <StatCell label={t().orphaned} value={props.summary.orphaned} />
        <StatCell label={t().title} value={props.summary.databases} />
      </StatGrid>
      <Show when={props.summary.cleanup}>
        <p role="status">
          {t().cleanup}: {props.summary.cleanup}
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <form action="/admin/kit" class="flex-1">
          <TextInput name="q" aria-label={t().search} placeholder={t().search} value={props.search} />
        </form>
        <Button
          variant="secondary"
          onClick={() => dialogCore.open<void>((close) => <AdminRsqlSettings close={() => close()} />, panelDialogOptions)}
        >
          {t().settings}
        </Button>
      </div>
      <Show when={error()}>
        <p role="alert" class="kit-error">
          {error()}
        </p>
      </Show>
      <DataPanel
        title={t().apps}
        footer={
          <Pagination
            currentPage={props.page}
            totalPages={Math.ceil(props.summary.total / 30)}
            baseUrl={`/admin/kit?q=${encodeURIComponent(props.search)}&page=`}
          />
        }
      >
        <DataTable
          rows={props.items}
          getRowId={(r) => r.id}
          empty={t().empty}
          columns={[
            { id: "name", header: t().apps, value: (r) => r.name },
            { id: "permissions", header: t().permissions, value: (r) => r.permissions },
            { id: "database", header: t().title },
            { id: "actions", header: <span class="sr-only">{t().appActions}</span>, cellClass: "text-right whitespace-nowrap" },
          ]}
          renderCell={({ row, col }) => {
            if (col.id === "name")
              return (
                <ButtonLink href={`/app/kit/${row.id}`} variant="text">
                  {row.name} · {row.id}
                </ButtonLink>
              );
            if (col.id === "permissions")
              return (
                <span>
                  {row.permissions}
                  {row.admins === 0 ? ` · ${t().orphaned}` : ""}
                </span>
              );
            if (col.id === "database") return row.transitioning ? t().preparing : row.database_enabled ? t().ready : t().disabled;
            if (col.id === "actions")
              return (
                <Dropdown.Root
                  position="bottom-left"
                  width="13rem"
                  items={[
                    { items: [{ icon: "ti ti-shield", label: t().permissions, action: () => void permissions(row), disabled: busy() }] },
                    {
                      items: [
                        { icon: "ti ti-trash", label: t().remove, action: () => void remove(row), variant: "danger", disabled: busy() },
                      ],
                    },
                  ]}
                >
                  <Dropdown.Trigger iconOnly label={t().actionsFor({ name: row.name })} size="xs" tooltip={t().appActions}>
                    <i class="ti ti-settings text-sm" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              );
            return "";
          }}
        />
      </DataPanel>
    </div>
  );
}
