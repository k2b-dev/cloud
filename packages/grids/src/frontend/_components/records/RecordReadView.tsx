import type { DateContext } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/solid";
import { DescriptionList, DetailPanel, IconButton, Placeholder, StatusBadge, Tooltip, useLocale } from "@k2b/ui";
import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { ColumnSpec, FormatSpec } from "../../../contracts";
import { effectiveDisplayField } from "../../../lookup-display";
import { fieldTypeIcon } from "../fields/field-type-meta";
import { barcodeValueText, canRenderBarcode } from "../table/BarcodeRendering";
import { FieldValue } from "../table/FieldValue";
import { resolveFieldDisplay } from "../table/field-display";
import { recordMessages } from "./messages";
import { fieldDisplayFormatForView, recordDisplayTitle, recordTitleField } from "./record-display";

type RecordReadViewMode = "live" | "trash" | "snapshot";

type RecordReadViewProps = {
  cloudUrl: string;
  baseId: string;
  tableId: string;
  tableName: string;
  fields: Field[];
  record: GridRecord;
  mode?: RecordReadViewMode;
  headerMeta?: JSX.Element;
  showFinalizationStatus?: boolean;
  headerActions?: JSX.Element;
  quickActions?: JSX.Element;
  relationLabels?: Record<string, string>;
  fieldsByTable?: Record<string, Field[]>;
  viewColumns?: ColumnSpec[];
  dateConfig?: DateContext;
  renderFileField?: (field: Field, record: GridRecord) => JSX.Element;
  scrollPreserveKey?: string;
  relationsAfter?: JSX.Element;
  children?: JSX.Element;
};

const visibleFieldsFor = (fields: Field[]) => fields.filter((field) => !field.deletedAt);

export const hasRecordDetailValue = (value: unknown): boolean => value !== null && value !== undefined && value !== "";

export default function RecordReadView(props: RecordReadViewProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const recordClipboard = clipboard.createWriter({ write: cloudResourceClipboard.write, copiedFor: 1800 });
  const mode = () => props.mode ?? "live";
  const visibleFields = () => visibleFieldsFor(props.fields);
  const titleField = () => recordTitleField(visibleFields());
  const bodyFields = () => visibleFields().filter((field) => field.id !== titleField()?.id);
  const fieldFormat = (field: Field): FormatSpec | undefined => fieldDisplayFormatForView(field, props.viewColumns);
  const fieldBarcodeFormat = (field: Field): Extract<FormatSpec, { kind: "barcode" }> | undefined => {
    const format = fieldFormat(field);
    return format?.kind === "barcode" ? format : undefined;
  };
  const isComputedField = (field: Field) => ["formula", "lookup", "rollup", "html_template"].includes(field.type);
  const isBarcodeDisplayField = (field: Field, record: GridRecord) => {
    const format = fieldBarcodeFormat(field);
    return Boolean(
      format &&
        canRenderBarcode(effectiveDisplayField(field, props.fieldsByTable).type) &&
        barcodeValueText(record.data[field.id]).trim().length > 0,
    );
  };
  const barcodeFields = () => bodyFields().filter((field) => isBarcodeDisplayField(field, props.record));
  const barcodeFieldIds = () => new Set(barcodeFields().map((field) => field.id));
  const detailsFields = () =>
    bodyFields().filter((field) => !barcodeFieldIds().has(field.id) && !["longtext", "json", "file", "relation"].includes(field.type));
  const relationFields = () => bodyFields().filter((field) => field.type === "relation");
  const textBlockFields = () =>
    bodyFields().filter((field) => ["longtext", "json"].includes(field.type) && hasRecordDetailValue(props.record.data[field.id]));
  const fileFields = () => bodyFields().filter((field) => field.type === "file");
  const hasFieldSections = () =>
    barcodeFields().length > 0 || detailsFields().length > 0 || textBlockFields().length > 0 || fileFields().length > 0;

  const renderField = (field: Field, record: GridRecord) => {
    if (field.type === "file" && props.renderFileField) return props.renderFileField(field, record);
    return (
      <FieldValue
        field={field}
        value={record.data[field.id]}
        record={record}
        allFields={props.fields}
        baseId={props.baseId}
        fieldsByTable={props.fieldsByTable}
        relationLabels={props.relationLabels}
        dateConfig={props.dateConfig}
        format={fieldFormat(field)}
        mode="detail"
        empty="—"
        linkLookup={mode() !== "snapshot"}
        showBarcodeOpenAction={mode() !== "snapshot"}
      />
    );
  };

  const relationItems = (field: Field) => {
    const intent = resolveFieldDisplay({
      field,
      value: props.record.data[field.id],
      record: props.record,
      relationLabels: props.relationLabels,
      locale: locale(),
    });
    return intent.kind === "relation" ? intent.items : [];
  };

  const relationTargetTableId = (field: Field): string | undefined => (field.config as { targetTableId?: string }).targetTableId;

  const recordHref = () =>
    `/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(props.tableId)}?record=${encodeURIComponent(props.record.id)}`;
  const copyRecord = () =>
    recordClipboard.copy({
      cloudUrl: props.cloudUrl,
      ref: { type: "grids.record" as const, id: props.record.id },
      fallbackText: new URL(recordHref(), props.cloudUrl).href,
    });
  const copyRecordLabel = () => {
    if (recordClipboard.error()) return t().copyReferenceFailed;
    return recordClipboard.wasCopied() ? t().copiedReference : t().copyReference;
  };

  const defaultHeaderMeta = () => (
    <>
      <Show when={mode() === "trash"}>
        <span class="inline-flex items-center gap-1 text-[0.6875rem] leading-4 text-amber-600 dark:text-amber-400">
          <i class="ti ti-trash" aria-hidden="true" /> {t().deleted}
        </span>
      </Show>
      <Show when={mode() === "snapshot"}>
        <span class="inline-flex items-center gap-1 text-[0.6875rem] leading-4 text-blue-600 dark:text-blue-400">
          <i class="ti ti-camera" aria-hidden="true" /> {t().snapshot}
        </span>
      </Show>
      <Show when={mode() === "live" && props.showFinalizationStatus}>
        <StatusBadge
          variant="text"
          tone={props.record.finalizedAt ? "ok" : "neutral"}
          icon={props.record.finalizedAt ? "ti ti-lock" : "ti ti-pencil"}
          label={props.record.finalizedAt ? t().finalized : t().finalizationDraft}
        />
      </Show>
      <span class="text-[0.6875rem] leading-4 text-dimmed">v{props.record.version}</span>
      <span class="text-[0.6875rem] leading-4 text-dimmed">{props.record.id}</span>
      <Tooltip.Anchor content={copyRecordLabel()}>
        <IconButton type="button" variant="ghost" size="xs" class="h-5! w-5!" label={copyRecordLabel()} onClick={() => void copyRecord()}>
          <i
            class={recordClipboard.error() ? "ti ti-alert-circle text-danger" : recordClipboard.wasCopied() ? "ti ti-check" : "ti ti-copy"}
            aria-hidden="true"
          />
        </IconButton>
      </Tooltip.Anchor>
    </>
  );

  const identityIcon = () => {
    if (mode() === "snapshot") return "ti ti-camera";
    if (mode() === "trash") return "ti ti-trash";
    return "ti ti-table-row";
  };
  const recordTitle = () =>
    recordDisplayTitle({
      fields: props.fields,
      record: props.record,
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      viewColumns: props.viewColumns,
    });

  const fieldTerm = (field: Field, includeDescription = false) => (
    <span class="flex min-w-0 items-start gap-1.5">
      <span class="flex h-5 w-4 shrink-0 items-center" aria-hidden="true">
        <i class={`${fieldTypeIcon(field.type, field.icon)} ${isComputedField(field) ? "text-blue-600 dark:text-blue-400" : ""}`} />
      </span>
      <span class="min-w-0">
        <span class="block break-words">{field.name}</span>
        <Show when={includeDescription && field.description}>
          {(description) => <span class="mt-0.5 block text-[11px] font-normal leading-snug text-dimmed">{description()}</span>}
        </Show>
      </span>
    </span>
  );

  return (
    <DetailPanel>
      <DetailPanel.Header
        icon={identityIcon()}
        title={recordTitle()}
        subtitle={props.tableName}
        meta={props.headerMeta ?? defaultHeaderMeta()}
        actions={props.headerActions}
        primaryActions={props.quickActions}
      />
      <DetailPanel.Body scrollPreserveKey={props.scrollPreserveKey}>
        <Show when={hasFieldSections()}>
          <For each={barcodeFields()}>
            {(field) => (
              <DetailPanel.Group label={t().fieldGroup({ name: field.name })}>
                <DetailPanel.Section title={field.name} icon={fieldTypeIcon(field.type, field.icon)}>
                  {renderField(field, props.record)}
                </DetailPanel.Section>
              </DetailPanel.Group>
            )}
          </For>
          <Show when={detailsFields().length > 0}>
            <DetailPanel.Group label={t().recordFields}>
              <DetailPanel.Section title={t().fields} icon="ti ti-list-details">
                <DescriptionList
                  layout="rows"
                  size="sm"
                  items={detailsFields().map((field) => ({
                    term: fieldTerm(field),
                    description: <span class="min-w-0 break-words text-primary">{renderField(field, props.record)}</span>,
                  }))}
                />
              </DetailPanel.Section>
            </DetailPanel.Group>
          </Show>
          <For each={textBlockFields()}>
            {(field) => (
              <DetailPanel.Group label={t().fieldGroup({ name: field.name })}>
                <DetailPanel.Section title={field.name} icon={fieldTypeIcon(field.type, field.icon)}>
                  <div class="break-words text-sm leading-relaxed text-secondary">{renderField(field, props.record)}</div>
                </DetailPanel.Section>
              </DetailPanel.Group>
            )}
          </For>
          <Show when={fileFields().length > 0}>
            <DetailPanel.Group label={t().recordFiles}>
              <DetailPanel.Section title={t().files} icon="ti ti-paperclip">
                <div class="flex flex-col gap-4">
                  <For each={fileFields()}>
                    {(field) => (
                      <div class="min-w-0">
                        <div class="text-xs text-dimmed">{fieldTerm(field, true)}</div>
                        <div class="mt-2 min-w-0 break-words text-sm text-secondary">{renderField(field, props.record)}</div>
                      </div>
                    )}
                  </For>
                </div>
              </DetailPanel.Section>
            </DetailPanel.Group>
          </Show>
        </Show>

        <Show when={bodyFields().length === 0}>
          <DetailPanel.Group label={t().recordFields}>
            <DetailPanel.Section title={t().fields} icon="ti ti-list-details">
              <Placeholder align="left" description={<>{t().noValues}</>} />
            </DetailPanel.Section>
          </DetailPanel.Group>
        </Show>

        <Show when={relationFields().length > 0 || props.relationsAfter !== undefined}>
          <DetailPanel.Group label={t().relationships}>
            <Show when={relationFields().length > 0}>
              <DetailPanel.Section title={t().relations} icon="ti ti-link" tone="accent">
                <Show
                  when={mode() !== "snapshot"}
                  fallback={
                    <DescriptionList
                      layout="rows"
                      size="sm"
                      items={relationFields().map((field) => ({
                        term: fieldTerm(field),
                        description:
                          relationItems(field)
                            .map((item) => item.label)
                            .join(", ") || "—",
                      }))}
                    />
                  }
                >
                  <For each={relationFields()}>
                    {(field) => {
                      const items = relationItems(field);
                      const targetTableId = relationTargetTableId(field);
                      return (
                        <Show
                          when={items.length > 0 && targetTableId ? targetTableId : undefined}
                          fallback={
                            <DetailPanel.Action
                              type="button"
                              disabled
                              title={`${field.name} · —`}
                              description={field.description ?? undefined}
                              leading={<i class={fieldTypeIcon(field.type, field.icon)} aria-hidden="true" />}
                            />
                          }
                        >
                          {(resolvedTableId) => (
                            <For each={items}>
                              {(item) => (
                                <DetailPanel.Action
                                  href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(
                                    resolvedTableId(),
                                  )}?record=${encodeURIComponent(item.id)}`}
                                  title={`${field.name} · ${item.label}`}
                                  description={field.description ?? undefined}
                                  leading={<i class={fieldTypeIcon(field.type, field.icon)} aria-hidden="true" />}
                                  trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                                />
                              )}
                            </For>
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </Show>
              </DetailPanel.Section>
            </Show>
            {props.relationsAfter}
          </DetailPanel.Group>
        </Show>
        {props.children}
      </DetailPanel.Body>
    </DetailPanel>
  );
}
