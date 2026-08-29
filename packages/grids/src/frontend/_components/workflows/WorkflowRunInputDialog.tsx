import { Button, dialogCore, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createMemo, createSignal } from "solid-js";
import type { PublicTable } from "../../../api/public-dto";
import { workflowMessages } from "./messages";
import { WorkflowInputFields } from "./WorkflowInputFields";
import {
  buildWorkflowRunInput,
  type WorkflowRunInputDraft,
  type WorkflowRunInputDraftValue,
  workflowInputDraftFromValues,
} from "./workflow-trigger-actions";

type Props = {
  workflow: { name: string; plan: Pick<WorkflowBoundPlan, "inputs" | "bindings"> };
  tables: Array<Pick<PublicTable, "id" | "name">>;
  mode: "execute" | "dryRun";
  initialValues?: Record<string, WorkflowJsonValue>;
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  icon?: string;
  close: (input?: Record<string, WorkflowJsonValue>) => void;
};

function WorkflowRunInputDialog(props: Props) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal<WorkflowRunInputDraft>(
    workflowInputDraftFromValues(props.workflow.plan.inputs, props.initialValues),
  );
  const inputs = () => props.workflow.plan.inputs;
  const validation = createMemo(() => buildWorkflowRunInput(inputs(), draft(), locale()));
  const setValue = (name: string, next: WorkflowRunInputDraftValue) => setDraft((current) => ({ ...current, [name]: next }));
  const errors = () => {
    const current = validation();
    return current.ok ? {} : current.errors;
  };
  const submit = () => {
    const current = validation();
    if (current.ok) props.close(current.input);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={
          props.title ??
          (props.mode === "dryRun" ? t().dryRunNamed({ name: props.workflow.name }) : t().runNamed({ name: props.workflow.name }))
        }
        subtitle={props.subtitle ?? (props.mode === "dryRun" ? t().provideDryRunInputs : t().provideRunInputs)}
        icon={props.icon ?? (props.mode === "dryRun" ? "ti ti-flask" : "ti ti-player-play")}
        close={() => props.close()}
      />
      <PanelDialog.Body>
        <WorkflowInputFields workflow={props.workflow} tables={props.tables} draft={draft} onValueChange={setValue} errors={errors} />
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => props.close()}>
            {t().cancel}
          </Button>
          <Button variant="primary" size="sm" type="button" disabled={!validation().ok} onClick={submit}>
            <i class={props.mode === "dryRun" ? "ti ti-flask" : "ti ti-player-play"} />
            {props.submitLabel ?? (props.mode === "dryRun" ? t().startDryRun : t().runWorkflow)}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const requestWorkflowRunInput = async (args: {
  workflow: { name: string; plan: Pick<WorkflowBoundPlan, "inputs" | "bindings"> };
  tables: Array<Pick<PublicTable, "id" | "name">>;
  mode: "execute" | "dryRun";
  initialValues?: Record<string, WorkflowJsonValue>;
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  icon?: string;
}): Promise<Record<string, WorkflowJsonValue> | undefined> => {
  if (args.workflow.plan.inputs.length === 0) return args.initialValues ?? {};
  return dialogCore.open<Record<string, WorkflowJsonValue>>(
    (close) => <WorkflowRunInputDialog {...args} close={close} />,
    panelDialogOptions,
  );
};
