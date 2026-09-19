import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  ButtonLink,
  DescriptionList,
  dialogCore,
  Format,
  PanelHeader,
  Paper,
  Placeholder,
  panelDialogFixedOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { CustomAppDocumentPreview } from "../../api/custom-app-published-page";
import type { PublicField as Field, PublicGridFile as GridFile, PublicGridRecord as GridRecord } from "../../api/public-dto";
import type { RecordMutationAudit, TableAuditPolicy } from "../../contracts";
import type { CustomAppBlock } from "../../custom-apps/contracts";
import { recordAuditRequirementFor } from "../../record-audit-policy";
import { downloadPdfResponse } from "../_components/documents/document-download";
import type { PublicDocument } from "../_components/documents/public-document-types";
import { openRecordAuditDialog } from "../_components/records/RecordAuditDialog";
import RecordFileField from "../_components/records/RecordFileField";
import { formatRecordRelativeTime } from "../_components/records/RecordHistorySection";
import { openRecordUpsertDialog, RecordSaveConflictError } from "../_components/records/RecordUpsertDialog";
import { FieldValue } from "../_components/table/FieldValue";
import { fieldDisplayFormat, formatFieldValueText } from "../_components/table/field-value-format";
import { ObjectListValue } from "../_components/table/ObjectListValue";
import { createCalendarDateBase } from "./calendar-date-base";
import DocumentPreviewDialog from "./DocumentPreviewDialog";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

type RecordBlock = Extract<CustomAppBlock, { type: "record" }>;
type CustomAppDocument = PublicDocument & { downloadUrl: string };

const responseMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

export default function RecordDetails(props: {
  block: RecordBlock;
  baseId: string;
  tableName: string;
  auditPolicy: TableAuditPolicy;
  record: GridRecord;
  fields: Field[];
  relationLabels: Record<string, string>;
  updateEndpoint?: string;
  fileEndpoints: Record<string, string>;
  filesByField: Record<string, GridFile[]>;
  documents: CustomAppDocument[];
  documentPreviews?: CustomAppDocumentPreview[];
  dateConfig: DateContext;
  relativeDateBase?: string;
}) {
  const messages = useCustomAppRuntimeMessages();
  const locale = useLocale();
  const relativeDateBase =
    props.block.relativeDates?.length && props.relativeDateBase
      ? createCalendarDateBase(props.relativeDateBase, props.dateConfig.timeZone)
      : () => props.relativeDateBase;
  const preview = (entry: CustomAppDocumentPreview) =>
    dialogCore.open<void>((close) => <DocumentPreviewDialog entry={entry} close={close} />, {
      ...panelDialogFixedOptions,
      panelClassName: `${panelDialogFixedOptions.panelClassName} is-wide grids-document-preview-dialog`,
    });
  const previewActions = () => (
    <div class="flex flex-wrap gap-2">
      <For each={props.documentPreviews ?? []}>
        {(entry) => (
          <Button variant="secondary" onClick={() => void preview(entry)}>
            <i class="ti ti-eye" aria-hidden="true" />
            {messages().previewDocument}: {entry.name}
          </Button>
        )}
      </For>
    </div>
  );
  const [record, setRecord] = createSignal(props.record);
  const [relationLabels, setRelationLabels] = createSignal(props.relationLabels);
  const [saving, setSaving] = createSignal(false);
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null);
  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));
  const displayedFields = props.block.fieldIds.map((fieldId) => fieldsById.get(fieldId)).filter((field): field is Field => Boolean(field));
  const headingField = props.block.heading ? fieldsById.get(props.block.heading.fieldId) : undefined;
  const draftHeading = () => (!record().finalizedAt ? props.block.heading?.title : undefined);
  const documentHeading = () => (props.block.heading?.documentNumber ? props.documents[0]?.number : undefined);
  const headingValue = () =>
    headingField
      ? record().fieldErrors?.[headingField.id] ||
        formatFieldValueText({
          field: headingField,
          value: record().data[headingField.id],
          record: record(),
          relationLabels: relationLabels(),
          dateConfig: props.dateConfig,
          format:
            headingField.type === "date"
              ? (fieldDisplayFormat(headingField) ?? {
                  kind: "date",
                  format: "short",
                  includeTime: headingField.config.includeTime === true,
                })
              : undefined,
          locale: locale(),
        }) ||
        props.block.title ||
        props.tableName
      : undefined;
  const detailFields = displayedFields.filter(
    (field) => field.id !== headingField?.id || ["file", "object_list", "html_template", "longtext"].includes(field.type),
  );
  const fieldGroups: Array<{ kind: "values"; fields: Field[] } | { kind: "objectList"; field: Field }> = [];
  for (const field of detailFields) {
    if (field.type === "object_list") fieldGroups.push({ kind: "objectList", field });
    else {
      const previous = fieldGroups.at(-1);
      if (previous?.kind === "values") previous.fields.push(field);
      else fieldGroups.push({ kind: "values", fields: [field] });
    }
  }
  const relativeDateValue = (field: Field) => {
    const value = record().data[field.id];
    return props.relativeDateBase &&
      props.block.relativeDates?.includes(field.id) &&
      field.type === "date" &&
      field.config.includeTime !== true &&
      !record().fieldErrors?.[field.id] &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : undefined;
  };
  const editableFields = props.block.editableFieldIds
    .map((fieldId) => fieldsById.get(fieldId))
    .filter((field): field is Field => Boolean(field) && field?.type !== "file");
  const editableFieldIds = new Set(props.block.editableFieldIds);

  const edit = async () => {
    if (!props.updateEndpoint || saving()) return;
    let audit: RecordMutationAudit | undefined;
    const current = record();
    const endpoint = props.updateEndpoint;
    await openRecordUpsertDialog({
      mode: "edit",
      fields: editableFields,
      baseId: props.baseId,
      tableName: props.tableName,
      record: current,
      relationLabels: relationLabels(),
      dateConfig: props.dateConfig,
      reloadRecord: async () => {
        const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(await responseMessage(response, messages().updateRecordFailed));
        return response.json();
      },
      beforeSubmit: async (payload, baselineData) => {
        const changedFieldIds = Object.keys(payload).filter(
          (fieldId) => JSON.stringify(payload[fieldId]) !== JSON.stringify(baselineData[fieldId]),
        );
        const requirement = recordAuditRequirementFor(props.auditPolicy, "update", changedFieldIds);
        if (!requirement) {
          audit = undefined;
          return true;
        }
        const answer = await openRecordAuditDialog({
          operation: "update",
          requirement,
          recordTitle: props.block.title ?? props.tableName,
        });
        if (!answer) return false;
        audit = answer;
        return true;
      },
      onSubmit: async (values, version) => {
        setSaving(true);
        try {
          const response = await fetch(endpoint, {
            method: "PATCH",
            headers: { "content-type": "application/json", "If-Match": String(version ?? current.version) },
            body: JSON.stringify({ values, audit }),
          });
          if (!response.ok) {
            const message = await responseMessage(response, messages().updateRecordFailed);
            throw response.status === 409 ? new RecordSaveConflictError(message) : new Error(message);
          }
          const updated = (await response.json()) as GridRecord & { relationLabels?: Record<string, string> };
          setRecord(updated);
          const updatedLabels = updated.relationLabels;
          if (updatedLabels) setRelationLabels((current) => ({ ...current, ...updatedLabels }));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const download = async (document: CustomAppDocument) => {
    if (downloadingId()) return;
    setDownloadingId(document.id);
    try {
      await downloadPdfResponse(await fetch(document.downloadUrl, { headers: { Accept: "application/pdf" } }), document.filename);
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : messages().downloadDocumentFailed);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Dynamic
      component={props.block.layout === "context" ? Paper : "div"}
      class={props.block.layout === "context" ? "custom-app-record-context" : "flex flex-col gap-3"}
    >
      <Show when={headingField || props.block.title || editableFields.length > 0}>
        <div class="flex min-w-0 flex-col gap-1">
          <Show when={headingField && props.block.title}>
            <p class="text-xs font-medium uppercase tracking-wide text-secondary">{props.block.title}</p>
          </Show>
          <PanelHeader
            title={documentHeading() ?? draftHeading() ?? headingValue() ?? props.block.title ?? props.tableName}
            subtitle={documentHeading() || draftHeading() ? headingValue() : undefined}
            as="h2"
            size="md"
            class={
              headingField
                ? props.block.layout === "context"
                  ? "custom-app-record-context-heading"
                  : "custom-app-record-heading"
                : undefined
            }
            actions={
              <>
                <Show when={headingField}>{previewActions()}</Show>
                <Show when={props.updateEndpoint && editableFields.length > 0 && !record().finalizedAt}>
                  <Button variant="secondary" size="sm" disabled={saving()} onClick={() => void edit()}>
                    <i class="ti ti-pencil" aria-hidden="true" />
                    {messages().edit}
                  </Button>
                </Show>
              </>
            }
          />
        </div>
      </Show>
      <For each={fieldGroups}>
        {(group) =>
          group.kind === "values" ? (
            <DescriptionList
              layout={props.block.layout === "summary" ? "rows" : props.block.layout === "context" ? "grid" : props.block.layout}
              class={
                props.block.layout === "summary"
                  ? "custom-app-record-summary"
                  : headingField && props.block.layout === "compact"
                    ? "custom-app-record-facts"
                    : undefined
              }
              columns={headingField ? 2 : 1}
              size="sm"
              items={group.fields.map((field) => ({
                term: field.name,
                description:
                  field.type === "file" && props.fileEndpoints[field.id] ? (
                    <RecordFileField
                      tableId={field.tableId}
                      recordId={record().id}
                      field={field}
                      canWrite={editableFieldIds.has(field.id) && !record().finalizedAt}
                      initialFiles={props.filesByField[field.id] ?? []}
                      endpoint={props.fileEndpoints[field.id]}
                    />
                  ) : (
                    <>
                      <FieldValue
                        field={field}
                        value={record().data[field.id]}
                        record={record()}
                        allFields={props.fields}
                        relationLabels={relationLabels()}
                        dateConfig={props.dateConfig}
                        format={
                          field.type === "date"
                            ? (fieldDisplayFormat(field) ?? {
                                kind: "date",
                                format: "short",
                                includeTime: field.config.includeTime === true,
                              })
                            : undefined
                        }
                        mode="detail"
                        empty="—"
                      />
                      <Show when={relativeDateValue(field)}>
                        {(value) => (
                          <span class="ml-1.5 text-secondary">
                            (<Format.RelativeDate value={value()} base={relativeDateBase()} timeZone={props.dateConfig.timeZone} />)
                          </span>
                        )}
                      </Show>
                    </>
                  ),
              }))}
            />
          ) : (
            <section class="flex min-w-0 flex-col gap-3" aria-label={group.field.name}>
              <Show
                when={!record().fieldErrors?.[group.field.id]}
                fallback={<span class="text-danger">{record().fieldErrors?.[group.field.id]}</span>}
              >
                <Show
                  when={
                    record().data[group.field.id] !== null &&
                    record().data[group.field.id] !== undefined &&
                    record().data[group.field.id] !== ""
                  }
                  fallback="—"
                >
                  <ObjectListValue
                    value={record().data[group.field.id]}
                    config={group.field.config}
                    detail
                    layout="table"
                    ariaLabel={group.field.name}
                    dateConfig={props.dateConfig}
                  />
                </Show>
              </Show>
            </section>
          )
        }
      </For>
      <Show when={props.block.documents && (props.documents.length > 0 || !headingField || !props.documentPreviews?.length)}>
        <section class="flex min-w-0 flex-col gap-3" aria-label={messages().documents}>
          <Show when={!headingField}>{previewActions()}</Show>
          <Show
            when={props.documents.length > 0}
            fallback={
              <Show when={!props.documentPreviews?.length}>
                <Placeholder align="left" class="px-0 py-1" description={messages().noDocuments} />
              </Show>
            }
          >
            <For each={props.documents}>
              {(document) => (
                <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <ButtonLink href={document.downloadUrl} target="_blank" variant="secondary" size="sm" class="max-w-full">
                    <i class="ti ti-file-type-pdf shrink-0" aria-hidden="true" />
                    <span class="truncate">{document.filename}</span>
                    <i class="ti ti-external-link shrink-0" aria-hidden="true" />
                  </ButtonLink>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={messages().downloadFile({ filename: document.filename })}
                    loading={downloadingId() === document.id}
                    loadingLabel={messages().downloadingFile({ filename: document.filename })}
                    disabled={Boolean(downloadingId())}
                    onClick={() => void download(document)}
                  >
                    <i class="ti ti-download" aria-hidden="true" />
                    {messages().downloadPdf}
                  </Button>
                  <span class="text-xs text-dimmed">{formatRecordRelativeTime(document.createdAt, props.dateConfig)}</span>
                </div>
              )}
            </For>
          </Show>
        </section>
      </Show>
    </Dynamic>
  );
}
