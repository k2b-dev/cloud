import { i18n } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CodeDisplay,
  DescriptionList,
  DetailPanel,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWideOptions,
  useLocale,
} from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { WorkflowFilePreviewSchema, type WorkflowFileReference } from "../../../workflows/file-preview-contracts";
import { errorMessage } from "../utils/api-helpers";

export const camtReportMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Bank report",
      open: "View bank report",
      scope: "Read only. This report does not confirm a payment or update invoices.",
      partial: "This file or report is not the last page. It does not contain the complete report sequence.",
      paginationUnknown: "The bank did not specify whether this report sequence is complete.",
      original: "Download original XML",
      account: "Account",
      period: "Period",
      entries: "Entries",
      statuses: "Bank statuses",
      details: "Report details",
      previous: "Previous",
      next: "Next",
      close: "Close",
      loading: "Loading bank report…",
      failed: "Could not load this bank report.",
      retry: "Try again",
      empty: "No account reports",
      unknown: "Not specified",
      number: ({ current, total }: { current: number; total: number }) => `Report ${current} of ${total}`,
    },
    de: {
      title: "Bankbericht",
      open: "Bankbericht ansehen",
      scope: "Nur lesend. Dieser Bericht bestätigt keine Zahlung und ändert keine Rechnungen.",
      partial: "Diese Datei oder dieser Bericht ist nicht die letzte Seite. Die Berichtsfolge ist noch nicht vollständig.",
      paginationUnknown: "Die Bank hat nicht angegeben, ob die Berichtsfolge vollständig ist.",
      original: "Original-XML herunterladen",
      account: "Konto",
      period: "Zeitraum",
      entries: "Buchungseinträge",
      statuses: "Bankstatus",
      details: "Berichtsdetails",
      previous: "Zurück",
      next: "Weiter",
      close: "Schließen",
      loading: "Bankbericht wird geladen…",
      failed: "Dieser Bankbericht konnte nicht geladen werden.",
      retry: "Erneut versuchen",
      empty: "Keine Kontoberichte",
      unknown: "Nicht angegeben",
      number: ({ current, total }: { current: number; total: number }) => `Bericht ${current} von ${total}`,
    },
  },
});

export const openCamtReportDialog = (runId: string, reference: WorkflowFileReference) =>
  dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => camtReportMessages.resolve([locale()]).t;
    const [page, setPage] = createSignal(0);
    const endpoint = apiClient.workflows.runs[":runId"].files[":stepKey"];
    const args = { param: { runId, stepKey: reference.stepKey }, query: { sha256: reference.sha256 } };
    const preview = query.create({
      source: () => reference.stepKey,
      load: async (_, { abortSignal }) => {
        const response = await endpoint.$get(args, { init: { signal: abortSignal } });
        if (!response.ok) throw new Error(await errorMessage(response, t().failed));
        return WorkflowFilePreviewSchema.parse(await response.json());
      },
    });
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().title} subtitle={preview.data()?.filename} icon="ti ti-building-bank" close={close} />
        <PanelDialog.Body>
          <div class="flex min-w-0 flex-col gap-4">
            <Show when={preview.error()}>{(error) => <NoticeCard tone="danger" title={error().message} />}</Show>
            <Show when={preview.loading()}>
              <Placeholder description={t().loading} />
            </Show>
            <Show when={preview.error()}>
              <Button variant="secondary" onClick={() => void preview.refresh()}>
                {t().retry}
              </Button>
            </Show>
            <Show when={preview.data()}>
              {(data) => (
                <>
                  <p class="text-sm text-secondary">{t().scope}</p>
                  <Show when={data().reports[page()]} keyed fallback={<Placeholder description={t().empty} />}>
                    {(report) => (
                      <>
                        <Show when={data().pagination?.lastPage === false || report.pagination?.lastPage === false}>
                          <NoticeCard tone="warning" title={t().partial} />
                        </Show>
                        <Show when={!data().pagination && !report.pagination}>
                          <p class="text-sm text-dimmed">{t().paginationUnknown}</p>
                        </Show>
                        <DescriptionList
                          columns={2}
                          items={[
                            { term: t().account, description: `${report.account}${report.currency ? ` · ${report.currency}` : ""}` },
                            { term: t().period, description: report.period ? `${report.period.from} – ${report.period.to}` : t().unknown },
                            { term: t().entries, description: String(report.entryCount) },
                            {
                              term: t().statuses,
                              description:
                                Object.entries(report.statuses)
                                  .map(([status, count]) => `${status}: ${count}`)
                                  .join(" · ") || "—",
                            },
                          ]}
                        />
                        <DetailPanel.Section title={t().details} icon="ti ti-code" collapsible defaultOpen={false}>
                          <CodeDisplay
                            code={JSON.stringify(report.details, null, 2)}
                            language="text"
                            title={report.id}
                            lineNumbers={false}
                          />
                        </DetailPanel.Section>
                      </>
                    )}
                  </Show>
                  <Show when={data().reports.length > 1}>
                    <div class="flex flex-wrap items-center gap-3">
                      <Button variant="secondary" size="sm" disabled={page() === 0} onClick={() => setPage((p) => p - 1)}>
                        {t().previous}
                      </Button>
                      <span class="text-xs text-dimmed" aria-live="polite">
                        {t().number({ current: page() + 1, total: data().reports.length })}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page() + 1 >= data().reports.length}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        {t().next}
                      </Button>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show when={preview.data()}>
            <ButtonLink
              variant="secondary"
              size="sm"
              navigation="document"
              href={`/api/grids/workflows/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(reference.stepKey)}?sha256=${reference.sha256}&download=original`}
            >
              {t().original}
            </ButtonLink>
          </Show>
          <Button variant="secondary" size="sm" onClick={() => close()}>
            {t().close}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogWideOptions);
