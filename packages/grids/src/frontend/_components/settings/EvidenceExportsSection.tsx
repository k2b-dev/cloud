import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  CopyButton,
  DateRangePicker,
  DescriptionList,
  dialogCore,
  InlineGuidance,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  SettingsCollection,
  SettingsGroup,
  StatCell,
  StatGrid,
  StatusBadge,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicBase, PublicTable } from "../../../api/public-dto";
import {
  EVIDENCE_EXPORT_SECTIONS,
  type EvidenceExport,
  type EvidenceExportPreflight,
  type EvidenceExportSection,
} from "../../../evidence-export-contracts";
import { errorMessage } from "../utils/api-helpers";
import { openEvidenceCoverageDialog } from "./EvidenceCoverageDialog";
import { useGridsSettingsMessages } from "./messages";

type Messages = ReturnType<ReturnType<typeof useGridsSettingsMessages>>;
const sectionOptions = (messages: Messages): Array<{ id: EvidenceExportSection; label: string; description: string; icon: string }> => [
  { id: "records", label: messages.records, description: messages.evidenceRecordsDescription, icon: "ti ti-table" },
  {
    id: "revisions",
    label: messages.durableHistorySection,
    description: messages.durableHistorySectionDescription,
    icon: "ti ti-history",
  },
  { id: "audit", label: messages.audit, description: messages.auditDescription, icon: "ti ti-activity" },
  {
    id: "schema",
    label: messages.schemaAndConfiguration,
    description: messages.schemaAndConfigurationDescription,
    icon: "ti ti-settings",
  },
  {
    id: "relations",
    label: messages.relations,
    description: messages.relationsDescription,
    icon: "ti ti-link",
  },
  { id: "files", label: messages.files, description: messages.evidenceFilesDescription, icon: "ti ti-paperclip" },
  {
    id: "documents",
    label: messages.documentArtifacts,
    description: messages.documentArtifactsDescription,
    icon: "ti ti-file-type-pdf",
  },
  { id: "numbers", label: messages.numberAllocations, description: messages.numberAllocationsDescription, icon: "ti ti-number" },
];

const STATUS_TONE = {
  queued: "neutral",
  running: "running",
  cancel_requested: "warning",
  completed: "ok",
  failed: "error",
  canceled: "neutral",
  expired: "neutral",
} as const;

const statusLabel = (status: EvidenceExport["status"], messages: Messages): string =>
  ({
    queued: messages.statusQueued,
    running: messages.statusRunning,
    cancel_requested: messages.statusCancelRequested,
    completed: messages.statusCompleted,
    failed: messages.statusFailed,
    canceled: messages.statusCanceled,
    expired: messages.expired,
  })[status];
const bytesLabel = (bytes: number, locale: string): string => {
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) return `${format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
  return `${format(bytes / (1024 * 1024))} MB`;
};

const verificationCommand = (item: EvidenceExport): string | null =>
  item.package
    ? `cld grids evidence verify ${item.package.filename} --sha256 ${item.package.sha256} --manifest-sha256 ${item.package.manifestSha256}`
    : null;

const openPackageDetails = (item: EvidenceExport, locale: string, messages: Messages) =>
  prompts.dialog<void>(
    () => (
      <div class="k2b-dialog__body space-y-4">
        <Show when={item.error}>
          {(error) => (
            <InlineGuidance tone="danger" icon="ti ti-alert-circle">
              {error()}
            </InlineGuidance>
          )}
        </Show>
        <Show when={item.package} keyed>
          {(pkg) => (
            <DescriptionList
              layout="rows"
              size="sm"
              items={[
                { term: messages.filename, description: pkg.filename },
                { term: messages.size, description: bytesLabel(pkg.sizeBytes, locale) },
                { term: messages.packageSha256, description: <code class="break-all text-xs">{pkg.sha256}</code> },
                { term: messages.manifestSha256, description: <code class="break-all text-xs">{pkg.manifestSha256}</code> },
                {
                  term: messages.offlineVerification,
                  description: <code class="break-all text-xs">{verificationCommand(item)}</code>,
                  action: (
                    <CopyButton
                      text={verificationCommand(item)!}
                      label={messages.copyCommand}
                      copiedLabel={messages.verificationCommandCopied}
                      variant="secondary"
                      size="sm"
                      onCopyError={() => prompts.error(messages.copyVerificationFailed)}
                    />
                  ),
                },
              ]}
            />
          )}
        </Show>
      </div>
    ),
    { title: messages.packageDetails, icon: "ti ti-package", size: "medium" },
  );

const requestRange = (range: { start: string | null; end: string | null }) => ({
  from: range.start ? `${range.start}T00:00:00.000Z` : undefined,
  to: range.end ? `${range.end}T23:59:59.999Z` : undefined,
});

const download = async (item: EvidenceExport, unavailableMessage: string) => {
  const response = await fetch(`/api/grids/evidence-exports/${encodeURIComponent(item.id)}/download`);
  if (!response.ok) throw new Error(await errorMessage(response, unavailableMessage));
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = item.package?.filename ?? "grids-evidence.tar";
  anchor.click();
  URL.revokeObjectURL(href);
};

export const openEvidenceExportDialog = (base: PublicBase, tables: PublicTable[], onCreated: () => void) =>
  dialogCore.open<void>(
    (close) => <EvidenceExportDialog base={base} tables={tables} close={close} onCreated={onCreated} />,
    panelDialogOptions,
  );

function EvidenceExportDialog(props: { base: PublicBase; tables: PublicTable[]; close: () => void; onCreated: () => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const [tableId, setTableId] = createSignal("");
  const [range, setRange] = createSignal<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [sections, setSections] = createSignal<EvidenceExportSection[]>([...EVIDENCE_EXPORT_SECTIONS]);
  const preflightKey = createMemo(() => JSON.stringify({ tableId: tableId(), sections: sections().join(","), ...requestRange(range()) }));
  const preflight = query.create({
    source: preflightKey,
    load: async (key, { abortSignal }) => {
      const value = JSON.parse(key) as { tableId: string; sections: string; from?: string; to?: string };
      const response = await apiClient["evidence-exports"]["by-base"][":baseId"].preflight.$get(
        {
          param: { baseId: props.base.id },
          query: {
            ...(value.tableId ? { tableId: value.tableId } : {}),
            sections: value.sections,
            ...(value.from ? { from: value.from } : {}),
            ...(value.to ? { to: value.to } : {}),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().estimateEvidenceFailed));
      return { key, value: (await response.json()) as EvidenceExportPreflight };
    },
  });
  const currentPreflight = () => (preflight.data()?.key === preflightKey() ? preflight.data()!.value : null);
  const toggleSection = (section: EvidenceExportSection, checked: boolean) =>
    setSections((current) =>
      EVIDENCE_EXPORT_SECTIONS.filter((candidate) => (candidate === section ? checked : current.includes(candidate))),
    );

  const createMutation = mutations.create<EvidenceExport, void>({
    mutation: async (_, { abortSignal }) => {
      const dates = requestRange(range());
      const response = await apiClient["evidence-exports"]["by-base"][":baseId"].$post(
        {
          param: { baseId: props.base.id },
          json: {
            tableId: tableId() || null,
            sections: sections(),
            ...(dates.from ? { from: dates.from } : {}),
            ...(dates.to ? { to: dates.to } : {}),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().startEvidenceExportFailed));
      return response.json();
    },
    onSuccess: () => {
      toast.success(messages().evidenceExportQueued);
      props.onCreated();
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });

  const submitDisabled = () => sections().length === 0 || preflight.loading() || !currentPreflight()?.withinKnownBudgets;

  return (
    <PanelDialog>
      <PanelDialog.Header title={messages().newEvidenceExport} subtitle={props.base.name} icon="ti ti-package-export" close={props.close} />
      <PanelDialog.Body>
        <NoticeCard tone="info" title={messages().verifiableNotCertificate} detail={messages().evidenceManifestDescription} />
        <div class="grid gap-3 sm:grid-cols-2">
          <Select
            label={messages().scope}
            description={messages().exportScopeDescription}
            value={tableId}
            onValueChange={(value) => setTableId(value ?? "")}
            options={[{ id: "", label: messages().completeBase }, ...props.tables.map((table) => ({ id: table.id, label: table.name }))]}
          />
          <DateRangePicker
            label={messages().period}
            description={messages().periodDescription}
            value={range}
            onValueChange={setRange}
            clearable
          />
        </div>
        <PanelDialog.Section title={messages().includedEvidence} subtitle={messages().selectedByDefault} icon="ti ti-list-check">
          <div class="grid gap-2 sm:grid-cols-2">
            <For each={sectionOptions(messages())}>
              {(option) => (
                <CheckboxCard
                  label={option.label}
                  description={option.description}
                  icon={option.icon}
                  value={() => sections().includes(option.id)}
                  onValueChange={(checked) => toggleSection(option.id, checked)}
                  disabled={createMutation.loading()}
                />
              )}
            </For>
          </div>
        </PanelDialog.Section>
        <Show when={preflight.loading()}>
          <Placeholder state="loading" variant="compact" title={messages().checkingKnownScope} />
        </Show>
        <Show when={preflight.error()}>
          <Placeholder
            state="error"
            variant="compact"
            title={messages().scopeCheckFailed}
            description={preflight.error() instanceof Error ? preflight.error()!.message : messages().preflightFailed}
            action={
              <Button variant="secondary" size="sm" onClick={() => void preflight.invalidate()}>
                {messages().retry}
              </Button>
            }
          />
        </Show>
        <Show when={currentPreflight()} keyed>
          {(preview) => (
            <NoticeCard
              tone={preview.withinKnownBudgets ? (preview.warnings.length > 0 ? "warning" : "success") : "danger"}
              title={preview.withinKnownBudgets ? messages().knownScopeFits : messages().knownScopeTooLarge}
              detail={messages().knownScopeSummary({
                records: number(preview.known.records),
                revisions: number(preview.known.revisions),
                documents: number(preview.known.documents),
                bytes: bytesLabel(preview.known.fileBytes + preview.known.documentBytes, locale()),
              })}
            >
              <Show when={preview.warnings.length > 0}>
                <ul class="mt-2 list-disc space-y-1 pl-4 text-xs">
                  <For each={preview.warnings}>{(warning) => <li>{warning}</li>}</For>
                </ul>
              </Show>
            </NoticeCard>
          )}
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="text-xs text-muted">{messages().packagesExpire}</span>
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={props.close} disabled={createMutation.loading()}>
            {messages().cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={createMutation.loading()}
            loadingLabel={messages().queueingExport}
            disabled={submitDisabled()}
            onClick={() => createMutation.mutate(undefined)}
          >
            {messages().queueExport}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function EvidenceExportsSection(props: { base: PublicBase }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const [refresh, setRefresh] = createSignal(0);
  const [coverageRefresh, setCoverageRefresh] = createSignal(0);
  const coverage = query.create({
    source: coverageRefresh,
    load: async (_, { abortSignal }) => {
      const response = await apiClient["evidence-exports"]["by-base"][":baseId"].preflight.$get(
        { param: { baseId: props.base.id }, query: {} },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().deriveEvidenceCoverageFailed));
      return response.json() as Promise<EvidenceExportPreflight>;
    },
  });
  const jobs = query.create({
    source: refresh,
    load: async (_, { abortSignal }) => {
      const response = await apiClient["evidence-exports"]["by-base"][":baseId"].$get(
        { param: { baseId: props.base.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadEvidenceExportsFailed));
      return response.json();
    },
  });
  const [tables, setTables] = createSignal<PublicTable[]>([]);
  const [opening, setOpening] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => {
      if (jobs.data()?.items.some((item) => ["queued", "running", "cancel_requested"].includes(item.status)))
        setRefresh((value) => value + 1);
    }, 3_000);
  });
  onCleanup(() => timer && clearInterval(timer));

  const open = async () => {
    if (opening()) return;
    setOpening(true);
    try {
      let available = tables();
      if (available.length === 0) {
        const response = await apiClient.tables["by-base"][":baseId"].$get({
          param: { baseId: props.base.id },
          query: {},
        });
        if (!response.ok) throw new Error(await errorMessage(response, messages().loadTablesFailed));
        available = await response.json();
        setTables(available);
      }
      await openEvidenceExportDialog(props.base, available, () => setRefresh((value) => value + 1));
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : messages().openEvidenceExportFailed);
    } finally {
      setOpening(false);
    }
  };

  const mutateJob = async (item: EvidenceExport, action: "retry" | "cancel") => {
    const endpoint = apiClient["evidence-exports"][":exportId"][action];
    const response = await endpoint.$post({ param: { exportId: item.id } });
    if (!response.ok)
      throw new Error(
        await errorMessage(response, action === "retry" ? messages().retryEvidenceExportFailed : messages().cancelEvidenceExportFailed),
      );
    setRefresh((value) => value + 1);
  };
  const exportAction = () => (
    <Button variant="primary" size="sm" loading={opening()} disabled={opening()} onClick={() => void open()}>
      <i class="ti ti-package-export" aria-hidden="true" /> {messages().newExport}
    </Button>
  );

  return (
    <>
      <SettingsGroup class="mb-8" title={messages().availableEvidence} description={messages().availableEvidenceDescription}>
        <SettingsGroup.Action>
          <Button
            variant="secondary"
            size="sm"
            loading={coverage.loading()}
            loadingLabel={messages().checkingCoverage}
            disabled={coverage.loading()}
            onClick={() => setCoverageRefresh((value) => value + 1)}
          >
            {messages().refresh}
          </Button>
        </SettingsGroup.Action>
        <Show
          when={!coverage.loading()}
          fallback={<Placeholder state="loading" variant="compact" title={messages().derivingEvidenceCoverage} />}
        >
          <Show
            when={!coverage.error()}
            fallback={
              <Placeholder
                state="error"
                variant="compact"
                title={messages().evidenceCoverageUnavailable}
                description={coverage.error() instanceof Error ? coverage.error()!.message : messages().deriveEvidenceCoverageFailed}
                action={
                  <Button variant="secondary" size="sm" onClick={() => void coverage.invalidate()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <Show when={coverage.data()} keyed>
              {(preview) => {
                return (
                  <div class="space-y-3">
                    <StatGrid columns={3} size="sm" surface="muted">
                      <StatCell
                        label={messages().records}
                        value={number(preview.known.records)}
                        sub={messages().revisionsCount({ count: number(preview.known.revisions) })}
                      />
                      <StatCell label={messages().auditEvents} value={number(preview.known.auditEvents)} sub={messages().currentScope} />
                      <StatCell
                        label={messages().storedArtifacts}
                        value={number(preview.known.files + preview.known.documents)}
                        sub={messages().bytesStored({ bytes: bytesLabel(preview.known.fileBytes + preview.known.documentBytes, locale()) })}
                      />
                      <StatCell
                        label={messages().files}
                        value={number(preview.known.files)}
                        sub={messages().documentsCount({ count: number(preview.known.documents) })}
                      />
                      <StatCell
                        label={messages().numberSeries}
                        value={number(preview.known.numberSeries)}
                        sub={messages().formatsCount({ count: number(preview.known.numberSeriesVersions) })}
                      />
                      <StatCell
                        label={messages().numberAllocations}
                        value={number(preview.known.numberAllocations)}
                        sub={messages().durableAllocations}
                      />
                    </StatGrid>
                    <div class="flex justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void openEvidenceCoverageDialog(props.base.id, props.base.name, preview.tables)}
                      >
                        {messages().reviewTableCoverage({ count: number(preview.tables.length) })}
                      </Button>
                    </div>
                  </div>
                );
              }}
            </Show>
          </Show>
        </Show>
      </SettingsGroup>
      <Show
        when={!jobs.loading()}
        fallback={
          <SettingsGroup title={messages().evidencePackages} description={messages().evidencePackagesDescription}>
            <SettingsGroup.Action>{exportAction()}</SettingsGroup.Action>
            <Placeholder state="loading" variant="compact" title={messages().loadingEvidenceExports} />
          </SettingsGroup>
        }
      >
        <Show
          when={!jobs.error()}
          fallback={
            <SettingsGroup title={messages().evidencePackages} description={messages().evidencePackagesDescription}>
              <SettingsGroup.Action>{exportAction()}</SettingsGroup.Action>
              <Placeholder
                state="error"
                variant="compact"
                title={messages().evidenceExportsUnavailable}
                description={jobs.error() instanceof Error ? jobs.error()!.message : messages().loadEvidenceExportsFailed}
                action={
                  <Button variant="secondary" size="sm" onClick={() => void jobs.invalidate()}>
                    {messages().retry}
                  </Button>
                }
              />
            </SettingsGroup>
          }
        >
          <SettingsCollection
            title={messages().evidencePackages}
            description={messages().evidencePackagesDescription}
            empty={messages().noEvidenceExports}
          >
            <SettingsCollection.Action>{exportAction()}</SettingsCollection.Action>
            <For each={jobs.data()?.items ?? []}>
              {(item) => (
                <SettingsCollection.Item
                  title={item.tableId ? messages().tableWithId({ id: item.tableId }) : messages().completeBase}
                  description={messages().requestedExport({
                    date: dateLabel(item.requestedAt),
                    expires: item.expiresAt ? dateLabel(item.expiresAt) : "",
                  })}
                  icon={<i class="ti ti-package" aria-hidden="true" />}
                >
                  <SettingsCollection.Item.Status>
                    <StatusBadge tone={STATUS_TONE[item.status]} label={statusLabel(item.status, messages())} icon={null} />
                  </SettingsCollection.Item.Status>
                  <SettingsCollection.Item.Actions>
                    <Show when={item.status === "completed" && item.package}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void download(item, messages().evidencePackageUnavailable).catch((error) => prompts.error(error.message))
                        }
                      >
                        {messages().download}
                      </Button>
                    </Show>
                    <Show when={item.status === "failed" || item.status === "canceled"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void mutateJob(item, "retry").catch((error) => prompts.error(error.message))}
                      >
                        {messages().retry}
                      </Button>
                    </Show>
                    <Show when={item.status === "queued" || item.status === "running"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void mutateJob(item, "cancel").catch((error) => prompts.error(error.message))}
                      >
                        {messages().cancel}
                      </Button>
                    </Show>
                    <Show when={item.error || item.package}>
                      <Button variant="ghost" size="sm" onClick={() => void openPackageDetails(item, locale(), messages())}>
                        {messages().details}
                      </Button>
                    </Show>
                  </SettingsCollection.Item.Actions>
                </SettingsCollection.Item>
              )}
            </For>
          </SettingsCollection>
        </Show>
      </Show>
    </>
  );
}
