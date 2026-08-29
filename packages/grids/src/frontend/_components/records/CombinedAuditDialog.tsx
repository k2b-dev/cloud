import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, DatePicker, dialogCore, PanelDialog, Placeholder, panelDialogWideOptions, Select, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicCombinedAuditPage as CombinedAuditPage } from "../../../api/public-audit";
import type { PublicField as Field } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { recordMessages } from "./messages";
import { RecordHistoryList } from "./RecordHistorySection";
import RecordPicker from "./RecordPicker";

export const combinedAuditDateStart = (value: string, dateConfig?: DateContext) =>
  value ? dates.parseCalendarDate(value, dateConfig).toISOString() : undefined;

export const combinedAuditDayAfter = (value: string, dateConfig?: DateContext) =>
  value ? dates.addDays(dates.parseCalendarDate(value, dateConfig), 1, dateConfig).toISOString() : undefined;

type AuditFilters = {
  recordId: string;
  sourceRef: string;
  action: string;
  from: string;
  through: string;
};

type LoadVars = AuditFilters & {
  append: boolean;
  cursor: string | null;
};

type Props = {
  tableId: string;
  tableName: string;
  fields: Field[];
  dateConfig?: DateContext;
  initialRecordId?: string;
  onOpenRecord: (recordId: string, deleted: boolean) => void;
  close: () => void;
};

function CombinedAuditDialog(props: Props) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const actionOptions = () => [
    { id: "", label: t().allActions },
    { id: "created", label: t().created },
    { id: "updated", label: t().updated },
    { id: "deleted", label: t().deleted },
    { id: "restored", label: t().restored },
    { id: "imported", label: t().imported },
  ];
  const [items, setItems] = createSignal<CombinedAuditPage["items"]>([]);
  const [sources, setSources] = createSignal<CombinedAuditPage["sources"]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [recordId, setRecordId] = createSignal(props.initialRecordId ?? "");
  const [sourceRef, setSourceRef] = createSignal("");
  const [action, setAction] = createSignal("");
  const [from, setFrom] = createSignal("");
  const [through, setThrough] = createSignal("");

  const loadMut = mutations.create<CombinedAuditPage, LoadVars, { append: boolean }>({
    onBefore: (vars) => ({ append: vars.append }),
    mutation: async (vars, { abortSignal }) => {
      const fromBoundary = combinedAuditDateStart(vars.from, props.dateConfig);
      const toBoundary = combinedAuditDayAfter(vars.through, props.dateConfig);
      const response = await apiClient.records["by-table"][":tableId"].audit.$get(
        {
          param: { tableId: props.tableId },
          query: {
            ...(vars.recordId ? { recordId: vars.recordId } : {}),
            ...(vars.sourceRef ? { sourceRef: vars.sourceRef } : {}),
            ...(vars.action ? { action: vars.action as "created" | "updated" | "deleted" | "restored" | "imported" } : {}),
            ...(fromBoundary ? { from: fromBoundary } : {}),
            ...(toBoundary ? { to: toBoundary } : {}),
            ...(vars.append && vars.cursor ? { cursor: vars.cursor } : {}),
            limit: "50",
          },
        },
        {
          init: { signal: abortSignal },
        },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().auditLoadFailed));
      return (await response.json()) as CombinedAuditPage;
    },
    onSuccess: (page, context) => {
      setItems((current) => (context?.append ? [...current, ...page.items] : page.items));
      setSources(page.sources);
      setCursor(page.nextCursor);
      setLoaded(true);
    },
  });

  const currentFilters = (): AuditFilters => ({
    recordId: recordId(),
    sourceRef: sourceRef(),
    action: action(),
    from: from(),
    through: through(),
  });

  const load = (append: boolean, filters = currentFilters()) => {
    if (!append) {
      setLoaded(false);
      setItems([]);
      setCursor(null);
    }
    void loadMut.mutate({ ...filters, append, cursor: append ? cursor() : null });
  };

  const applyFilters = () => load(false);
  const clearFilters = () => {
    setRecordId("");
    setSourceRef("");
    setAction("");
    setFrom("");
    setThrough("");
    load(false, { recordId: "", sourceRef: "", action: "", from: "", through: "" });
  };
  const openRecord = (id: string, deleted: boolean) => {
    props.close();
    props.onOpenRecord(id, deleted);
  };

  onMount(() => load(false));
  onCleanup(() => loadMut.abort());

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().auditTrail} subtitle={props.tableName} icon="ti ti-history" close={props.close} />
      <PanelDialog.Body scrollPreserveKey={`grids-combined-audit-${props.tableId}`}>
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <RecordPicker
            tableId={props.tableId}
            value={recordId}
            onChange={setRecordId}
            label={t().record}
            placeholder={t().allRecords}
            clearable
            includeDeleted
          />
          <Select
            label={t().source}
            value={sourceRef}
            onValueChange={setSourceRef}
            options={[
              { id: "", label: t().allSources },
              ...sources().map((source) => ({
                id: source.ref,
                label: `${source.baseName} · ${source.tableName}`,
              })),
            ]}
          />
          <Select label={t().action} value={action} onValueChange={setAction} options={actionOptions()} />
          <DatePicker
            label={t().from}
            dateConfig={props.dateConfig}
            value={() => from() || null}
            onValueChange={(value) => setFrom(value ?? "")}
            clearable
          />
          <DatePicker
            label={t().through}
            dateConfig={props.dateConfig}
            value={() => through() || null}
            onValueChange={(value) => setThrough(value ?? "")}
            clearable
          />
        </div>
        <div class="mt-2 flex items-center gap-2">
          <Button variant="primary" size="sm" type="button" onClick={applyFilters} disabled={loadMut.loading()}>
            <i class={`ti ${loadMut.loading() ? "ti-loader-2 animate-spin" : "ti-filter"}`} aria-hidden="true" />
            {t().apply}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={clearFilters} disabled={loadMut.loading()}>
            {t().clear}
          </Button>
          <span class="ml-auto text-xs text-dimmed" aria-live="polite">
            {loadMut.loading() && !loaded() ? t().loadingHistory : t().eventsLoaded({ count: items().length })}
          </span>
        </div>

        <PanelDialog.Section title={t().publishedHistory} subtitle={t().publishedHistorySubtitle} icon="ti ti-list-details">
          <Show
            when={loaded()}
            fallback={
              <Show
                when={loadMut.error()}
                fallback={<Placeholder state="loading" align="left" description={t().loadingPublishedHistory} />}
              >
                {(error) => (
                  <Placeholder
                    state="error"
                    surface="paper"
                    align="left"
                    title={t().auditLoadFailed}
                    description={error().message}
                    action={
                      <Button variant="secondary" size="sm" type="button" onClick={() => loadMut.retry()}>
                        <i class="ti ti-refresh" aria-hidden="true" />
                        {t().retry}
                      </Button>
                    }
                  />
                )}
              </Show>
            }
          >
            <Show when={loadMut.error()}>
              {(error) => (
                <Placeholder
                  state="error"
                  surface="paper"
                  align="left"
                  title={t().olderEventsFailed}
                  description={error().message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => loadMut.retry()}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {t().retry}
                    </Button>
                  }
                />
              )}
            </Show>
            <RecordHistoryList entries={items()} fields={props.fields} dateConfig={props.dateConfig} onOpenRecord={openRecord} />
            <Show when={cursor()}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                class="mt-2 self-start"
                disabled={loadMut.loading()}
                onClick={() => load(true)}
              >
                <i class={`ti ${loadMut.loading() ? "ti-loader-2 animate-spin" : "ti-chevron-down"}`} aria-hidden="true" />
                {t().loadOlderEvents}
              </Button>
            </Show>
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button variant="ghost" size="sm" type="button" onClick={props.close}>
          {t().done}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openCombinedAuditDialog = (params: Omit<Props, "close">) =>
  dialogCore.open<void>((close) => <CombinedAuditDialog {...params} close={() => close()} />, panelDialogWideOptions);
