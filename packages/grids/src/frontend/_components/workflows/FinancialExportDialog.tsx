import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  DetailPanel,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWideOptions,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { FinancialExportPreview } from "../../../api/workflow-document-confirmations";
import { formatDocumentDateTime } from "../documents/document-workspace-utils";
import { formatCell } from "../table/format-cell";
import { errorMessage } from "../utils/api-helpers";
import { financialExportMessages } from "./financial-export-messages";
import { financialExportTotals } from "./financial-export-preview";

export const openFinancialExportDialog = (args: { runId: string; receiptId: string }, signal?: AbortSignal) =>
  dialogCore.open<boolean>(
    (close, context) => {
      const locale = useLocale();
      const t = () => financialExportMessages.resolve([locale()]).t;
      const [preview, setPreview] = createSignal<FinancialExportPreview>();
      const [error, setError] = createSignal<string>();
      const [page, setPage] = createSignal(0);
      const [confirmed, setConfirmed] = createSignal(false);
      const [showBankDetails, setShowBankDetails] = createSignal(false);
      const endpoint = apiClient.workflows.runs[":runId"]["document-confirmations"][":receiptId"];
      const load = mutations.create<FinancialExportPreview, void>({
        mutation: async (_, { abortSignal }) => {
          setError(undefined);
          const response = await endpoint.$get({ param: args }, { init: { signal: abortSignal } });
          if (!response.ok) throw new Error(await errorMessage(response, t().loadFailed));
          return response.json();
        },
        onSuccess: (value) => {
          setPreview(value);
          setPage(0);
          setConfirmed(value.confirmedAt !== null);
          setShowBankDetails(false);
        },
        onError: (failure) => setError(failure.message),
      });
      const confirm = mutations.create<void, FinancialExportPreview>({
        mutation: async (value, { abortSignal }) => {
          setError(undefined);
          const response = await endpoint.confirm.$post({ param: args, json: { sha256: value.sha256 } }, { init: { signal: abortSignal } });
          if (!response.ok) throw new Error(await errorMessage(response, t().confirmFailed));
        },
        onSuccess: () => setConfirmed(true),
        onError: (failure) => setError(failure.message),
      });
      const dismiss = () => {
        if (!confirm.loading()) close(confirmed());
      };
      onCleanup(() => {
        load.abort();
        confirm.abort();
      });
      context.setDismissHandler(dismiss);
      onMount(() => load.mutate());
      const label = (key: string): string => {
        const value = Object.entries(t()).find(([field]) => field === key)?.[1];
        return typeof value === "string" ? value : key;
      };
      const display = (value: unknown, key?: string) => {
        if (key?.endsWith("Iban") && typeof value === "string" && !showBankDetails()) return `${value.slice(0, 2)} •••• ${value.slice(-4)}`;
        if (key === "amount")
          return formatCell(value, "number", {}, { kind: "decimal", precision: 2, thousandsSeparator: true }, undefined, locale());
        return typeof value === "boolean" ? (value ? t().yes : t().no) : String(value ?? "—");
      };

      return (
        <PanelDialog>
          <PanelDialog.Header title={t().title} subtitle={preview()?.filename ?? undefined} icon="ti ti-file-check" close={dismiss} />
          <PanelDialog.Body>
            <div class="flex min-w-0 flex-col gap-5">
              <Show when={error()}>{(message) => <NoticeCard tone="danger" title={message()} />}</Show>
              <Show
                when={preview()}
                fallback={
                  <div class="flex flex-col items-start gap-3">
                    <Show when={load.loading()}>
                      <Placeholder description={t().loading} />
                    </Show>
                    <Button variant="secondary" disabled={load.loading()} onClick={() => load.mutate()}>
                      {t().retry}
                    </Button>
                  </div>
                }
              >
                {(value) => {
                  const rows = (): Record<string, unknown>[] => value().input.rows;
                  const columns = (): DataTableColumn<Record<string, unknown>>[] =>
                    [...new Set(rows().flatMap((row) => Object.keys(row)))].map((key) => ({
                      id: key,
                      header: label(key),
                      value: (row) => display(row[key], key),
                      ...(key === "amount" ? { align: "right" as const } : {}),
                    }));
                  const settings = () =>
                    Object.entries(value().input).filter(
                      ([key]) => !["rows", "destinationKey", "messageId", "paymentInformationId"].includes(key),
                    );
                  return (
                    <>
                      <Show when={confirmed()} fallback={<p class="text-sm text-secondary">{t().review}</p>}>
                        <NoticeCard tone="success" title={t().confirmed} detail={t().confirmedDetail} />
                      </Show>
                      <For each={value().warnings}>{(warning) => <NoticeCard tone="warning" title={warning.message} />}</For>
                      <DescriptionList
                        columns={2}
                        items={[
                          {
                            term: t().profile,
                            description: t().profileVersion({
                              format: value().kind === "datev-csv" ? "DATEV CSV" : "SEPA XML",
                              version: value().version,
                            }),
                          },
                          { term: t().destination, description: <span class="break-words">{value().input.destinationKey}</span> },
                          {
                            term: t().captured,
                            description: formatDocumentDateTime(value().source.capturedAt, {
                              locale: locale(),
                              timeZone: value().timeZone,
                            }),
                          },
                          ...financialExportTotals(value()).map((total) => ({
                            term: t()[total.key],
                            description: <span class="text-lg font-semibold tabular-nums">{display(total.value, "amount")}</span>,
                          })),
                        ]}
                      />
                      <Show when={value().source.selectionLimit}>
                        {(limit) => <NoticeCard tone="warning" title={t().limited({ limit: limit() })} />}
                      </Show>
                      <DetailPanel.Section title={t().configuration} icon="ti ti-adjustments">
                        <DescriptionList
                          columns={2}
                          size="sm"
                          items={settings().map(([key, field]) => ({
                            term: label(key),
                            description: <span class="break-words">{display(field, key)}</span>,
                          }))}
                        />
                      </DetailPanel.Section>
                      <Show when={value().kind === "sepa-xml"}>
                        <Button
                          variant="secondary"
                          class="self-start"
                          aria-pressed={showBankDetails()}
                          onClick={() => setShowBankDetails((shown) => !shown)}
                        >
                          <i class={showBankDetails() ? "ti ti-eye-off" : "ti ti-eye"} aria-hidden="true" />
                          {showBankDetails() ? t().hideBankDetails : t().showBankDetails}
                        </Button>
                      </Show>
                      <section class="min-w-0" aria-label={t().rows}>
                        <DataTable
                          rows={rows().slice(page() * 50, (page() + 1) * 50)}
                          columns={columns()}
                          density="compact"
                          surface="plain"
                          ariaLabel={t().rows}
                        />
                        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-dimmed">
                          <span>
                            {t().range({ first: page() * 50 + 1, last: Math.min((page() + 1) * 50, rows().length), total: rows().length })}
                          </span>
                          <div class="flex gap-2">
                            <Button variant="secondary" size="sm" disabled={page() === 0} onClick={() => setPage((p) => p - 1)}>
                              {t().previous}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={(page() + 1) * 50 >= rows().length}
                              onClick={() => setPage((p) => p + 1)}
                            >
                              {t().next}
                            </Button>
                          </div>
                        </div>
                      </section>
                      <DetailPanel.Section title={t().technical} icon="ti ti-code" collapsible defaultOpen={false}>
                        <div class="flex flex-col gap-3">
                          <Show when={value().source.query}>
                            {(query) => <pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs">{query()}</pre>}
                          </Show>
                          <div>
                            <p class="text-xs text-dimmed">{t().hash}</p>
                            <code class="break-all text-xs">{value().sha256}</code>
                          </div>
                        </div>
                      </DetailPanel.Section>
                      <p class="text-xs text-dimmed">{t().scope}</p>
                    </>
                  );
                }}
              </Show>
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <Button variant="secondary" disabled={confirm.loading()} onClick={dismiss}>
              {t().close}
            </Button>
            <Show when={preview() && !confirmed()}>
              <Button
                variant="primary"
                disabled={confirm.loading() || load.loading()}
                onClick={() => {
                  const value = preview();
                  if (value) confirm.mutate(value);
                }}
              >
                {confirm.loading() ? t().confirming : t().confirm}
              </Button>
            </Show>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    },
    { ...panelDialogWideOptions, signal },
  );
