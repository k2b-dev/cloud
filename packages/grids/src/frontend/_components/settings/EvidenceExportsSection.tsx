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

const SECTION_OPTIONS: Array<{ id: EvidenceExportSection; label: string; description: string; icon: string }> = [
  { id: "records", label: "Records", description: "Current and deleted stored Records at the export cut.", icon: "ti ti-table" },
  {
    id: "revisions",
    label: "Durable History",
    description: "Available immutable Record revisions and schema meaning.",
    icon: "ti ti-history",
  },
  { id: "audit", label: "Audit", description: "Mutation events, actors, answers, and request context.", icon: "ti ti-activity" },
  {
    id: "schema",
    label: "Schema and configuration",
    description: "Tables, fields, policies, templates, and schema snapshots.",
    icon: "ti ti-settings",
  },
  {
    id: "relations",
    label: "Relations",
    description: "Current links plus historical relation state inside revisions.",
    icon: "ti ti-link",
  },
  { id: "files", label: "Files", description: "Current and revision-protected attachment bytes with hashes.", icon: "ti ti-paperclip" },
  {
    id: "documents",
    label: "Document artifacts",
    description: "Exact stored PDF bytes, snapshots, and renderer metadata.",
    icon: "ti ti-file-type-pdf",
  },
  { id: "numbers", label: "Number allocations", description: "Series, format versions, and allocated values.", icon: "ti ti-number" },
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

const statusLabel = (status: EvidenceExport["status"]): string => status.replaceAll("_", " ");
const dateLabel = (value: string): string => new Date(value).toLocaleString();
const bytesLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const verificationCommand = (item: EvidenceExport): string | null =>
  item.package
    ? `cld grids evidence verify ${item.package.filename} --sha256 ${item.package.sha256} --manifest-sha256 ${item.package.manifestSha256}`
    : null;

const openPackageDetails = (item: EvidenceExport) =>
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
                { term: "Filename", description: pkg.filename },
                { term: "Size", description: bytesLabel(pkg.sizeBytes) },
                { term: "Package SHA-256", description: <code class="break-all text-xs">{pkg.sha256}</code> },
                { term: "Manifest SHA-256", description: <code class="break-all text-xs">{pkg.manifestSha256}</code> },
                {
                  term: "Offline verification",
                  description: <code class="break-all text-xs">{verificationCommand(item)}</code>,
                  action: (
                    <CopyButton
                      text={verificationCommand(item)!}
                      label="Copy command"
                      copiedLabel="Verification command copied"
                      variant="secondary"
                      size="sm"
                      onCopyError={() => prompts.error("Could not copy the verification command")}
                    />
                  ),
                },
              ]}
            />
          )}
        </Show>
      </div>
    ),
    { title: "Package details", icon: "ti ti-package", size: "medium" },
  );

const requestRange = (range: { start: string | null; end: string | null }) => ({
  from: range.start ? `${range.start}T00:00:00.000Z` : undefined,
  to: range.end ? `${range.end}T23:59:59.999Z` : undefined,
});

const download = async (item: EvidenceExport) => {
  const response = await fetch(`/api/grids/evidence-exports/${encodeURIComponent(item.id)}/download`);
  if (!response.ok) throw new Error(await errorMessage(response, "Evidence package is unavailable"));
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not estimate evidence scope"));
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not start evidence export"));
      return response.json();
    },
    onSuccess: () => {
      toast.success("Evidence export queued");
      props.onCreated();
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });

  const submitDisabled = () => sections().length === 0 || preflight.loading() || !currentPreflight()?.withinKnownBudgets;

  return (
    <PanelDialog>
      <PanelDialog.Header title="New evidence export" subtitle={props.base.name} icon="ti ti-package-export" close={props.close} />
      <PanelDialog.Body>
        <NoticeCard
          tone="info"
          title="A verifiable package, not a compliance certificate"
          detail="The manifest states exactly which current and historical sources are available. Grids does not reconstruct missing history or claim legal compliance."
        />
        <div class="grid gap-3 sm:grid-cols-2">
          <Select
            label="Scope"
            description="Choose the complete Base or one Table."
            value={tableId}
            onValueChange={(value) => setTableId(value ?? "")}
            options={[{ id: "", label: "Complete Base" }, ...props.tables.map((table) => ({ id: table.id, label: table.name }))]}
          />
          <DateRangePicker
            label="Period"
            description="Optional. Limits dated evidence; current Records are always included."
            value={range}
            onValueChange={setRange}
            clearable
          />
        </div>
        <PanelDialog.Section title="Included evidence" subtitle="Everything is selected by default." icon="ti ti-list-check">
          <div class="grid gap-2 sm:grid-cols-2">
            <For each={SECTION_OPTIONS}>
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
          <Placeholder state="loading" variant="compact" title="Checking known scope" />
        </Show>
        <Show when={preflight.error()}>
          <Placeholder
            state="error"
            variant="compact"
            title="Scope could not be checked"
            description={preflight.error() instanceof Error ? preflight.error()!.message : "Preflight failed"}
            action={
              <Button variant="secondary" size="sm" onClick={() => void preflight.invalidate()}>
                Retry
              </Button>
            }
          />
        </Show>
        <Show when={currentPreflight()} keyed>
          {(preview) => (
            <NoticeCard
              tone={preview.withinKnownBudgets ? (preview.warnings.length > 0 ? "warning" : "success") : "danger"}
              title={preview.withinKnownBudgets ? "Known scope fits the export budgets" : "Known scope is too large"}
              detail={`${preview.known.records} Records · ${preview.known.revisions} revisions · ${preview.known.documents} Documents · ${bytesLabel(
                preview.known.fileBytes + preview.known.documentBytes,
              )} known bytes`}
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
        <span class="text-xs text-muted">Packages expire after seven days.</span>
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={props.close} disabled={createMutation.loading()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={createMutation.loading()}
            loadingLabel="Queueing export"
            disabled={submitDisabled()}
            onClick={() => createMutation.mutate(undefined)}
          >
            Queue export
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function EvidenceExportsSection(props: { base: PublicBase }) {
  const [refresh, setRefresh] = createSignal(0);
  const [coverageRefresh, setCoverageRefresh] = createSignal(0);
  const coverage = query.create({
    source: coverageRefresh,
    load: async (_, { abortSignal }) => {
      const response = await apiClient["evidence-exports"]["by-base"][":baseId"].preflight.$get(
        { param: { baseId: props.base.id }, query: {} },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not derive evidence coverage"));
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load evidence exports"));
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
        if (!response.ok) throw new Error(await errorMessage(response, "Could not load tables"));
        available = await response.json();
        setTables(available);
      }
      await openEvidenceExportDialog(props.base, available, () => setRefresh((value) => value + 1));
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : "Could not open evidence export");
    } finally {
      setOpening(false);
    }
  };

  const mutateJob = async (item: EvidenceExport, action: "retry" | "cancel") => {
    const endpoint = apiClient["evidence-exports"][":exportId"][action];
    const response = await endpoint.$post({ param: { exportId: item.id } });
    if (!response.ok) throw new Error(await errorMessage(response, `Could not ${action} evidence export`));
    setRefresh((value) => value + 1);
  };
  const exportAction = () => (
    <Button variant="primary" size="sm" loading={opening()} disabled={opening()} onClick={() => void open()}>
      <i class="ti ti-package-export" aria-hidden="true" /> New export
    </Button>
  );

  return (
    <>
      <SettingsGroup
        class="mb-8"
        title="Available evidence"
        description="Live coverage derived from stored Grids data. This check changes nothing and is not a compliance assessment."
      >
        <SettingsGroup.Action>
          <Button
            variant="secondary"
            size="sm"
            loading={coverage.loading()}
            loadingLabel="Checking coverage"
            disabled={coverage.loading()}
            onClick={() => setCoverageRefresh((value) => value + 1)}
          >
            Refresh
          </Button>
        </SettingsGroup.Action>
        <Show when={!coverage.loading()} fallback={<Placeholder state="loading" variant="compact" title="Deriving evidence coverage" />}>
          <Show
            when={!coverage.error()}
            fallback={
              <Placeholder
                state="error"
                variant="compact"
                title="Evidence coverage is unavailable"
                description={coverage.error() instanceof Error ? coverage.error()!.message : "Could not derive evidence coverage"}
                action={
                  <Button variant="secondary" size="sm" onClick={() => void coverage.invalidate()}>
                    Retry
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
                      <StatCell label="Records" value={preview.known.records} sub={`${preview.known.revisions} revisions`} />
                      <StatCell label="Audit events" value={preview.known.auditEvents} sub="Current scope" />
                      <StatCell
                        label="Stored artifacts"
                        value={preview.known.files + preview.known.documents}
                        sub={`${bytesLabel(preview.known.fileBytes + preview.known.documentBytes)} stored`}
                      />
                      <StatCell label="Files" value={preview.known.files} sub={`${preview.known.documents} Documents`} />
                      <StatCell
                        label="Number Series"
                        value={preview.known.numberSeries}
                        sub={`${preview.known.numberSeriesVersions} formats`}
                      />
                      <StatCell label="Number allocations" value={preview.known.numberAllocations} sub="Durable allocations" />
                    </StatGrid>
                    <div class="flex justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void openEvidenceCoverageDialog(props.base.id, props.base.name, preview.tables)}
                      >
                        Review Table coverage ({preview.tables.length})
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
          <SettingsGroup
            title="Evidence packages"
            description="Create bounded, hash-verifiable exports from the evidence Grids actually has. Ordinary CSV and JSON exports are unchanged."
          >
            <SettingsGroup.Action>{exportAction()}</SettingsGroup.Action>
            <Placeholder state="loading" variant="compact" title="Loading evidence exports" />
          </SettingsGroup>
        }
      >
        <Show
          when={!jobs.error()}
          fallback={
            <SettingsGroup
              title="Evidence packages"
              description="Create bounded, hash-verifiable exports from the evidence Grids actually has. Ordinary CSV and JSON exports are unchanged."
            >
              <SettingsGroup.Action>{exportAction()}</SettingsGroup.Action>
              <Placeholder
                state="error"
                variant="compact"
                title="Evidence exports are unavailable"
                description={jobs.error() instanceof Error ? jobs.error()!.message : "Could not load evidence exports"}
                action={
                  <Button variant="secondary" size="sm" onClick={() => void jobs.invalidate()}>
                    Retry
                  </Button>
                }
              />
            </SettingsGroup>
          }
        >
          <SettingsCollection
            title="Evidence packages"
            description="Create bounded, hash-verifiable exports from the evidence Grids actually has. Ordinary CSV and JSON exports are unchanged."
            empty="No evidence exports yet."
          >
            <SettingsCollection.Action>{exportAction()}</SettingsCollection.Action>
            <For each={jobs.data()?.items ?? []}>
              {(item) => (
                <SettingsCollection.Item
                  title={item.tableId ? `Table ${item.tableId}` : "Complete Base"}
                  description={`Requested ${dateLabel(item.requestedAt)}${item.expiresAt ? ` · expires ${dateLabel(item.expiresAt)}` : ""}`}
                  icon={<i class="ti ti-package" aria-hidden="true" />}
                >
                  <SettingsCollection.Item.Status>
                    <StatusBadge tone={STATUS_TONE[item.status]} label={statusLabel(item.status)} icon={null} />
                  </SettingsCollection.Item.Status>
                  <SettingsCollection.Item.Actions>
                    <Show when={item.status === "completed" && item.package}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void download(item).catch((error) => prompts.error(error.message))}
                      >
                        Download
                      </Button>
                    </Show>
                    <Show when={item.status === "failed" || item.status === "canceled"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void mutateJob(item, "retry").catch((error) => prompts.error(error.message))}
                      >
                        Retry
                      </Button>
                    </Show>
                    <Show when={item.status === "queued" || item.status === "running"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void mutateJob(item, "cancel").catch((error) => prompts.error(error.message))}
                      >
                        Cancel
                      </Button>
                    </Show>
                    <Show when={item.error || item.package}>
                      <Button variant="ghost" size="sm" onClick={() => void openPackageDetails(item)}>
                        Details
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
