import type { DateContext } from "@k2b/stdlib";
import { Button, NoticeCard } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { FormBlockData } from "../../api/custom-app-published-page";
import FormSubmit from "../_components/forms/PublicFormSubmit";
import Actions, { type CustomAppRenderedAction } from "./Actions";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

/** One island owns editing and the actions that require its saved state. */
export default function FormWorkspace(props: {
  data: Extract<FormBlockData, { ok: true }>;
  actions: CustomAppRenderedAction[];
  dateConfig: DateContext;
  showTitle: boolean;
}) {
  const messages = useCustomAppRuntimeMessages();
  let formElement: HTMLFormElement | undefined;
  const [dirty, setDirty] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [actionPending, setActionPending] = createSignal(
    props.actions.some(
      (action) =>
        action.kind === "workflow" &&
        action.background &&
        (action.background.state.finalized || ["running", "ready", "attention", "missing"].includes(action.background.state.status)),
    ),
  );
  return (
    <div class="flex min-w-0 flex-col gap-6">
      <Show when={props.actions.length > 0}>
        <div class="flex flex-col gap-3">
          <Actions
            actions={props.actions}
            disabled={dirty() || submitting()}
            onPendingChange={setActionPending}
            onCompleted={() => window.location.reload()}
          />
          <Show when={dirty()}>
            <NoticeCard tone="info">
              <div class="flex flex-wrap items-center gap-3">
                <span>{messages().saveBeforeActions}</span>
                <Button
                  size="sm"
                  variant="primary"
                  loading={submitting()}
                  disabled={actionPending()}
                  onClick={() => formElement?.requestSubmit()}
                >
                  {props.data.form.config.submitLabel ?? messages().saveChanges}
                </Button>
                <Button size="sm" variant="secondary" disabled={submitting()} onClick={() => window.location.reload()}>
                  {messages().discardUnsavedChanges}
                </Button>
              </div>
            </NoticeCard>
          </Show>
        </div>
      </Show>
      <FormSubmit
        formRef={(element) => {
          formElement = element;
        }}
        submitUrl={props.data.submitUrl}
        form={props.data.form}
        fields={props.data.fields}
        inlineTargetFields={props.data.inlineTargetFields}
        initialRecord={props.data.initialRecord}
        relationLabels={props.data.relationLabels}
        relationLookupFields={props.data.relationLookupFields}
        dateConfig={props.dateConfig}
        surface="bare"
        showTitle={props.showTitle}
        titleAs="h2"
        disabled={actionPending()}
        onDirtyChange={setDirty}
        onSubmittingChange={setSubmitting}
      />
    </div>
  );
}
