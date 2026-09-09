import type { DateContext } from "@k2b/stdlib";
import { Button, DescriptionList, IconButton, PanelHeader, Placeholder, prompts } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
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
  dateConfig: DateContext;
}) {
  const messages = useCustomAppRuntimeMessages();
  const [record, setRecord] = createSignal(props.record);
  const [relationLabels, setRelationLabels] = createSignal(props.relationLabels);
  const [saving, setSaving] = createSignal(false);
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null);
  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));
  const displayedFields = props.block.fieldIds.map((fieldId) => fieldsById.get(fieldId)).filter((field): field is Field => Boolean(field));
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
    <div class="flex flex-col gap-5">
      <PanelHeader
        title={props.block.title ?? props.tableName}
        as="h2"
        size="md"
        actions={
          <Show when={props.updateEndpoint && editableFields.length > 0 && !record().finalizedAt}>
            <Button variant="secondary" size="sm" disabled={saving()} onClick={() => void edit()}>
              <i class="ti ti-pencil" aria-hidden="true" />
              {messages().edit}
            </Button>
          </Show>
        }
      />
      <DescriptionList
        columns={1}
        size="sm"
        items={displayedFields.map((field) => ({
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
              <FieldValue
                field={field}
                value={record().data[field.id]}
                record={record()}
                allFields={props.fields}
                relationLabels={relationLabels()}
                dateConfig={props.dateConfig}
                mode="detail"
                empty="—"
              />
            ),
        }))}
      />
      <Show when={props.block.documents}>
        <section class="flex min-w-0 flex-col gap-3" aria-labelledby={`${props.block.id}-documents`}>
          <PanelHeader title={<span id={`${props.block.id}-documents`}>{messages().documents}</span>} as="h3" size="md" />
          <Show
            when={props.documents.length > 0}
            fallback={<Placeholder align="left" class="px-0 py-1" description={messages().noDocuments} />}
          >
            <DescriptionList
              layout="rows"
              size="sm"
              actionVisibility="progressive"
              items={props.documents.map((document) => ({
                term: (
                  <span class="flex items-center gap-2">
                    <i class="ti ti-file-type-pdf shrink-0 text-base text-secondary" aria-hidden="true" />
                    <span>PDF</span>
                  </span>
                ),
                description: (
                  <span class="flex min-w-0 items-center justify-between gap-3">
                    <span class="truncate text-primary">{document.filename}</span>
                    <span class="shrink-0 text-xs text-dimmed">{formatRecordRelativeTime(document.createdAt, props.dateConfig)}</span>
                  </span>
                ),
                action: (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label={messages().downloadFile({ filename: document.filename })}
                    loading={downloadingId() === document.id}
                    loadingLabel={messages().downloadingFile({ filename: document.filename })}
                    disabled={Boolean(downloadingId())}
                    onClick={() => void download(document)}
                  >
                    <i class="ti ti-download" aria-hidden="true" />
                  </IconButton>
                ),
              }))}
            />
          </Show>
        </section>
      </Show>
    </div>
  );
}
