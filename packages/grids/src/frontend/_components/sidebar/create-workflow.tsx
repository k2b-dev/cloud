import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  MultiSelectInput,
  NoticeCard,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Select,
  useLocale,
} from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field, PublicTable as Table } from "../../../api/public-dto";
import { type CorrectionDraftIntent, isCorrectionPrefillFieldType, MAX_CORRECTION_PREFILL_FIELDS } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import { WorkflowEditor } from "../workflows/WorkflowEditor";
import { closeSelectionWorkflowStarter, correctionDraftWorkflowStarter, type WorkflowStarter } from "../workflows/workflow-starters";
import type { PublicWorkflow } from "../workspace/workspace-public-state-model";
import { type SidebarMessages, sidebarMessages } from "./messages";

type StarterChoice =
  | { kind: "blank" }
  | { kind: "closeSelection"; tableId: string }
  | {
      kind: "correctionDraft";
      tableId: string;
      intent: CorrectionDraftIntent;
      typeFieldId: string;
      typeValue: string;
      originalFieldId: string;
      copyFieldIds: string[];
    };

const selectOptions = (field: Field | undefined): Array<{ id: string; label: string }> => {
  if (field?.type !== "select" || field.config.multiple === true || !Array.isArray(field.config.options)) return [];
  return field.config.options.flatMap((option) =>
    option && typeof option === "object" && typeof option.id === "string" && typeof option.label === "string"
      ? [{ id: option.id, label: option.label }]
      : [],
  );
};

function WorkflowStarterDialog(props: {
  tables: Table[];
  fieldsByTable: Record<string, Field[]>;
  close: (choice?: StarterChoice) => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
  t: SidebarMessages;
}) {
  const t = props.t;
  const [starter, setStarter] = createSignal<"closeSelection" | "correctionDraft">();
  const storedTables = () => props.tables.filter((table) => table.kind === "stored");
  const [tableId, setTableId] = createSignal(storedTables()[0]?.id ?? "");
  const tableFields = () => props.fieldsByTable[tableId()] ?? [];
  const typeFields = () => tableFields().filter((field) => selectOptions(field).length > 0);
  const relationFields = () =>
    tableFields().filter(
      (field) =>
        field.type === "relation" && field.config.targetTableId === tableId() && (field.config.cardinality ?? "multiple") === "single",
    );
  const [typeFieldId, setTypeFieldId] = createSignal("");
  const [correctionIntent, setCorrectionIntent] = createSignal<CorrectionDraftIntent>("correction");
  const [typeValue, setTypeValue] = createSignal("");
  const [originalFieldId, setOriginalFieldId] = createSignal("");
  const [copyFieldIds, setCopyFieldIds] = createSignal<string[]>([]);
  const copyFields = () =>
    tableFields().filter((field) => field.id !== typeFieldId() && !field.uniqueConstraint && isCorrectionPrefillFieldType(field.type));
  const typeValues = () => selectOptions(typeFields().find((field) => field.id === typeFieldId()));
  const chooseTable = (nextTableId: string | null) => {
    setTableId(nextTableId ?? "");
    setTypeFieldId("");
    setTypeValue("");
    setOriginalFieldId("");
    setCopyFieldIds([]);
  };
  const snapshot = () => JSON.stringify([tableId(), typeFieldId(), correctionIntent(), typeValue(), originalFieldId(), copyFieldIds()]);
  const initialSnapshot = snapshot();
  const closeIfClean = async () => {
    if (await confirmDiscardIfDirty(() => snapshot() !== initialSnapshot)) props.close();
  };
  props.setDismissHandler(closeIfClean);
  return (
    <PanelDialog>
      <PanelDialog.Header title={t.newWorkflow} subtitle={t.newWorkflowSubtitle} icon="ti ti-route" close={() => void closeIfClean()} />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <Show when={!starter()}>
            <Button variant="input" class="grids-workflow-choice" onClick={() => props.close({ kind: "blank" })}>
              <i class="ti ti-file-plus" />
              <span class="flex min-w-0 flex-col gap-1">
                <span>{t.blankWorkflow}</span>
                <span class="text-sm font-normal text-dimmed">{t.blankWorkflowDescription}</span>
              </span>
            </Button>
            <Button variant="input" class="grids-workflow-choice" onClick={() => setStarter("closeSelection")}>
              <i class="ti ti-list-check" />
              <span class="flex min-w-0 flex-col gap-1">
                <span>{t.closeSelectedRecords}</span>
                <span class="text-sm font-normal text-dimmed">{t.closeSelectedRecordsDescription}</span>
              </span>
            </Button>
            <Button variant="input" class="grids-workflow-choice" onClick={() => setStarter("correctionDraft")}>
              <i class="ti ti-file-delta" />
              <span class="flex min-w-0 flex-col gap-1">
                <span>{t.createCorrectionDraft}</span>
                <span class="text-sm font-normal text-dimmed">{t.createCorrectionDraftDescription}</span>
              </span>
            </Button>
          </Show>
          <Show when={starter()}>
            <Button variant="ghost" class="self-start" onClick={() => setStarter(undefined)}>
              <i class="ti ti-arrow-left" />
              {t.changeStarter}
            </Button>
          </Show>
          <Show when={starter() === "closeSelection"}>
            <section class="flex flex-col gap-3">
              <div>
                <h3 class="font-semibold">{t.closeSelectedRecords}</h3>
                <p class="text-sm text-dimmed">{t.closeSelectedRecordsDescription}</p>
              </div>
              <Select
                label={t.table}
                description={t.durableHistoryRequired}
                options={storedTables().map((table) => ({ id: table.id, label: table.name }))}
                value={tableId}
                onValueChange={chooseTable}
                required
              />
              <Show when={storedTables().length === 0}>
                <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                  {t.noStoredTable}
                </NoticeCard>
              </Show>
              <div class="flex justify-end">
                <Button
                  variant="primary"
                  type="button"
                  disabled={!tableId()}
                  onClick={() => props.close({ kind: "closeSelection", tableId: tableId() })}
                >
                  <i class="ti ti-list-check" /> {t.useStarter}
                </Button>
              </div>
            </section>
          </Show>
          <Show when={starter() === "correctionDraft"}>
            <section class="flex flex-col gap-3">
              <div>
                <h3 class="font-semibold">{t.createCorrectionDraft}</h3>
                <p class="text-sm text-dimmed">{t.createCorrectionDraftDescription}</p>
              </div>
              <Select
                label={t.action}
                description={t.actionDescription}
                options={[
                  {
                    id: "correction",
                    label: t.correction,
                    description: t.correctionDescription,
                    icon: "ti ti-file-pencil",
                  },
                  {
                    id: "cancellation",
                    label: t.cancellation,
                    description: t.cancellationDescription,
                    icon: "ti ti-file-off",
                  },
                ]}
                value={correctionIntent}
                onValueChange={(value) => {
                  if (value === "correction" || value === "cancellation") setCorrectionIntent(value);
                }}
                required
              />
              <Show when={correctionIntent() === "cancellation"}>
                <NoticeCard tone="info" icon="ti ti-info-circle">
                  {t.cancellationNotice}
                </NoticeCard>
              </Show>
              <Select
                label={t.table}
                options={storedTables().map((table) => ({ id: table.id, label: table.name }))}
                value={tableId}
                onValueChange={chooseTable}
                required
              />
              <Select
                label={t.typeField}
                description={t.typeFieldDescription}
                options={typeFields().map((field) => ({ id: field.id, label: field.name }))}
                value={typeFieldId}
                onValueChange={(value) => {
                  setTypeFieldId(value ?? "");
                  setTypeValue("");
                  setCopyFieldIds((current) => current.filter((fieldId) => fieldId !== value));
                }}
                required
              />
              <Select
                label={correctionIntent() === "cancellation" ? t.cancellationValue : t.correctionValue}
                options={typeValues()}
                value={typeValue}
                onValueChange={(value) => setTypeValue(value ?? "")}
                required
              />
              <Select
                label={t.originalRecordField}
                description={t.originalRecordFieldDescription}
                options={relationFields().map((field) => ({ id: field.id, label: field.name }))}
                value={originalFieldId}
                onValueChange={(value) => setOriginalFieldId(value ?? "")}
                required
              />
              <MultiSelectInput
                label={t.carryOverFields}
                description={t.carryOverDescription}
                options={copyFields().map((field) => ({
                  id: field.id,
                  label: field.name,
                  description: field.type,
                  icon: field.icon ?? "ti ti-column-insert-right",
                }))}
                value={copyFieldIds}
                onValueChange={(fieldIds) => {
                  if (fieldIds.length > MAX_CORRECTION_PREFILL_FIELDS) {
                    void prompts.error(t.carryOverLimit({ count: MAX_CORRECTION_PREFILL_FIELDS }));
                    return;
                  }
                  setCopyFieldIds(fieldIds);
                }}
                placeholder={t.chooseFields}
                icon="ti ti-copy"
                clearable
              />
              <Show when={tableId() && (typeFields().length === 0 || relationFields().length === 0)}>
                <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                  {t.starterRequirements}
                </NoticeCard>
              </Show>
              <div class="flex justify-end">
                <Button
                  variant="primary"
                  type="button"
                  disabled={!tableId() || !typeFieldId() || !typeValue() || !originalFieldId()}
                  onClick={() =>
                    props.close({
                      kind: "correctionDraft",
                      tableId: tableId(),
                      intent: correctionIntent(),
                      typeFieldId: typeFieldId(),
                      typeValue: typeValue(),
                      originalFieldId: originalFieldId(),
                      copyFieldIds: copyFieldIds(),
                    })
                  }
                >
                  <i class={correctionIntent() === "cancellation" ? "ti ti-file-off" : "ti ti-file-delta"} /> {t.useStarter}
                </Button>
              </div>
            </section>
          </Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

type LauncherApi = {
  ":workflowId": {
    launchers: {
      $post: (input: { param: { workflowId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
    };
  };
};

const launcherApi = apiClient.workflows as unknown as LauncherApi;

export function createWorkflowAction(props: { baseId: string; tables: Table[]; fieldsByTable: Record<string, Field[]> }) {
  const locale = useLocale();
  const { t } = sidebarMessages.resolve([locale()]);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const installLauncher = async (workflow: PublicWorkflow, starter: WorkflowStarter, signal: AbortSignal) => {
    try {
      const response = await launcherApi[":workflowId"].launchers.$post(
        {
          param: { workflowId: workflow.id },
          json: { ...starter.launcher, enabled: true },
        },
        { init: { signal } },
      );
      if (response.ok) return;
      await prompts.error(t.launcherSetupFailed({ error: await errorMessage(response, t.launcherFailed) }), { title: t.workflowSaved });
    } catch (error) {
      if (signal.aborted) throw error;
      await prompts.error(t.launcherSetupFailed({ error: error instanceof Error ? error.message : t.launcherFailed }), {
        title: t.workflowSaved,
      });
    }
  };

  const openEditor = async () => {
    const choice = await dialogCore.open<StarterChoice | undefined>(
      (close, context) => (
        <WorkflowStarterDialog
          tables={props.tables}
          fieldsByTable={props.fieldsByTable}
          close={close}
          t={t}
          setDismissHandler={context.setDismissHandler}
        />
      ),
      panelDialogWorkspaceOptions,
    );
    if (!choice) return;
    const table = "tableId" in choice ? props.tables.find((candidate) => candidate.id === choice.tableId) : undefined;
    const starter =
      choice.kind === "closeSelection" && table
        ? closeSelectionWorkflowStarter(table, locale())
        : choice.kind === "correctionDraft" && table
          ? correctionDraftWorkflowStarter(
              {
                table,
                intent: choice.intent,
                typeField: { id: choice.typeFieldId },
                typeValue: choice.typeValue,
                originalField: { id: choice.originalFieldId },
                copyFields: choice.copyFieldIds.map((id) => ({ id })),
              },
              locale(),
            )
          : undefined;
    await dialogCore.open<void>(
      (close, context) => (
        <WorkflowEditor
          setDismissHandler={context.setDismissHandler}
          baseId={props.baseId}
          tables={props.tables}
          starter={starter}
          beforeClose={starter ? (workflow, context) => installLauncher(workflow, starter, context.abortSignal) : undefined}
          onChanged={(workflow) => {
            if (!workflow || disposed) return;
            navigateTo(`/app/grids/${props.baseId}/workflows/${workflow.id}?edit=true`);
          }}
          onClose={close}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  return openEditor;
}
