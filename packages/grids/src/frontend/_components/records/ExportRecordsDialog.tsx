import {
  Button,
  Checkbox,
  dialogCore,
  MultiSelectInput,
  PanelDialog,
  panelDialogOptions,
  ScrollArea,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field } from "../../../api/public-dto";
import type { ExportBody, RecordQuery } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import { recordMessages } from "./messages";
import { requestRecordExport } from "./record-transfer-client";

type RowState = {
  fieldId: string;
  enabled: boolean;
  label: string;
  relationMode: "ids" | "labels" | "fields";
  targetFieldIds: string[];
};

type OpenArgs = {
  tableId: string;
  fields: Field[];
  query: RecordQuery;
  viewColumns?: { fieldId: string }[];
};

const relationTargetTableId = (field: Field): string | null => {
  if (field.type !== "relation") return null;
  const id = (field.config as { targetTableId?: unknown }).targetTableId;
  return typeof id === "string" ? id : null;
};

const initialRows = (args: OpenArgs): RowState[] => {
  const visible = args.viewColumns?.length ? new Set(args.viewColumns.map((c) => c.fieldId)) : null;
  return args.fields
    .filter((f) => !f.deletedAt)
    .sort((a, b) => a.position - b.position)
    .map((field) => ({
      fieldId: field.id,
      enabled: visible ? visible.has(field.id) : !field.hideInTable,
      label: field.name,
      relationMode: "labels" as const,
      targetFieldIds: [],
    }));
};

const filenameFromDisposition = (header: string | null, fallback: string): string => {
  const match = header?.match(/filename="([^"]+)"/i);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const ExportDialogBody = (props: OpenArgs & { close: () => void }) => {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const [format, setFormat] = createSignal<"csv" | "json">("csv");
  const [delimiter, setDelimiter] = createSignal<"," | ";" | "\t" | "|">(",");
  const [markdown, setMarkdown] = createSignal<"raw" | "html">("raw");
  const [rows, setRows] = createSignal<RowState[]>(initialRows(props));
  const [targetFields, setTargetFields] = createSignal<Record<string, Field[]>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const fieldsById = new Map(props.fields.map((field) => [field.id, field]));

  onMount(() => {
    const targetIds = [...new Set(props.fields.map(relationTargetTableId).filter((id): id is string => !!id))];
    void Promise.all(
      targetIds.map(async (tableId) => {
        const res = await apiClient.fields["by-table"][":tableId"].$get({ param: { tableId } });
        if (!res.ok) return [tableId, []] as const;
        const fields = await res.json();
        return [tableId, fields.filter((f) => !f.deletedAt)] as const;
      }),
    ).then((entries) => setTargetFields(Object.fromEntries(entries)));
  });

  const updateRow = (index: number, patch: Partial<RowState>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const runExport = async () => {
    const selected = rows().filter((row) => row.enabled);
    if (selected.length === 0) {
      setError(t().chooseField);
      return;
    }

    const body: ExportBody = {
      format: format(),
      query: props.query,
      markdown: markdown(),
      csv: { delimiter: delimiter() },
      fields: selected.map((row) => {
        const field = fieldsById.get(row.fieldId);
        return {
          fieldId: row.fieldId,
          label: row.label.trim() || field?.name || t().fields,
          relation:
            field?.type === "relation"
              ? {
                  mode: row.relationMode,
                  fieldIds: row.relationMode === "fields" ? row.targetFieldIds : undefined,
                }
              : undefined,
        };
      }),
    };

    setBusy(true);
    setError(null);
    try {
      const res = await requestRecordExport(props.tableId, body);
      if (!res.ok) throw new Error(await errorMessage(res, t().exportFailed));
      const blob = await res.blob();
      downloadBlob(blob, filenameFromDisposition(res.headers.get("Content-Disposition"), `grids-export.${format()}`));
      props.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : t().exportFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().exportRecords} icon="ti ti-download" close={props.close} />
      <PanelDialog.Body>
        <div class="grid gap-3 sm:grid-cols-3">
          <Select
            label={t().format}
            value={format}
            onValueChange={(value) => setFormat(value as "csv" | "json")}
            options={[
              { id: "csv", label: "CSV" },
              { id: "json", label: "JSON" },
            ]}
          />
          <Show when={format() === "csv"}>
            <Select
              label={t().delimiter}
              value={delimiter}
              onValueChange={(value) => setDelimiter(value as "," | ";" | "\t" | "|")}
              options={[
                { id: ",", label: t().comma },
                { id: ";", label: t().semicolon },
                { id: "\t", label: t().tab },
                { id: "|", label: t().pipe },
              ]}
            />
          </Show>
          <Select
            label={t().markdown}
            value={markdown}
            onValueChange={(value) => setMarkdown(value as "raw" | "html")}
            options={[
              { id: "raw", label: t().keepMarkdown },
              { id: "html", label: t().convertHtml },
            ]}
          />
        </div>

        <PanelDialog.Section title={t().exportFields} subtitle={t().exportFieldsSubtitle} icon="ti ti-columns">
          <ScrollArea class="flex max-h-[46vh] flex-col gap-2">
            <For each={rows()}>
              {(row, index) => {
                const field = fieldsById.get(row.fieldId)!;
                const targetTableId = relationTargetTableId(field);
                const availableTargetFields = () =>
                  targetTableId ? (targetFields()[targetTableId] ?? []).sort((a, b) => a.position - b.position) : [];
                return (
                  <div class="px-1 py-2">
                    <div class="grid gap-2 sm:grid-cols-2 sm:items-start">
                      <Checkbox
                        label={field.name}
                        description={field.type}
                        value={() => row.enabled}
                        onValueChange={(enabled) => updateRow(index(), { enabled })}
                      />
                      <TextInput
                        label={t().columnLabel}
                        value={() => row.label}
                        onValueChange={(label) => updateRow(index(), { label })}
                        disabled={!row.enabled}
                      />
                    </div>
                    <Show when={field.type === "relation" && row.enabled}>
                      <div class="mt-2 grid gap-2 sm:grid-cols-[12rem_1fr]">
                        <Select
                          label={t().relationOutput}
                          value={() => row.relationMode}
                          onValueChange={(relationMode) => updateRow(index(), { relationMode: relationMode as RowState["relationMode"] })}
                          options={[
                            { id: "ids", label: t().ids },
                            { id: "labels", label: t().labels },
                            { id: "fields", label: t().selectedFields },
                          ]}
                        />
                        <Show when={row.relationMode === "fields"}>
                          <MultiSelectInput
                            label={t().targetFields}
                            placeholder={t().chooseFields}
                            icon="ti ti-columns"
                            value={() => row.targetFieldIds}
                            onValueChange={(targetFieldIds) => updateRow(index(), { targetFieldIds })}
                            options={availableTargetFields().map((target) => ({
                              id: target.id,
                              label: target.name,
                              description: target.type,
                              icon: target.icon ?? "ti ti-columns",
                            }))}
                            clearable
                          />
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </ScrollArea>
          <Show when={error()}>
            <p class="text-xs text-red-600 dark:text-red-400">{error()}</p>
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={props.close} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void runExport()} disabled={busy()}>
            <i class={`ti ${busy() ? "ti-loader-2 animate-spin" : "ti-download"} text-sm`} />
            {t().export}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
};

export const openExportRecordsDialog = (args: OpenArgs): Promise<void> =>
  dialogCore.open<void>((close) => <ExportDialogBody {...args} close={close} />, panelDialogOptions);
