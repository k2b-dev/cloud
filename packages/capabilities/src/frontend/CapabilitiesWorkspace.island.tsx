import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  CodeDisplay,
  DetailPanel,
  Disclosure,
  IconButtonLink,
  isStructuredDataValue,
  NumberInput,
  Placeholder,
  prompts,
  Select,
  StatusBadge,
  StructuredDataPreview,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { reviewCapabilityAction } from "@k2b/cloud/capabilities";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { ActionReviewContent, confirmActionRun } from "../action-review";
import type { SelectedCapability } from "../catalog";
import { buildCapabilityCurl } from "../curl";
import {
  ambiguousActionNetworkOutcome,
  type CapabilityInvocationOutcome,
  preserveAmbiguousActionOutcome,
  readCapabilityOutcome,
} from "../invocation";
import { capabilityApiPath } from "../routes";
import {
  buildCapabilityInput,
  createSchemaEditorModel,
  createSchemaEditorState,
  type EditorField,
  type EditorValue,
  type InputBuildResult,
  type SchemaEditorModel,
  type SchemaEditorState,
} from "../schema-editor";
import CapabilityResultView from "./CapabilityResultView";
import { capabilityUiMessages } from "./messages";

type Props = {
  selection: SelectedCapability;
  closeHref: string;
  initialAttemptKey: string;
};

type RunRequest = {
  input: Record<string, unknown>;
  idempotencyKey?: string;
};

function FieldEditor(props: {
  field: EditorField;
  state: () => SchemaEditorState;
  error: () => string | undefined;
  onValueChange: (key: string, value: EditorValue) => void;
}) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const value = () => props.state().values[props.field.key];
  const common = {
    label: props.field.label,
    description: props.field.description,
    required: props.field.required,
  };

  return (
    <Show when={props.field.kind} keyed>
      {(kind) => {
        if (kind === "boolean") {
          return (
            <Checkbox
              {...common}
              value={() => Boolean(value())}
              error={props.error}
              onValueChange={(next) => props.onValueChange(props.field.key, next)}
            />
          );
        }
        if (kind === "number" || kind === "integer") {
          const field = props.field as Extract<EditorField, { kind: "number" | "integer" }>;
          return (
            <NumberInput
              {...common}
              value={() => (typeof value() === "number" ? (value() as number) : null)}
              error={props.error}
              min={field.minimum}
              max={field.maximum}
              decimalPlaces={kind === "integer" ? 0 : 12}
              step={kind === "integer" ? 1 : 0}
              showSteppers={false}
              onValueChange={(next) => props.onValueChange(field.key, next)}
            />
          );
        }
        if (kind === "enum") {
          const field = props.field as Extract<EditorField, { kind: "enum" }>;
          return (
            <Select
              {...common}
              value={() => (typeof value() === "string" ? (value() as string) : null)}
              error={props.error}
              options={field.options.map((option) => ({ value: option.value, label: option.label }))}
              placeholder={t().selectValue}
              onValueChange={(next) => props.onValueChange(field.key, next)}
            />
          );
        }
        if (kind === "array") {
          return (
            <TextInput
              {...common}
              value={() => (typeof value() === "string" ? (value() as string) : "")}
              error={props.error}
              multiline
              lines={4}
              monospace
              placeholder={t().onePerLine}
              onValueChange={(next) => props.onValueChange(props.field.key, next)}
            />
          );
        }
        const field = props.field as Extract<EditorField, { kind: "string" }>;
        return (
          <TextInput
            {...common}
            value={() => (typeof value() === "string" ? (value() as string) : "")}
            error={props.error}
            type={field.format === "email" ? "email" : field.format === "uri" || field.format === "url" ? "url" : "text"}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onValueChange={(next) => props.onValueChange(field.key, next)}
          />
        );
      }}
    </Show>
  );
}

function RequestEditor(props: {
  model: SchemaEditorModel;
  state: () => SchemaEditorState;
  errors: () => Record<string, string>;
  formError: () => string | undefined;
  onStateChange: (state: SchemaEditorState) => void;
}) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const updateValue = (key: string, value: EditorValue) =>
    props.onStateChange({ ...props.state(), values: { ...props.state().values, [key]: value } });

  return (
    <Show
      when={props.model.mode === "form" ? props.model : undefined}
      fallback={
        <TextInput
          label={t().requestJson}
          description={props.model.mode === "json" ? props.model.reason : undefined}
          value={() => props.state().source}
          onValueChange={(source) => props.onStateChange({ ...props.state(), source })}
          error={props.formError}
          multiline
          monospace
          lines={14}
          spellcheck={false}
        />
      }
    >
      {(model) => (
        <div class="flex flex-col gap-4">
          <Show when={model().fields.length > 0} fallback={<p class="text-sm text-dimmed">{t().noInput}</p>}>
            <For each={model().fields}>
              {(field) => (
                <FieldEditor field={field} state={props.state} error={() => props.errors()[field.key]} onValueChange={updateValue} />
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );
}

function ResponsePanel(props: {
  run: ReturnType<typeof mutation.create<CapabilityInvocationOutcome, RunRequest>>;
  visible: () => boolean;
  selection: SelectedCapability;
}) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const outcome = () => props.run.data();
  return (
    <DetailPanel.Section
      title={t().response}
      description={t().responseDescription}
      meta={
        <Show when={outcome()}>
          {(value) => <StatusBadge tone={value().ok ? "ok" : "error"} label={`${value().status} · ${Math.round(value().durationMs)} ms`} />}
        </Show>
      }
    >
      <Show when={!props.run.loading()} fallback={<Placeholder state="loading" variant="panel" title={t().running} />}>
        <Show
          when={props.visible() ? props.run.error() : null}
          fallback={
            <Show
              when={props.visible() ? outcome() : null}
              fallback={
                <Placeholder
                  variant="panel"
                  icon="ti ti-player-play"
                  title={t().ready}
                  description={t().readyDescription}
                />
              }
            >
              {(value) => <OutcomeContent outcome={value()} selection={props.selection} />}
            </Show>
          }
        >
          {(error) => (
            <Placeholder
              state="error"
              variant="panel"
              title={t().unreachable}
              description={error().message}
              action={
                <Button size="sm" variant="secondary" onClick={() => void props.run.retry()}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              }
            />
          )}
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}

function OutcomeContent(props: { outcome: CapabilityInvocationOutcome; selection: SelectedCapability }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  if (!props.outcome.ok) {
    return (
      <div class="flex flex-col gap-4">
        <Placeholder state="error" align="left" title={props.outcome.error.code} description={props.outcome.error.message} />
        <Show when={props.outcome.error.details}>
          {(details) => {
            const data = details();
            return (
              <StructuredDataPreview
                title={t().details}
                data={isStructuredDataValue(data) ? data : { error: t().invalidErrorDetails }}
              />
            );
          }}
        </Show>
      </div>
    );
  }
  return (
    <div class="flex flex-col gap-4">
      <CapabilityResultView
        selection={props.selection}
        data={props.outcome.result.data}
        refs={props.outcome.result.refs}
        page={props.outcome.result.page}
        links={props.outcome.result.links}
      />
    </div>
  );
}

function CapabilityRunner(props: Props) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const model = createSchemaEditorModel(props.selection.operation.inputSchema, locale());
  const [editor, setEditor] = createSignal(createSchemaEditorState(model, props.selection.operation.inputSchema));
  const [submitted, setSubmitted] = createSignal(false);
  const [resultVisible, setResultVisible] = createSignal(false);
  const [attemptKey, setAttemptKey] = createSignal(props.initialAttemptKey);
  const [reviewing, setReviewing] = createSignal(false);
  const [reviewError, setReviewError] = createSignal<{ code: string; message: string }>();
  let reviewController: AbortController | undefined;
  const input = createMemo<InputBuildResult>(() => buildCapabilityInput(model, editor(), locale()));
  const action = () => (props.selection.kind === "action" ? props.selection.operation : undefined);
  const idempotencyKey = () => (action()?.idempotency === "required" ? attemptKey() : undefined);

  const run = mutation.create<CapabilityInvocationOutcome, RunRequest>({
    mutation: async (request, context) => {
      const startedAt = performance.now();
      const url = capabilityApiPath({
        kind: props.selection.kind,
        appId: props.selection.app.id,
        capabilityId: props.selection.operation.localId,
      });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (request.idempotencyKey) headers["Idempotency-Key"] = request.idempotencyKey;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ input: request.input }),
          signal: context.abortSignal,
        });
        return preserveAmbiguousActionOutcome(await readCapabilityOutcome(response, performance.now() - startedAt, locale()), {
          kind: props.selection.kind,
          idempotencyKey: request.idempotencyKey,
          locale: locale(),
        });
      } catch (cause) {
        const ambiguous = ambiguousActionNetworkOutcome({
          kind: props.selection.kind,
          idempotencyKey: request.idempotencyKey,
          durationMs: performance.now() - startedAt,
          locale: locale(),
        });
        if (ambiguous) return ambiguous;
        throw cause;
      }
    },
  });
  onCleanup(() => {
    reviewController?.abort();
    run.abort();
  });

  const execute = async () => {
    setSubmitted(true);
    const built = input();
    if (!built.ok) return;
    const selectedAction = action();
    if (selectedAction) {
      reviewController?.abort();
      const controller = new AbortController();
      reviewController = controller;
      setReviewing(true);
      setReviewError(undefined);
      const decision = await confirmActionRun(
        { appId: props.selection.app.id, operation: selectedAction, input: built.input, signal: controller.signal },
        {
          review: (request) => reviewCapabilityAction(request),
          confirmReview: (review, operation) =>
            prompts.confirm(<ActionReviewContent review={review} />, {
              title: t().reviewTitle({ title: operation.title }),
              confirmText: t().runAction,
              variant: operation.destructive ? "danger" : "primary",
              size: "large",
            }),
          confirmDestructive: (operation) =>
            prompts.confirm(t().destructiveQuestion({ title: operation.title }), {
              title: t().confirmDestructive,
              variant: "danger",
            }),
        },
        locale(),
      );
      if (reviewController !== controller) return;
      reviewController = undefined;
      setReviewing(false);
      if (decision.kind === "failed") {
        setReviewError(decision.error);
        return;
      }
      if (decision.kind === "cancelled") return;
    }
    setResultVisible(true);
    await run.mutate({ input: built.input, idempotencyKey: idempotencyKey() });
  };

  const reset = () => {
    reviewController?.abort();
    reviewController = undefined;
    setReviewing(false);
    setReviewError(undefined);
    run.abort();
    setAttemptKey(crypto.randomUUID());
    setSubmitted(false);
    setResultVisible(false);
    setEditor(createSchemaEditorState(model, props.selection.operation.inputSchema));
  };

  const updateEditor = (state: SchemaEditorState) => {
    reviewController?.abort();
    reviewController = undefined;
    setReviewing(false);
    setReviewError(undefined);
    setEditor(state);
  };

  const curl = createMemo(() => {
    const built = input();
    if (!built.ok) return undefined;
    return buildCapabilityCurl({
      kind: props.selection.kind,
      appId: props.selection.app.id,
      capabilityId: props.selection.operation.localId,
      body: built.input,
      idempotencyKey: idempotencyKey(),
    });
  });
  const fieldErrors = () => {
    const built = input();
    return submitted() && !built.ok ? built.errors : {};
  };
  const formError = () => {
    const built = input();
    return submitted() && !built.ok ? built.formError : undefined;
  };

  return (
    <DetailPanel>
      <DetailPanel.Header
        icon={props.selection.kind === "query" ? "ti ti-search" : "ti ti-bolt"}
        title={props.selection.operation.title}
        subtitle={props.selection.operation.description}
        meta={
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge tone="neutral" label={props.selection.kind === "query" ? t().query : t().action} />
            <code class="truncate text-xs text-dimmed">{`${props.selection.app.id}.${props.selection.operation.localId}`}</code>
          </div>
        }
        actions={
          <div class="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={reset}>
              <i class="ti ti-refresh" aria-hidden="true" /> {t().reset}
            </Button>
            <IconButtonLink href={props.closeHref} size="sm" label={t().closeDetails}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButtonLink>
          </div>
        }
      />

      <DetailPanel.Body
        scrollPreserveKey={`capability-${props.selection.app.id}-${props.selection.kind}-${props.selection.operation.localId}`}
      >
        <Show when={action()}>
          {(selectedAction) => (
            <DetailPanel.Summary title={t().actionPolicy}>
              <div class="flex flex-wrap gap-2">
                <StatusBadge
                  tone={selectedAction().destructive ? "warning" : "neutral"}
                  label={selectedAction().destructive ? t().destructive : t().nonDestructive}
                />
                <StatusBadge
                  tone={selectedAction().openWorld ? "warning" : "neutral"}
                  label={selectedAction().openWorld ? t().openWorld : t().cloudOnly}
                />
                <StatusBadge tone="neutral" label={`${t().idempotency}: ${selectedAction().idempotency}`} />
              </div>
            </DetailPanel.Summary>
          )}
        </Show>

        <DetailPanel.Group label={t().runGroup}>
          <DetailPanel.Section
            title={t().request}
            description={t().requestDescription}
            actions={
              <Button
                loading={reviewing() || run.loading()}
                loadingLabel={reviewing() ? t().reviewing : t().running}
                onClick={() => void execute()}
              >
                <i class="ti ti-player-play" aria-hidden="true" /> {t().run}
              </Button>
            }
          >
            <RequestEditor model={model} state={editor} errors={fieldErrors} formError={formError} onStateChange={updateEditor} />
            <Show when={reviewError()}>
              {(error) => (
                <div class="mt-4">
                  <Placeholder state="error" align="left" title={t().reviewFailed({ code: error().code })} description={error().message} />
                </div>
              )}
            </Show>
            <div class="mt-4 flex flex-col gap-3">
              <Disclosure summary={t().requestCurl} icon="ti ti-terminal-2" disabled={!curl()}>
                <Show when={curl()}>{(value) => <CodeDisplay code={value()} language="script" lineNumbers={false} />}</Show>
              </Disclosure>
              <Disclosure summary={t().schemas} icon="ti ti-braces">
                <div class="grid gap-3">
                  <StructuredDataPreview
                    title={t().inputSchema}
                    data={
                      isStructuredDataValue(props.selection.operation.inputSchema)
                        ? props.selection.operation.inputSchema
                        : { error: t().invalidInputSchema }
                    }
                    maxRows={10}
                  />
                  <StructuredDataPreview
                    title={t().dataSchema}
                    data={
                      isStructuredDataValue(props.selection.operation.dataSchema)
                        ? props.selection.operation.dataSchema
                        : { error: t().invalidDataSchema }
                    }
                    maxRows={10}
                  />
                </div>
              </Disclosure>
            </div>
          </DetailPanel.Section>
          <ResponsePanel run={run} visible={resultVisible} selection={props.selection} />
        </DetailPanel.Group>
      </DetailPanel.Body>
    </DetailPanel>
  );
}

export default function CapabilitiesWorkspace(props: Props): JSX.Element {
  return <CapabilityRunner {...props} />;
}
