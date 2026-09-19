import type { DateContext } from "@k2b/stdlib";
import { Button, Disclosure, InlineGuidance } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { FormBlockData } from "../../api/custom-app-published-page";
import type { CustomAppBlock } from "../../custom-apps/contracts";
import FormSubmit from "../_components/forms/PublicFormSubmit";
import Actions, { type CustomAppRenderedAction } from "./Actions";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

/** One island owns editing and the actions that require its saved state. */
export default function FormWorkspace(props: {
  data: Extract<FormBlockData, { ok: true }>;
  actions: CustomAppRenderedAction[];
  dateConfig: DateContext;
  showTitle: boolean;
  workspace?: Extract<CustomAppBlock, { type: "form" }>["workspace"];
}) {
  const messages = useCustomAppRuntimeMessages();
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
    <div class="grids-form-shell flex min-w-0 flex-col gap-6">
      <FormSubmit
        summaryTitle={props.workspace?.summaryTitle}
        summaryDescription={props.workspace?.summaryDescription}
        renderContext={(state) => (
          <>
            {state.summary}
            <section class="grids-form-next flex flex-col gap-3" aria-label={messages().nextStep}>
              <h3 class="text-sm font-semibold">{messages().nextStep}</h3>
              <Show when={!actionPending()}>
                <InlineGuidance role="status" icon="ti ti-info-circle">
                  {state.failures().length
                    ? messages().completeBeforeActions
                    : dirty()
                      ? messages().saveBeforeActions
                      : messages().readyForActions}
                </InlineGuidance>
                <Show when={state.failures().length > 0}>
                  <ul class="flex flex-col items-start gap-1">
                    <For each={state.failures()}>
                      {(failure) => (
                        <li>
                          <Button
                            size="sm"
                            variant="ghost"
                            class="whitespace-normal text-left"
                            disabled={submitting()}
                            onClick={() => state.focusField(failure.errorFieldId)}
                          >
                            <i class="ti ti-focus-2" aria-hidden="true" />
                            {failure.label}: {failure.message}
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
              <Actions
                actions={props.actions}
                compactDanger
                disabled={dirty() || submitting()}
                disabledActionIds={
                  !actionPending() && state.failures().length
                    ? props.actions.filter((action) => action.variant === "primary").map((action) => action.id)
                    : []
                }
                onPendingChange={setActionPending}
                onCompleted={() => window.location.reload()}
              />
            </section>
            <Show when={props.workspace?.helpText}>
              <Disclosure surface="plain" summary={props.workspace?.helpTitle ?? messages().moreContext}>
                <p>{props.workspace?.helpText}</p>
              </Disclosure>
            </Show>
          </>
        )}
        submitUrl={props.data.submitUrl}
        form={props.data.form}
        fields={props.data.fields}
        inlineTargetFields={props.data.inlineTargetFields}
        initialRecord={props.data.initialRecord}
        relationLabels={props.data.relationLabels}
        relationLookupFields={props.data.relationLookupFields}
        dateConfig={props.dateConfig}
        surface="bare"
        showTitle={props.workspace ? false : props.showTitle}
        titleAs="h2"
        disabled={actionPending()}
        onSuccess={() => window.location.reload()}
        onDirtyChange={setDirty}
        onSubmittingChange={setSubmitting}
      />
    </div>
  );
}
