import { navigateTo } from "@k2b/ssr/nav";
import {
  AppWorkspace,
  Button,
  dialogCore,
  MultiSelectInput,
  NoticeCard,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Select,
} from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field, PublicTable as Table } from "../../../api/public-dto";
import { type CorrectionDraftIntent, isCorrectionPrefillFieldType, MAX_CORRECTION_PREFILL_FIELDS } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import { WorkflowEditor } from "../workflows/WorkflowEditor";
import { closeSelectionWorkflowStarter, correctionDraftWorkflowStarter, type WorkflowStarter } from "../workflows/workflow-starters";
import type { PublicWorkflow } from "../workspace/workspace-public-state-model";

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
}) {
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
  return (
    <PanelDialog>
      <PanelDialog.Header
        title="New workflow"
        subtitle="Start blank or install a guided Record action."
        icon="ti ti-route"
        close={() => props.close()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <section class="paper flex flex-col gap-3 p-4">
            <div>
              <h3 class="font-semibold">Close selected Records</h3>
              <p class="text-sm text-dimmed">
                Adds a Table action for an exact selection. Direct mode finalizes; Four-eyes mode submits requests for another person.
              </p>
            </div>
            <Select
              label="Table"
              description="Durable History and Finalization must be enabled for this stored Table."
              options={storedTables().map((table) => ({ id: table.id, label: table.name }))}
              value={tableId}
              onValueChange={chooseTable}
              required
            />
            <Show when={storedTables().length === 0}>
              <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                This Base has no stored Table.
              </NoticeCard>
            </Show>
            <div class="flex justify-end">
              <Button
                variant="primary"
                type="button"
                disabled={!tableId()}
                onClick={() => props.close({ kind: "closeSelection", tableId: tableId() })}
              >
                <i class="ti ti-list-check" /> Use starter
              </Button>
            </div>
          </section>
          <section class="paper flex flex-col gap-3 p-4">
            <div>
              <h3 class="font-semibold">Create linked follow-up Draft</h3>
              <p class="text-sm text-dimmed">
                Adds a finalized-Record action for a correction or cancellation without changing the original.
              </p>
            </div>
            <Select
              label="Action"
              description="Controls how the action is named. Your selected type value remains the stored business meaning."
              options={[
                {
                  id: "correction",
                  label: "Correction",
                  description: "Create a linked Draft for revised values.",
                  icon: "ti ti-file-pencil",
                },
                {
                  id: "cancellation",
                  label: "Cancellation",
                  description: "Create a linked Draft for a cancellation you complete yourself.",
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
                Grids creates and links the Draft. It does not calculate amounts, taxes, or counter-bookings, and it does not generate a
                Document.
              </NoticeCard>
            </Show>
            <Select
              label="Table"
              options={storedTables().map((table) => ({ id: table.id, label: table.name }))}
              value={tableId}
              onValueChange={chooseTable}
              required
            />
            <Select
              label="Type field"
              description="Choose an existing single-select field."
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
              label={correctionIntent() === "cancellation" ? "Cancellation value" : "Correction value"}
              options={typeValues()}
              value={typeValue}
              onValueChange={(value) => setTypeValue(value ?? "")}
              required
            />
            <Select
              label="Original Record field"
              description="Choose an existing single relation back to this Table."
              options={relationFields().map((field) => ({ id: field.id, label: field.name }))}
              value={originalFieldId}
              onValueChange={(value) => setOriginalFieldId(value ?? "")}
              required
            />
            <MultiSelectInput
              label="Fields to carry over"
              description="Optional. Choose up to 100 stored values. Unique fields, generated IDs, Files, other relations, calculated fields, and Documents are not copied."
              options={copyFields().map((field) => ({
                id: field.id,
                label: field.name,
                description: field.type,
                icon: field.icon ?? "ti ti-column-insert-right",
              }))}
              value={copyFieldIds}
              onValueChange={(fieldIds) => {
                if (fieldIds.length > MAX_CORRECTION_PREFILL_FIELDS) {
                  void prompts.error(`Choose at most ${MAX_CORRECTION_PREFILL_FIELDS} fields to carry over.`);
                  return;
                }
                setCopyFieldIds(fieldIds);
              }}
              placeholder="Choose fields"
              icon="ti ti-copy"
              clearable
            />
            <Show when={tableId() && (typeFields().length === 0 || relationFields().length === 0)}>
              <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                This Table needs a single-select type and a single self-relation before this starter can be installed.
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
                <i class={correctionIntent() === "cancellation" ? "ti ti-file-off" : "ti ti-file-delta"} /> Use starter
              </Button>
            </div>
          </section>
          <section class="paper flex items-center justify-between gap-4 p-4">
            <div>
              <h3 class="font-semibold">Blank workflow</h3>
              <p class="text-sm text-dimmed">Write the inputs, triggers, and steps yourself.</p>
            </div>
            <Button variant="secondary" type="button" onClick={() => props.close({ kind: "blank" })}>
              Start blank
            </Button>
          </section>
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

export default function CreateWorkflowButton(props: { baseId: string; tables: Table[]; fieldsByTable: Record<string, Field[]> }) {
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
      await prompts.error(
        `The workflow was saved, but its Records action could not be added. Open Run options to finish setup.\n\n${await errorMessage(
          response,
          "Could not add the Records action.",
        )}`,
        { title: "Workflow saved" },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await prompts.error(
        `The workflow was saved, but its Records action could not be added. Open Run options to finish setup.\n\n${
          error instanceof Error ? error.message : "Could not add the Records action."
        }`,
        { title: "Workflow saved" },
      );
    }
  };

  const openEditor = async () => {
    const choice = await dialogCore.open<StarterChoice | undefined>(
      (close) => <WorkflowStarterDialog tables={props.tables} fieldsByTable={props.fieldsByTable} close={close} />,
      { ...panelDialogWorkspaceOptions, cancelBehavior: "ignore" },
    );
    if (!choice) return;
    const table = "tableId" in choice ? props.tables.find((candidate) => candidate.id === choice.tableId) : undefined;
    const starter =
      choice.kind === "closeSelection" && table
        ? closeSelectionWorkflowStarter(table)
        : choice.kind === "correctionDraft" && table
          ? correctionDraftWorkflowStarter({
              table,
              intent: choice.intent,
              typeField: { id: choice.typeFieldId },
              typeValue: choice.typeValue,
              originalField: { id: choice.originalFieldId },
              copyFields: choice.copyFieldIds.map((id) => ({ id })),
            })
          : undefined;
    await dialogCore.open<void>(
      (close) => (
        <WorkflowEditor
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
      { ...panelDialogWorkspaceOptions, cancelBehavior: "ignore" },
    );
  };

  return (
    <AppWorkspace.SidebarItem tone="success" onClick={() => void openEditor()}>
      <AppWorkspace.SidebarItemIcon icon="ti ti-plus" />
      <AppWorkspace.SidebarItemLabel>New workflow</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
