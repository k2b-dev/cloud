import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { Button, ButtonLink, CheckboxCard, StatCell, StatGrid, DataTable, prompts, useLocale } from "@k2b/ui";
import { client, checked, displayError } from "./client";
import { databaseMessages } from "../database-messages";
import type { database } from "../service/database";
type State = Awaited<ReturnType<typeof database.status>>;
export function DatabasePanel(props: { id: string; name: string }) {
  const locale = useLocale(),
    t = () => databaseMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<State>();
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [updated, setUpdated] = createSignal("");
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const api = () => client.projects[":id"].database;
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setState(
        await checked(await api().$get({ param: { id: props.id }, query: { diagnostics: "true" } }, { init: { signal: abort.signal } })),
      );
      setUpdated(new Date().toLocaleTimeString(locale()));
    } catch (e) {
      if (!abort.signal.aborted) setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  }
  async function change(enabled: boolean, reset = false) {
    if (
      reset &&
      !(await prompts.confirm(t().resetConfirm, { title: `${t().reset}: ${props.name}`, variant: "danger", confirmText: t().reset }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (reset) await checked(await api().reset.$post({ param: { id: props.id }, json: { confirm: true } }));
      else await checked(await api().$put({ param: { id: props.id }, json: { enabled } }));
      await refresh();
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  }
  onMount(refresh);
  const tableRows = () => (state()?.tables ?? []).filter((row) => row.type === "table");
  const records = () =>
    tableRows().every((row) => typeof row.row_count === "number")
      ? tableRows().reduce((sum, row) => sum + Number(row.row_count), 0)
      : t().unknown;
  return (
    <div class="kit-flow kit-flow-column kit-gap-md">
      <CheckboxCard
        label={t().enabled}
        description={t().shared}
        icon="ti ti-database"
        value={() => state()?.enabled ?? false}
        disabled={busy() || !state()?.globallyEnabled || !state()?.canAdmin || state()?.status === "provisioning"}
        onValueChange={(enabled) => void change(enabled)}
      />
      <p role="status">
        {!state()
          ? t().unknown
          : !state()!.globallyEnabled
            ? t().globalOff
            : state()!.status === "provisioning"
              ? t().preparing
              : state()!.status === "unavailable"
                ? t().unavailable
                : !state()!.enabled
                  ? t().disabled
                  : t().ready}
      </p>
      <Show when={error()}>
        <p role="alert" class="kit-error">
          {error()}
        </p>
      </Show>
      <StatGrid columns={3}>
        <StatCell label={t().tables} value={state()?.overview?.schema.tables ?? t().unknown} />
        <StatCell label={t().records} value={state()?.tables ? records() : t().unknown} />
        <StatCell
          label={t().storage}
          value={state()?.overview ? `${(state()!.overview!.storage.used_bytes / 1048576).toFixed(2)} MiB` : t().unknown}
        />
      </StatGrid>
      <Show when={state()?.overview?.storage.usage_ratio != null}>
        <progress aria-label={t().storage} max={1} value={state()?.overview?.storage.usage_ratio ?? 0} />
      </Show>
      <DataTable
        rows={tableRows()}
        getRowId={(row) => String(row.name)}
        columns={[
          { id: "name", header: t().tables, value: (row) => String(row.name) },
          { id: "records", header: t().records, value: (row) => (typeof row.row_count === "number" ? row.row_count : t().unknown) },
        ]}
        empty={t().unknown}
      />
      <div class="kit-flow kit-gap-sm">
        <Button variant="secondary" onClick={refresh} loading={busy()}>
          {t().refresh}
        </Button>
        <span>
          {t().updated}: {updated() || t().unknown}
        </span>
      </div>
      <Show when={state()?.canAdmin && state()?.provisioned && state()?.globallyEnabled}>
        <div class="kit-flow kit-gap-sm">
          <ButtonLink href={`/api/kit/projects/${props.id}/database/export`} variant="secondary">
            {t().export}
          </ButtonLink>
          <Button variant="danger" disabled={busy() || state()?.status === "provisioning"} onClick={() => void change(false, true)}>
            {t().reset}
          </Button>
        </div>
      </Show>
    </div>
  );
}
