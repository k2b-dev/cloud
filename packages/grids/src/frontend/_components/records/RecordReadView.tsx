import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import type { DateContext } from "@k2b/stdlib";
import { DescriptionList, DetailPanel, type DropdownItem, StatusBadge, useLocale } from "@k2b/ui";
import { children, For, type JSX, Show } from "solid-js";
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
  baseId: string;
  tableId: string;
  tableName: string;
  fields: Field[];
  record: GridRecord;
  mode?: RecordReadViewMode;
  /** One quiet meta line below the title; defaults to the version and the last change. */
  subtitle?: JSX.Element;
  showFinalizationStatus?: boolean;
  /** The one main action on the record, before "…". */
  primaryAction?: JSX.Element;
  /** Rarer commands in "…"; a live record adds "Copy Cloud ID". */
  menuItems?: readonly DropdownItem[];
  /** The close button beside the kind line. */
  closeAction?: JSX.Element;
  relationLabels?: Record<string, string>;
  fieldsByTable?: Record<string, Field[]>;
  viewColumns?: ColumnSpec[];
  dateConfig?: DateContext;
  renderFileField?: (field: Field, record: GridRecord) => JSX.Element;
  scrollPreserveKey?: string;
  /** State notices right below the header, such as a finalization review. */
  notices?: JSX.Element;
  /** More linked sections after the record's own relations, such as "Referenced by". */
  relationsAfter?: JSX.Element;
  /** More file sections after the record's file fields, such as generated documents. */
  attachmentsAfter?: JSX.Element;
  /** Notes or comments on the record. */
  discussion?: JSX.Element;
  /** Collapsed sections under "More about this record", before the technical details. */
  more?: JSX.Element;
};

const visibleFieldsFor = (fields: Field[]) => fields.filter((field) => !field.deletedAt);

export const hasRecordDetailValue = (value: unknown): boolean => value !== null && value !== undefined && value !== "";

/**
 * A record in the shared details outline: the table and state, the title, field values as rows, long values,
 * linked records, files, notes, and "More about this record" with versions, history, and technical details.
 */
export default function RecordReadView(props: RecordReadViewProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const cloudId = useCloudIdCopy();
  const mode = () => props.mode ?? "live";
  const primaryAction = children(() => props.primaryAction);
  const visibleFields = () => visibleFieldsFor(props.fields);
  const titleField = () => recordTitleField(visibleFields());
  const bodyFields = () => visibleFields().filter((field) => field.id !== titleField()?.id);
  const fieldFormat = (field: Field): FormatSpec | undefined => fieldDisplayFormatForView(field, props.viewColumns);
  const fieldBarcodeFormat = (field: Field): Extract<FormatSpec, { kind: "barcode" }> | undefined => {
    const format = fieldFormat(field);
    return format?.kind === "barcode" ? format : undefined;
  };
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
    bodyFields().filter(
      (field) => !barcodeFieldIds().has(field.id) && !["longtext", "json", "object_list", "file", "relation"].includes(field.type),
    );
  const relationFields = () => bodyFields().filter((field) => field.type === "relation");
  const textBlockFields = () =>
    bodyFields().filter(
      (field) => ["longtext", "json", "object_list"].includes(field.type) && hasRecordDetailValue(props.record.data[field.id]),
    );
  // Long values and barcodes are what people read in a record, so they stand open below the field rows.
  const contentFields = () => [...barcodeFields(), ...textBlockFields()];
  const fileFields = () => bodyFields().filter((field) => field.type === "file");

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
      relationLabels: props.relationLabels,
      locale: locale(),
    });
    return intent.kind === "relation" ? intent.items : [];
  };

  const relationTargetTableId = (field: Field): string | undefined => (field.config as { targetTableId?: string }).targetTableId;

  const menu = (): DropdownItem[] => [
    ...(props.menuItems ?? []),
    ...(mode() === "live" ? cloudId.section({ type: "grids.record", id: props.record.id }) : []),
  ];

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(value));

  const stateBadge = () => {
    if (mode() === "trash") return <StatusBadge tone="warning" icon="ti ti-trash" label={t().deleted} />;
    if (mode() === "snapshot") return <StatusBadge tone="neutral" icon="ti ti-camera" label={t().snapshot} />;
    return (
      <Show when={mode() === "live" && props.showFinalizationStatus}>
        <StatusBadge
          tone={props.record.finalizedAt ? "ok" : "neutral"}
          icon={props.record.finalizedAt ? "ti ti-lock" : "ti ti-pencil"}
          label={props.record.finalizedAt ? t().finalized : t().finalizationDraft}
        />
      </Show>
    );
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

  const technicalItems = () => [
    { term: t().table, description: props.tableName },
    { term: t().recordId, description: <span class="block truncate">{props.record.id}</span> },
    { term: t().versionSection, description: String(props.record.version) },
    { term: t().created, description: formatDate(props.record.createdAt) },
    { term: t().updated, description: formatDate(props.record.updatedAt) },
  ];

  return (
    <DetailPanel>
      <DetailPanel.Header
        kind={
          <>
            <span>{props.tableName}</span>
            {stateBadge()}
          </>
        }
        title={recordTitle()}
        subtitle={props.subtitle ?? t().recordMeta({ version: props.record.version, updated: formatDate(props.record.updatedAt) })}
        menu={menu()}
        menuLabel={t().moreActions}
        actions={props.closeAction}
        primaryActions={primaryAction.toArray().some(Boolean) || menu().length > 0 ? <>{primaryAction()}</> : undefined}
      />
      <DetailPanel.Body scrollPreserveKey={props.scrollPreserveKey}>
        {props.notices}

        <Show when={detailsFields().length > 0 || bodyFields().length === 0}>
          <DetailPanel.Section title={t().fields}>
            <Show when={detailsFields().length > 0} fallback={<p class="grids-details-none">{t().noValues}</p>}>
              <DescriptionList
                layout="rows"
                size="sm"
                items={detailsFields().map((field) => ({
                  term: <span title={field.description ?? undefined}>{field.name}</span>,
                  description: <span class="min-w-0 break-words text-primary">{renderField(field, props.record)}</span>,
                }))}
              />
            </Show>
          </DetailPanel.Section>
        </Show>

        <For each={contentFields()}>
          {(field) => (
            <DetailPanel.Section title={field.name} description={field.description ?? undefined}>
              <div class="break-words text-sm leading-relaxed text-secondary">{renderField(field, props.record)}</div>
            </DetailPanel.Section>
          )}
        </For>

        <Show when={relationFields().length > 0}>
          <DetailPanel.Section title={t().linked}>
            <Show
              when={mode() !== "snapshot"}
              fallback={
                <DescriptionList
                  layout="rows"
                  size="sm"
                  items={relationFields().map((field) => ({
                    term: field.name,
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
                  const items = () => relationItems(field);
                  const targetTableId = relationTargetTableId(field);
                  return (
                    <Show
                      when={items().length > 0 && targetTableId ? targetTableId : undefined}
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
                        <For each={items()}>
                          {(item) => (
                            <DetailPanel.Action
                              href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(
                                resolvedTableId(),
                              )}?record=${encodeURIComponent(item.id)}`}
                              title={`${field.name} · ${item.label}`}
                              description={field.description ?? undefined}
                              leading={<i class={fieldTypeIcon(field.type, field.icon)} aria-hidden="true" />}
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

        <Show when={fileFields().length > 0}>
          <DetailPanel.Section title={t().files}>
            <div class="flex flex-col gap-3">
              <For each={fileFields()}>
                {(field) => (
                  <div class="min-w-0">
                    <Show when={fileFields().length > 1 || field.description}>
                      <p class="grids-details-field-label" title={field.description ?? undefined}>
                        {fileFields().length > 1 ? field.name : field.description}
                      </p>
                    </Show>
                    {renderField(field, props.record)}
                  </div>
                )}
              </For>
            </div>
          </DetailPanel.Section>
        </Show>
        {props.attachmentsAfter}

        {props.discussion}

        <DetailPanel.Group title={t().moreAboutRecord}>
          {props.more}
          <DetailPanel.Section title={t().technicalDetails} collapsible summary={t().technicalSummary}>
            <DescriptionList layout="rows" size="sm" items={technicalItems()} />
          </DetailPanel.Section>
        </DetailPanel.Group>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
