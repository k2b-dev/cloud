import { mutation, query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  CodeDisplay,
  confirmDiscardIfDirty,
  DataTable,
  type DataTableColumn,
  Dropdown,
  dialogCore,
  IconButton,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogWideOptions,
  prompts,
  Select,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { apiClient } from "../../api/client";
import { spaceDetailSchema, spacesItemSearchDataSchema, spacesMailDestinationsSchema } from "../../app-integration-contracts";
import {
  createIncomingAutomationSchema,
  type IncomingAutomationBackfill,
  type IncomingAutomationMatchPreview,
  type MailAutomationAction,
  type MailAutomationScope,
  type MailAutomationStep,
} from "../../contracts";
import type { IncomingAutomation } from "../../service/incoming-automations";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";
import { readApiError } from "./api-response";
import {
  initialMailAutomationCondition,
  MailAutomationActionEditor,
  MailAutomationConditionsEditor,
  mailAutomationConditionLabel,
} from "./MailAutomationFields";
import {
  type AutomationActionKind,
  createMailAutomationAction,
  initialMailAutomationAction,
  mailAutomationActionKindsFor,
} from "./mail-automation-actions";
import { waitForMailPageTransition } from "./mail-page-transition";
import { mailRemainingMessages } from "./mail-remaining-messages";

export type IncomingAutomationPreset = "blank" | "ai-route" | "ai-tag" | "ai-draft";

const stepId = (): string => crypto.randomUUID();
const browserLocale = (): string => (typeof document === "undefined" ? "en" : document.documentElement.lang);
const browserMessages = () => mailRemainingMessages.resolve([browserLocale()]).t;
const useMessages = () => {
  const locale = useLocale();
  return { locale, messages: createMemo(() => mailRemainingMessages.resolve([locale()]).t) };
};
const choice = (name: string, description: string) => ({ name, description });
const localizedPresetChoiceDescription = (description: string, locale: string): string => {
  const english = mailRemainingMessages.resolve(["en"]).t;
  const german = mailRemainingMessages.resolve(["de"]).t;
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (description === english.importantDescription || description === german.importantDescription) return messages.importantDescription;
  if (description === english.routineDescription || description === german.routineDescription) return messages.routineDescription;
  return description;
};
const mailActionStep = (action: MailAutomationAction): MailAutomationStep => ({ id: stepId(), kind: "mail_action", action });
const directActionOrder: readonly AutomationActionKind[] = [
  "mark_read",
  "add_local_tag",
  "assign_user",
  "set_status",
  "add_keyword",
  "move_to_folder",
  "junk",
  "trash",
];
const branchActionOrder: readonly AutomationActionKind[] = [
  "set_status",
  "add_local_tag",
  "assign_user",
  "mark_read",
  "move_to_folder",
  "add_keyword",
  "junk",
  "trash",
];
const nextMailAction = (
  actions: MailAutomationAction[],
  catalog: MailWorkflowCatalogSnapshot,
  preferred: readonly AutomationActionKind[],
): MailAutomationAction | null => {
  const available = mailAutomationActionKindsFor({ actions, catalog });
  const kind = preferred.find((candidate) => available.includes(candidate));
  return kind ? createMailAutomationAction({ kind, actions, catalog }) : null;
};
const activeBackfillStates = new Set<IncomingAutomationBackfill["state"]>(["queued", "running", "waiting"]);

type AutomationOutput = {
  id: string;
  label: string;
  type: "text" | "text_array" | "event";
  choices: string[];
};

type AutomationContentStep = Extract<MailAutomationStep, { kind: "create_reply_draft" | "add_comment" | "set_summary" }>;
type AutomationTextSource = AutomationContentStep["body"];

const customTextSource = (): AutomationTextSource => ({ kind: "custom", value: "" });
const outputTextSource = (sourceStepId: string): AutomationTextSource => ({ kind: "step_output", sourceStepId });
const customTextSourceId = "custom";
const textSourceValue = (source: AutomationTextSource): string => (source.kind === "custom" ? customTextSourceId : source.sourceStepId);
const textSourceOptions = (outputs: AutomationOutput[], locale = browserLocale()) => [
  { id: customTextSourceId, label: mailRemainingMessages.resolve([locale]).t.customText },
  ...outputs.filter((output) => output.type === "text").map((output) => ({ id: output.id, label: output.label })),
];
const selectTextSource = (source: AutomationTextSource, value: string | null): AutomationTextSource => {
  if (!value || value === customTextSourceId) return source.kind === "custom" ? source : customTextSource();
  return outputTextSource(value);
};
const textSourceLabel = (source: AutomationTextSource, outputs: AutomationOutput[], locale = browserLocale()): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (source.kind === "custom") return messages.usesCustomText;
  return messages.usesOutput({
    output: outputs.find((output) => output.id === source.sourceStepId)?.label ?? messages.missingOutput,
  });
};

const outputForStep = (step: MailAutomationStep, index: number, locale = browserLocale()): AutomationOutput | null => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (step.kind === "ai_generate_text")
    return { id: step.id, label: messages.generatedTextStep({ step: index + 1 }), type: "text", choices: [] };
  if (step.kind === "ai_classify") {
    return {
      id: step.id,
      label: messages.classificationStep({ step: index + 1 }),
      type: "text",
      choices: step.choices.map((item) => item.name),
    };
  }
  if (step.kind === "ai_classify_many") {
    return {
      id: step.id,
      label: messages.classificationsStep({ step: index + 1 }),
      type: "text_array",
      choices: step.choices.map((item) => item.name),
    };
  }
  if (step.kind === "ai_extract_event")
    return { id: step.id, label: messages.eventDataStep({ step: index + 1 }), type: "event", choices: [] };
  return null;
};

const outputReferencesResolve = (steps: readonly MailAutomationStep[], inherited: ReadonlySet<string>): boolean => {
  const available = new Set(inherited);
  for (const step of steps) {
    if (
      (step.kind === "create_reply_draft" || step.kind === "add_comment" || step.kind === "set_summary") &&
      step.body.kind === "step_output" &&
      !available.has(step.body.sourceStepId)
    )
      return false;
    if (step.kind === "create_space_event" && step.event.kind === "step_output" && !available.has(step.event.sourceStepId)) return false;
    if (step.kind === "if") {
      if (!available.has(step.condition.sourceStepId)) return false;
      if (!outputReferencesResolve(step.then, available) || !outputReferencesResolve(step.else, available)) return false;
    }
    if (
      step.kind === "ai_generate_text" ||
      step.kind === "ai_classify" ||
      step.kind === "ai_classify_many" ||
      step.kind === "ai_extract_event"
    )
      available.add(step.id);
  }
  return true;
};

const ifStep = (
  output: AutomationOutput,
  value: string,
  then: MailAutomationStep[] = [],
  otherwise: MailAutomationStep[] = [],
): MailAutomationStep => ({
  id: stepId(),
  kind: "if",
  condition: { sourceStepId: output.id, operator: output.type === "text_array" ? "includes" : "equals", value },
  then,
  else: otherwise,
});

const classificationSteps = (
  many: boolean,
  catalog: MailWorkflowCatalogSnapshot,
  actions: MailAutomationAction[] = [],
  locale = browserLocale(),
): MailAutomationStep[] => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  const available = mailAutomationActionKindsFor({ actions, catalog });
  const fallbackAction = nextMailAction(actions, catalog, branchActionOrder);
  const choices = [choice(messages.important, messages.importantDescription), choice(messages.routine, messages.routineDescription)];
  const classifier: MailAutomationStep = many
    ? {
        id: stepId(),
        kind: "ai_classify_many",
        instructions: messages.classifyManyInstructions,
        choices,
        maxChoices: 2,
      }
    : {
        id: stepId(),
        kind: "ai_classify",
        instructions: messages.classifyOneInstructions,
        choices,
      };
  const output = outputForStep(classifier, 0, locale)!;
  const primaryAction = available.includes("set_status")
    ? mailActionStep({ kind: "set_status", status: "needs_action" })
    : fallbackAction
      ? mailActionStep(fallbackAction)
      : null;
  if (!primaryAction) return [classifier];
  const otherwise = !many && available.includes("set_status") ? [mailActionStep({ kind: "set_status", status: "done" })] : [];
  return [classifier, ifStep(output, choices[0]!.name, [primaryAction], otherwise)];
};

const generatedTextStep = (locale = browserLocale()): Extract<MailAutomationStep, { kind: "ai_generate_text" }> => ({
  id: stepId(),
  kind: "ai_generate_text",
  instructions: mailRemainingMessages.resolve([locale]).t.generateTextInstructions,
  maxOutputChars: 4_000,
});

const replyDraftStep = (
  catalog: MailWorkflowCatalogSnapshot,
  sourceStepId?: string,
): Extract<MailAutomationStep, { kind: "create_reply_draft" }> | null => {
  const identity = (catalog.senderIdentities ?? [])[0];
  if (!identity) return null;
  return {
    id: stepId(),
    kind: "create_reply_draft",
    body: sourceStepId ? outputTextSource(sourceStepId) : customTextSource(),
    senderIdentityId: identity.id,
  };
};

const commentStep = (sourceStepId?: string): Extract<MailAutomationStep, { kind: "add_comment" }> => ({
  id: stepId(),
  kind: "add_comment",
  body: sourceStepId ? outputTextSource(sourceStepId) : customTextSource(),
});

const summaryStep = (sourceStepId?: string): Extract<MailAutomationStep, { kind: "set_summary" }> => ({
  id: stepId(),
  kind: "set_summary",
  body: sourceStepId ? outputTextSource(sourceStepId) : customTextSource(),
});

const presetSteps = (
  preset: IncomingAutomationPreset,
  catalog: MailWorkflowCatalogSnapshot,
  locale = browserLocale(),
): MailAutomationStep[] => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (preset === "ai-route") return classificationSteps(false, catalog, [], locale);
  if (preset === "ai-tag") {
    const tags = (catalog.localTags ?? []).slice(0, 4);
    if (tags.length >= 2) {
      const maxChoices = Math.min(3, tags.length);
      const classifier: MailAutomationStep = {
        id: stepId(),
        kind: "ai_classify_many",
        instructions: messages.chooseTagsInstructions,
        choices: tags.map((tag) => choice(tag.name, messages.tagChoiceDescription({ tag: tag.name }))),
        maxChoices,
      };
      const output = outputForStep(classifier, 0, locale)!;
      return [classifier, ...tags.map((tag) => ifStep(output, tag.name, [mailActionStep({ kind: "add_local_tag", tagId: tag.id })]))];
    }
    return [];
  }
  if (preset === "ai-draft") {
    const generated: Extract<MailAutomationStep, { kind: "ai_generate_text" }> = {
      ...generatedTextStep(locale),
      instructions: messages.draftReplyInstructions,
    };
    const draft = replyDraftStep(catalog, generated.id);
    return draft ? [generated, draft] : [];
  }
  return [mailActionStep(initialMailAutomationAction("mark_read", catalog))];
};

const flattenSteps = (steps: readonly MailAutomationStep[]): MailAutomationStep[] =>
  steps.flatMap((step) => (step.kind === "if" ? [step, ...flattenSteps(step.then), ...flattenSteps(step.else)] : [step]));

const hasAi = (steps: readonly MailAutomationStep[]): boolean => flattenSteps(steps).some((step) => step.kind.startsWith("ai_"));
const aiCallCount = (steps: readonly MailAutomationStep[]): number =>
  flattenSteps(steps).filter((step) => step.kind.startsWith("ai_")).length;
const branchDepth = (steps: readonly MailAutomationStep[]): number =>
  steps.reduce((depth, step) => (step.kind === "if" ? Math.max(depth, 1 + branchDepth([...step.then, ...step.else])) : depth), 0);
const referencesOutput = (steps: readonly MailAutomationStep[], sourceStepId: string): boolean =>
  steps.some((step) => {
    if (
      (step.kind === "create_reply_draft" || step.kind === "add_comment" || step.kind === "set_summary") &&
      step.body.kind === "step_output" &&
      step.body.sourceStepId === sourceStepId
    )
      return true;
    if (step.kind === "create_space_event" && step.event.kind === "step_output" && step.event.sourceStepId === sourceStepId) return true;
    return (
      step.kind === "if" &&
      (step.condition.sourceStepId === sourceStepId ||
        referencesOutput(step.then, sourceStepId) ||
        referencesOutput(step.else, sourceStepId))
    );
  });
const referencesChoice = (steps: readonly MailAutomationStep[], sourceStepId: string, value: string): boolean =>
  steps.some(
    (step) =>
      step.kind === "if" &&
      ((step.condition.sourceStepId === sourceStepId && step.condition.value.toLowerCase() === value.toLowerCase()) ||
        referencesChoice(step.then, sourceStepId, value) ||
        referencesChoice(step.else, sourceStepId, value)),
  );
const replaceChoiceReferences = (
  steps: readonly MailAutomationStep[],
  sourceStepId: string,
  previous: string,
  next: string,
): MailAutomationStep[] =>
  steps.map((step) => {
    if (step.kind !== "if") return step;
    return {
      ...step,
      condition:
        step.condition.sourceStepId === sourceStepId && step.condition.value.toLowerCase() === previous.toLowerCase()
          ? { ...step.condition, value: next }
          : step.condition,
      then: replaceChoiceReferences(step.then, sourceStepId, previous, next),
      else: replaceChoiceReferences(step.else, sourceStepId, previous, next),
    };
  });
const maxAiCalls = (steps: readonly MailAutomationStep[]): number =>
  steps.reduce((total, step) => {
    if (step.kind.startsWith("ai_")) return total + 1;
    if (step.kind === "if") return total + Math.max(maxAiCalls(step.then), maxAiCalls(step.else));
    return total;
  }, 0);
const scopeLabel = (scope: MailAutomationScope, locale: string): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (scope.mode === "all") return messages.allIncomingMail;
  if (scope.conditions.items.length === 1) return mailAutomationConditionLabel(scope.conditions.items[0]!, locale);
  return messages.conditionsSummary({ mode: scope.conditions.mode, count: scope.conditions.items.length });
};

const flowLabel = (automation: IncomingAutomation, _catalog: MailWorkflowCatalogSnapshot, locale: string): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  const steps = flattenSteps(automation.steps);
  const firstAction = steps.find((step): step is Extract<MailAutomationStep, { kind: "mail_action" }> => step.kind === "mail_action");
  const aiCalls = steps.filter((step) => step.kind.startsWith("ai_")).length;
  const parts = [
    messages.stepCount({ count: steps.length }),
    aiCalls > 0 ? messages.aiCallCount({ count: aiCalls }) : null,
    firstAction ? messages.automationAction({ kind: firstAction.action.kind }) : null,
  ].filter(Boolean);
  return parts.join(" · ");
};

function ChoiceEditor(props: {
  step: Extract<MailAutomationStep, { kind: "ai_classify" | "ai_classify_many" }>;
  context?: string;
  onChange: (
    step: Extract<MailAutomationStep, { kind: "ai_classify" | "ai_classify_many" }>,
    change?: { kind: "rename"; previous: string; next: string } | { kind: "remove"; name: string },
  ) => void;
}) {
  const { locale, messages } = useMessages();
  const remove = (index: number) => {
    const removed = props.step.choices[index];
    if (!removed) return;
    const choices = props.step.choices.filter((_, itemIndex) => itemIndex !== index);
    props.onChange(
      props.step.kind === "ai_classify_many"
        ? { ...props.step, choices, maxChoices: Math.min(props.step.maxChoices, choices.length) }
        : { ...props.step, choices },
      { kind: "remove", name: removed.name },
    );
  };
  const replace = (index: number, patch: Partial<(typeof props.step.choices)[number]>) => {
    const previous = props.step.choices[index];
    if (!previous) return;
    const next = { ...previous, ...patch };
    props.onChange(
      {
        ...props.step,
        choices: props.step.choices.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate)),
      },
      patch.name === undefined ? undefined : { kind: "rename", previous: previous.name, next: next.name },
    );
  };
  return (
    <div class="flex flex-col gap-2">
      <Index each={props.step.choices}>
        {(candidate, index) => (
          <div class="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3">
            <div class="grid gap-2 md:grid-cols-[minmax(8rem,0.6fr)_minmax(12rem,1fr)_auto]">
              <TextInput
                label={messages().choiceLabel({ index: index + 1 })}
                value={() => candidate().name}
                onValueChange={(name) => replace(index, { name })}
                maxLength={80}
                required
              />
              <TextInput
                label={messages().meaning}
                value={() => localizedPresetChoiceDescription(candidate().description, locale())}
                onValueChange={(description) => replace(index, { description })}
                maxLength={500}
                required
              />
              <div class="flex items-end">
                <IconButton
                  type="button"
                  size="sm"
                  label={messages().removeChoice({ index: index + 1, context: props.context })}
                  disabled={props.step.choices.length <= 2}
                  onClick={() => remove(index)}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          </div>
        )}
      </Index>
      <Show when={props.step.choices.length < 10}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          class="self-start"
          onClick={() =>
            props.onChange({
              ...props.step,
              choices: [
                ...props.step.choices,
                choice(messages().choiceLabel({ index: props.step.choices.length + 1 }), messages().describeChoice),
              ],
            })
          }
        >
          <i class="ti ti-plus" aria-hidden="true" /> {messages().addChoice}
        </Button>
      </Show>
    </div>
  );
}

function AutomationStepsEditor(props: {
  mailboxId: string;
  steps: MailAutomationStep[];
  workflowSteps?: MailAutomationStep[];
  availableActions: MailAutomationAction[];
  availableOutputs?: AutomationOutput[];
  catalog: MailWorkflowCatalogSnapshot;
  allowEmpty?: boolean;
  maxSteps?: number;
  depth?: number;
  labelContext?: string;
  onChange: (steps: MailAutomationStep[]) => void;
}) {
  const { locale, messages } = useMessages();
  const [expandedStepIds, setExpandedStepIds] = createSignal(new Set(props.steps.slice(0, 1).map((step) => step.id)));
  const actionsBefore = (index: number): MailAutomationAction[] => [
    ...props.availableActions,
    ...flattenSteps(props.steps.slice(0, index)).flatMap((step) => (step.kind === "mail_action" ? [step.action] : [])),
  ];
  const outputsBefore = (index: number): AutomationOutput[] => [
    ...(props.availableOutputs ?? []),
    ...props.steps.slice(0, index).flatMap((step, stepIndex) => {
      const output = outputForStep(step, stepIndex, locale());
      return output ? [output] : [];
    }),
  ];
  const replace = (index: number, step: MailAutomationStep) =>
    props.onChange(props.steps.map((candidate, candidateIndex) => (candidateIndex === index ? step : candidate)));
  const remove = (index: number) => {
    const step = props.steps[index];
    if (!step) return;
    if (
      referencesOutput(
        props.steps.filter((_, candidateIndex) => candidateIndex !== index),
        step.id,
      )
    ) {
      void prompts.error(messages().outputStillUsed);
      return;
    }
    props.onChange(props.steps.filter((_, candidateIndex) => candidateIndex !== index));
  };
  const canMove = (index: number, offset: -1 | 1): boolean => {
    const destination = index + offset;
    if (destination < 0 || destination >= props.steps.length) return false;
    const next = [...props.steps];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    return outputReferencesResolve(next, new Set((props.availableOutputs ?? []).map((output) => output.id)));
  };
  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (!canMove(index, offset)) return;
    const next = [...props.steps];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    props.onChange(next);
  };
  const expand = (id: string) => setExpandedStepIds((current) => new Set(current).add(id));
  const capacityIssueFor = (shape: { localSteps: number; totalSteps: number; aiCalls: number; branchDepth: number }): string | null => {
    if (props.steps.length + shape.localSteps > (props.maxSteps ?? 20)) {
      return messages().localStepLimit({ branch: Boolean(props.labelContext), count: props.maxSteps ?? 20 });
    }
    const workflowSteps = props.workflowSteps ?? props.steps;
    if (flattenSteps(workflowSteps).length + shape.totalSteps > 40) return messages().totalStepLimit;
    if (aiCallCount(workflowSteps) + shape.aiCalls > 10) return messages().aiCallLimit;
    if ((props.depth ?? 0) + shape.branchDepth > 4) return messages().branchDepthLimit;
    return null;
  };
  const capacityIssue = (steps: readonly MailAutomationStep[]): string | null =>
    capacityIssueFor({
      localSteps: steps.length,
      totalSteps: flattenSteps(steps).length,
      aiCalls: aiCallCount(steps),
      branchDepth: branchDepth(steps),
    });
  const canInsert = (steps: readonly MailAutomationStep[]) => capacityIssue(steps) === null;
  const canInsertShape = (shape: { localSteps: number; totalSteps?: number; aiCalls?: number; branchDepth?: number }) =>
    capacityIssueFor({
      localSteps: shape.localSteps,
      totalSteps: shape.totalSteps ?? shape.localSteps,
      aiCalls: shape.aiCalls ?? 0,
      branchDepth: shape.branchDepth ?? 0,
    }) === null;
  const append = (step: MailAutomationStep) => appendMany([step]);
  const appendMany = (steps: MailAutomationStep[]) => {
    const issue = capacityIssue(steps);
    if (issue) {
      void prompts.error(issue);
      return;
    }
    steps.forEach((step) => expand(step.id));
    props.onChange([...props.steps, ...steps]);
  };
  const insertAfterOutput = (index: number, sourceStepId: string, step: MailAutomationStep) => {
    const issue = capacityIssue([step]);
    if (issue) {
      void prompts.error(issue);
      return;
    }
    let destination = index + 1;
    while (destination < props.steps.length) {
      const candidate = props.steps[destination]!;
      const reference =
        candidate.kind === "create_reply_draft" || candidate.kind === "add_comment" || candidate.kind === "set_summary"
          ? candidate.body.kind === "step_output"
            ? candidate.body.sourceStepId
            : null
          : candidate.kind === "if"
            ? candidate.condition.sourceStepId
            : null;
      if (reference !== sourceStepId) break;
      destination += 1;
    }
    const next = [...props.steps];
    next.splice(destination, 0, step);
    expand(step.id);
    props.onChange(next);
  };
  const setExpanded = (id: string, value: boolean) =>
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  const stepLabel = (step: MailAutomationStep): string => messages().incomingStepKind({ kind: step.kind });
  const chooseSpaceItem = async (): Promise<string | null> => {
    const selected = await prompts.search<{ id: string; title: string }>(
      async ({ query, abortSignal }) => {
        if (!query.trim()) return [];
        const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].spaces.items.$get(
          { param: { mailboxId: props.mailboxId }, query: { query } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().couldNotSearchSpaces));
        return spacesItemSearchDataSchema.parse(await response.json()).map((item) => ({
          value: { id: item.ref.id, title: item.title },
          label: item.title,
          desc: item.metadata?.find((entry) => entry.label === "Space")?.value,
          icon: item.icon ?? "ti ti-checkbox",
        }));
      },
      {
        title: messages().linkSpaceItem,
        icon: "ti ti-link",
        placeholder: messages().searchTasksAndEvents,
        minQueryLength: 1,
        noResultsText: messages().noWritableSpaceItems,
        size: "small",
      },
    );
    return selected?.value?.id ?? null;
  };
  const appendSpaceItem = async () => {
    const itemId = await chooseSpaceItem();
    if (itemId) append({ id: stepId(), kind: "link_space_item", itemId });
  };
  const chooseEventDestination = async (): Promise<{ spaceId: string; columnId: string } | null> => {
    const destinationsResponse = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].spaces.destinations.$get({
      param: { mailboxId: props.mailboxId },
    });
    if (!destinationsResponse.ok) throw new Error(await readApiError(destinationsResponse, messages().couldNotLoadSpaces));
    const destinations = spacesMailDestinationsSchema.parse(await destinationsResponse.json());
    const selected = await prompts.search<(typeof destinations)[number]>(
      ({ query }) =>
        Promise.resolve(
          destinations
            .filter((space) => space.name.toLowerCase().includes(query.toLowerCase()))
            .map((space) => ({
              value: space,
              label: space.name,
              icon: "ti ti-layout-kanban",
            })),
        ),
      {
        title: messages().chooseSpaceTitle,
        icon: "ti ti-layout-kanban",
        placeholder: messages().searchWritableSpaces,
        minQueryLength: 0,
        noResultsText: messages().noWritableSpacesFound,
        size: "small",
      },
    );
    if (!selected?.value) return null;
    const spaceResponse = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].spaces[":spaceId"].$get({
      param: { mailboxId: props.mailboxId, spaceId: selected.value.id },
    });
    if (!spaceResponse.ok) throw new Error(await readApiError(spaceResponse, messages().couldNotLoadSpaceKanbans));
    const columns = spaceDetailSchema.parse(await spaceResponse.json()).columns.filter((column) => !column.isDone);
    const column = await prompts.search<(typeof columns)[number]>(
      ({ query }) =>
        Promise.resolve(
          columns
            .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
            .map((entry) => ({ value: entry, label: entry.name, icon: "ti ti-columns" })),
        ),
      {
        title: messages().chooseKanban,
        icon: "ti ti-columns",
        placeholder: messages().searchOpenKanbans,
        minQueryLength: 0,
        noResultsText: messages().noOpenKanbanFound,
        size: "small",
      },
    );
    return column?.value ? { spaceId: selected.value.id, columnId: column.value.id } : null;
  };
  const appendAiEventFlow = async () => {
    try {
      const destination = await chooseEventDestination();
      if (!destination) return;
      const extractor: Extract<MailAutomationStep, { kind: "ai_extract_event" }> = {
        id: stepId(),
        kind: "ai_extract_event",
        instructions: messages().extractEventInstructions,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      };
      appendMany([
        extractor,
        { id: stepId(), kind: "create_space_event", ...destination, event: { kind: "step_output", sourceStepId: extractor.id } },
      ]);
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : messages().couldNotConfigureSpacesEvent);
    }
  };
  const changeEventDestination = async (index: number, step: Extract<MailAutomationStep, { kind: "create_space_event" }>) => {
    try {
      const destination = await chooseEventDestination();
      if (destination) replace(index, { ...step, ...destination });
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : messages().couldNotConfigureSpacesEvent);
    }
  };
  const accessibleStepLabel = (step: MailAutomationStep, index: number): string =>
    messages().accessibleStep({ label: stepLabel(step), step: index + 1, context: props.labelContext });
  const addItems = () => {
    const actions = actionsBefore(props.steps.length);
    const outputs = outputsBefore(props.steps.length);
    const latestOutput = outputs.at(-1);
    const availableMailActions = mailAutomationActionKindsFor({ actions, catalog: props.catalog });
    const replyDraft = replyDraftStep(props.catalog);
    const remaining = (props.maxSteps ?? 20) - props.steps.length;
    const classification = classificationSteps(false, props.catalog, actions, locale());
    const multiClassification = classificationSteps(true, props.catalog, actions, locale());
    return [
      ...directActionOrder
        .filter((kind) => availableMailActions.includes(kind))
        .filter(() => canInsertShape({ localSteps: 1 }))
        .map((kind) => {
          const action = createMailAutomationAction({ kind, actions, catalog: props.catalog });
          return {
            label: `${messages().mailAction} · ${messages().automationAction({ kind })}`,
            icon: "ti ti-mail-forward",
            action: () => action && append(mailActionStep(action)),
          };
        }),
      ...(canInsertShape({ localSteps: 1 })
        ? [{ label: messages().linkSpaceItem, icon: "ti ti-link", action: () => void appendSpaceItem() }]
        : []),
      ...(canInsertShape({ localSteps: 2, aiCalls: 1 })
        ? [{ label: messages().aiEventFlow, icon: "ti ti-calendar-plus", action: () => void appendAiEventFlow() }]
        : []),
      ...(replyDraft && canInsert([replyDraft])
        ? [
            {
              label: messages().createReplyDraft,
              icon: "ti ti-message-reply",
              action: () => append(replyDraft),
            },
          ]
        : []),
      ...(canInsertShape({ localSteps: 1 })
        ? [{ label: messages().addInternalComment, icon: "ti ti-message-plus", action: () => append(commentStep()) }]
        : []),
      ...(canInsertShape({ localSteps: 1 })
        ? [{ label: messages().setConversationSummary, icon: "ti ti-notes", action: () => append(summaryStep()) }]
        : []),
      ...(canInsertShape({ localSteps: 1, aiCalls: 1 })
        ? [{ label: messages().aiGenerateText, icon: "ti ti-sparkles", action: () => append(generatedTextStep(locale())) }]
        : []),
      ...(classification.length <= remaining && canInsert(classification)
        ? [{ label: messages().aiClassify, icon: "ti ti-list-check", action: () => appendMany(classification) }]
        : []),
      ...(multiClassification.length <= remaining && canInsert(multiClassification)
        ? [{ label: messages().aiClassifyMany, icon: "ti ti-tags", action: () => appendMany(multiClassification) }]
        : []),
      ...(latestOutput && latestOutput.type !== "event" && canInsertShape({ localSteps: 1, branchDepth: 1 })
        ? [
            {
              label: messages().ifOutputMatches,
              icon: "ti ti-git-branch",
              action: () => append(ifStep(latestOutput, latestOutput.choices[0] ?? "value")),
            },
          ]
        : []),
    ];
  };
  const menuItems = createMemo(addItems);

  return (
    <div class="flex flex-col gap-2">
      <For each={props.steps}>
        {(step, index) => {
          const actions = () => actionsBefore(index());
          return (
            <div class="relative overflow-hidden rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
              <div class="flex items-center gap-2 p-3">
                <IconButton
                  type="button"
                  size="sm"
                  label={
                    expandedStepIds().has(step.id)
                      ? messages().collapseStep({ label: accessibleStepLabel(step, index()) })
                      : messages().expandStep({ label: accessibleStepLabel(step, index()) })
                  }
                  onClick={() => setExpanded(step.id, !expandedStepIds().has(step.id))}
                >
                  <i class={`ti ${expandedStepIds().has(step.id) ? "ti-chevron-down" : "ti-chevron-right"}`} aria-hidden="true" />
                </IconButton>
                <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface)] text-[11px] font-semibold text-dimmed">
                  {index() + 1}
                </span>
                <i
                  class={`ti shrink-0 text-dimmed ${
                    step.kind === "mail_action"
                      ? "ti-mail-forward"
                      : step.kind === "ai_generate_text"
                        ? "ti-sparkles"
                        : step.kind === "ai_classify"
                          ? "ti-list-check"
                          : step.kind === "ai_classify_many"
                            ? "ti-tags"
                            : step.kind === "ai_extract_event"
                              ? "ti-calendar-search"
                              : step.kind === "link_space_item"
                                ? "ti-link"
                                : step.kind === "create_space_event"
                                  ? "ti-calendar-plus"
                                  : step.kind === "create_reply_draft"
                                    ? "ti-message-reply"
                                    : step.kind === "add_comment"
                                      ? "ti-message-plus"
                                      : step.kind === "set_summary"
                                        ? "ti-notes"
                                        : "ti-git-branch"
                  }`}
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-xs text-primary">{stepLabel(step)}</strong>
                  <span class="block truncate text-[11px] text-dimmed">
                    {step.kind === "mail_action"
                      ? messages().automationAction({ kind: step.action.kind })
                      : step.kind === "ai_generate_text"
                        ? messages().producesText
                        : step.kind === "ai_classify"
                          ? messages().producesOneChoice({ count: step.choices.length })
                          : step.kind === "ai_classify_many"
                            ? messages().producesChoices({ count: step.maxChoices })
                            : step.kind === "ai_extract_event"
                              ? messages().producesEventData({ timeZone: step.timeZone })
                              : step.kind === "link_space_item"
                                ? messages().linksItem({ id: step.itemId })
                                : step.kind === "create_space_event"
                                  ? messages().createsEventIn({ id: step.spaceId })
                                  : step.kind === "create_reply_draft" || step.kind === "add_comment" || step.kind === "set_summary"
                                    ? textSourceLabel(step.body, outputsBefore(index()), locale())
                                    : messages().usesOutput({
                                        output:
                                          outputsBefore(index()).find((output) => output.id === step.condition.sourceStepId)?.label ??
                                          messages().missingOutput,
                                      })}
                  </span>
                </div>
                <IconButton
                  type="button"
                  size="sm"
                  label={messages().moveStepUp({ label: accessibleStepLabel(step, index()) })}
                  disabled={!canMove(index(), -1)}
                  onClick={() => move(index(), -1)}
                >
                  <i class="ti ti-arrow-up" aria-hidden="true" />
                </IconButton>
                <IconButton
                  type="button"
                  size="sm"
                  label={messages().moveStepDown({ label: accessibleStepLabel(step, index()) })}
                  disabled={!canMove(index(), 1)}
                  onClick={() => move(index(), 1)}
                >
                  <i class="ti ti-arrow-down" aria-hidden="true" />
                </IconButton>
                <IconButton
                  type="button"
                  size="sm"
                  label={messages().removeStep({ label: accessibleStepLabel(step, index()) })}
                  disabled={!props.allowEmpty && props.steps.length === 1}
                  onClick={() => remove(index())}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </div>

              <Show when={expandedStepIds().has(step.id)}>
                <div class="border-t border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] p-3">
                  <Show when={step.kind === "mail_action"}>
                    <MailAutomationActionEditor
                      action={(step as Extract<MailAutomationStep, { kind: "mail_action" }>).action}
                      otherActions={actions()}
                      catalog={props.catalog}
                      onChange={(action) => replace(index(), { ...step, kind: "mail_action", action })}
                    />
                  </Show>

                  <Show when={step.kind === "ai_generate_text"}>
                    <div class="flex flex-col gap-3">
                      <div class="flex flex-col gap-2">
                        <TextInput
                          label={messages().instructions}
                          description={messages().generateTextDescription}
                          value={() => (step.kind === "ai_generate_text" ? step.instructions : "")}
                          onValueChange={(instructions) => step.kind === "ai_generate_text" && replace(index(), { ...step, instructions })}
                          maxLength={4_000}
                          multiline
                          lines={3}
                          required
                        />
                        <div class="max-w-56">
                          <NumberInput
                            label={messages().maximumCharacters}
                            value={() => (step.kind === "ai_generate_text" ? step.maxOutputChars : 4_000)}
                            onValueChange={(maxOutputChars) =>
                              step.kind === "ai_generate_text" && replace(index(), { ...step, maxOutputChars: maxOutputChars ?? 4_000 })
                            }
                            min={200}
                            max={10_000}
                            step={100}
                          />
                        </div>
                      </div>
                      <div class="flex items-center gap-3 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3">
                        <i class="ti ti-variable text-dimmed" aria-hidden="true" />
                        <div class="min-w-0 flex-1">
                          <strong class="block text-xs text-primary">{messages().outputText}</strong>
                          <span class="block text-[11px] text-dimmed">{messages().outputReferenceDescription}</span>
                        </div>
                        <Dropdown.Root
                          position="bottom-right"
                          width="16rem"
                          items={[
                            ...((props.catalog.senderIdentities ?? []).length > 0
                              ? [
                                  {
                                    label: messages().createReplyDraft,
                                    icon: "ti ti-message-reply",
                                    action: () => {
                                      if (step.kind !== "ai_generate_text") return;
                                      const draft = replyDraftStep(props.catalog, step.id);
                                      if (draft) insertAfterOutput(index(), step.id, draft);
                                    },
                                  },
                                ]
                              : []),
                            {
                              label: messages().addInternalComment,
                              icon: "ti ti-message-plus",
                              action: () => step.kind === "ai_generate_text" && insertAfterOutput(index(), step.id, commentStep(step.id)),
                            },
                            {
                              label: messages().setConversationSummary,
                              icon: "ti ti-notes",
                              action: () => step.kind === "ai_generate_text" && insertAfterOutput(index(), step.id, summaryStep(step.id)),
                            },
                          ]}
                        >
                          <Dropdown.Trigger
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!canInsertShape({ localSteps: 1 })}
                            title={
                              canInsertShape({ localSteps: 1 })
                                ? undefined
                                : (capacityIssueFor({ localSteps: 1, totalSteps: 1, aiCalls: 0, branchDepth: 0 }) ?? undefined)
                            }
                          >
                            <i class="ti ti-plus" aria-hidden="true" /> Use output
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </div>
                    </div>
                  </Show>

                  <Show when={step.kind === "ai_classify" || step.kind === "ai_classify_many"}>
                    {(() => {
                      const classifier = step as Extract<MailAutomationStep, { kind: "ai_classify" | "ai_classify_many" }>;
                      return (
                        <div class="flex flex-col gap-3">
                          <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
                            <TextInput
                              label={messages().instructions}
                              description={messages().classificationDescription}
                              value={() => classifier.instructions}
                              onValueChange={(instructions) => replace(index(), { ...classifier, instructions })}
                              maxLength={4_000}
                              multiline
                              lines={2}
                              required
                            />
                            <Show when={classifier.kind === "ai_classify_many"}>
                              <NumberInput
                                label={messages().maximumMatches}
                                value={() => (classifier.kind === "ai_classify_many" ? classifier.maxChoices : 1)}
                                onValueChange={(maxChoices) =>
                                  classifier.kind === "ai_classify_many" && replace(index(), { ...classifier, maxChoices: maxChoices ?? 1 })
                                }
                                min={1}
                                max={classifier.choices.length}
                              />
                            </Show>
                          </div>
                          <ChoiceEditor
                            step={classifier}
                            context={[props.labelContext, messages().accessibleStep({ label: stepLabel(step), step: index() + 1 })]
                              .filter(Boolean)
                              .join(", ")}
                            onChange={(next, change) => {
                              if (change?.kind === "remove" && referencesChoice(props.steps, classifier.id, change.name)) {
                                void prompts.error(messages().choiceStillUsed);
                                return;
                              }
                              const changed = props.steps.map((candidate, candidateIndex) =>
                                candidateIndex === index() ? next : candidate,
                              );
                              props.onChange(
                                change?.kind === "rename"
                                  ? replaceChoiceReferences(changed, classifier.id, change.previous, change.next)
                                  : changed,
                              );
                            }}
                          />
                          <div class="flex items-center gap-3 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3">
                            <i class="ti ti-variable text-dimmed" aria-hidden="true" />
                            <div class="min-w-0 flex-1">
                              <strong class="block text-xs text-primary">
                                {classifier.kind === "ai_classify_many" ? messages().outputChoiceList : messages().outputChoice}
                              </strong>
                              <span class="block text-[11px] text-dimmed">{messages().conditionOutputDescription}</span>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="input"
                              disabled={!canInsertShape({ localSteps: 1, branchDepth: 1 })}
                              title={capacityIssueFor({ localSteps: 1, totalSteps: 1, aiCalls: 0, branchDepth: 1 }) ?? undefined}
                              onClick={() => {
                                const output = outputForStep(classifier, index(), locale());
                                if (output)
                                  insertAfterOutput(index(), classifier.id, ifStep(output, classifier.choices[0]?.name ?? "value"));
                              }}
                            >
                              <i class="ti ti-plus" aria-hidden="true" /> {messages().addCondition}
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>

                  <Show when={step.kind === "ai_extract_event"}>
                    <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
                      <TextInput
                        label={messages().instructions}
                        description={messages().eventExtractionDescription}
                        value={() => (step.kind === "ai_extract_event" ? step.instructions : "")}
                        onValueChange={(instructions) => step.kind === "ai_extract_event" && replace(index(), { ...step, instructions })}
                        maxLength={4_000}
                        multiline
                        lines={3}
                        required
                      />
                      <TextInput
                        label={messages().timeZone({ timeZone: "" }).split(":")[0]}
                        description={messages().ianaTimeZoneDescription}
                        value={() => (step.kind === "ai_extract_event" ? step.timeZone : "")}
                        onValueChange={(timeZone) => step.kind === "ai_extract_event" && replace(index(), { ...step, timeZone })}
                        maxLength={80}
                        required
                      />
                    </div>
                  </Show>

                  <Show when={step.kind === "link_space_item"}>
                    <div class="flex flex-wrap items-end gap-2">
                      <div class="min-w-48 flex-1">
                        <TextInput
                          label={messages().spacesItem}
                          description={messages().selectedSpaceItemDescription}
                          value={() => (step.kind === "link_space_item" ? step.itemId : "")}
                          readOnly
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="input"
                        onClick={() => {
                          if (step.kind !== "link_space_item") return;
                          void chooseSpaceItem().then((itemId) => itemId && replace(index(), { ...step, itemId }));
                        }}
                      >
                        <i class="ti ti-search" aria-hidden="true" /> Change item
                      </Button>
                    </div>
                  </Show>

                  <Show when={step.kind === "create_space_event"}>
                    <div class="grid gap-3 md:grid-cols-2">
                      <TextInput label={messages().space} value={() => (step.kind === "create_space_event" ? step.spaceId : "")} readOnly />
                      <TextInput
                        label={messages().kanban}
                        value={() => (step.kind === "create_space_event" ? step.columnId : "")}
                        readOnly
                      />
                      <div class="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
                        <p class="min-w-48 flex-1 text-[11px] text-dimmed">
                          Uses the earlier AI event-data output. Event creation stops when required data is missing or ambiguous and is safe
                          to retry.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="input"
                          onClick={() => step.kind === "create_space_event" && void changeEventDestination(index(), step)}
                        >
                          <i class="ti ti-search" aria-hidden="true" /> {messages().changeDestination}
                        </Button>
                      </div>
                    </div>
                  </Show>

                  <Show when={step.kind === "create_reply_draft"}>
                    <div class="grid gap-3 md:grid-cols-2">
                      <Select
                        label={messages().textSource}
                        value={() => (step.kind === "create_reply_draft" ? textSourceValue(step.body) : customTextSourceId)}
                        onValueChange={(value) =>
                          step.kind === "create_reply_draft" && replace(index(), { ...step, body: selectTextSource(step.body, value) })
                        }
                        options={textSourceOptions(outputsBefore(index()), locale())}
                      />
                      <Select
                        label={messages().fromAddress}
                        value={() => (step.kind === "create_reply_draft" ? step.senderIdentityId : "")}
                        onValueChange={(senderIdentityId) =>
                          step.kind === "create_reply_draft" && replace(index(), { ...step, senderIdentityId: senderIdentityId ?? "" })
                        }
                        options={(props.catalog.senderIdentities ?? []).map((identity) => ({ id: identity.id, label: identity.name }))}
                      />
                      <Show when={step.kind === "create_reply_draft" && step.body.kind === "custom"}>
                        <div class="md:col-span-2">
                          <TextInput
                            label={messages().replyText}
                            description={messages().replyTextDescription}
                            value={() => (step.kind === "create_reply_draft" && step.body.kind === "custom" ? step.body.value : "")}
                            onValueChange={(value) =>
                              step.kind === "create_reply_draft" &&
                              step.body.kind === "custom" &&
                              replace(index(), { ...step, body: { ...step.body, value } })
                            }
                            maxLength={50_000}
                            markdown
                            required
                          />
                        </div>
                      </Show>
                      <p class="text-[11px] text-dimmed md:col-span-2">{messages().replyDraftSafety}</p>
                    </div>
                  </Show>

                  <Show when={step.kind === "add_comment"}>
                    <div class="flex flex-col gap-3">
                      <Select
                        label={messages().textSource}
                        value={() => (step.kind === "add_comment" ? textSourceValue(step.body) : customTextSourceId)}
                        onValueChange={(value) =>
                          step.kind === "add_comment" && replace(index(), { ...step, body: selectTextSource(step.body, value) })
                        }
                        options={textSourceOptions(outputsBefore(index()), locale())}
                      />
                      <Show when={step.kind === "add_comment" && step.body.kind === "custom"}>
                        <TextInput
                          label={messages().comment}
                          description={messages().commentDescription}
                          value={() => (step.kind === "add_comment" && step.body.kind === "custom" ? step.body.value : "")}
                          onValueChange={(value) =>
                            step.kind === "add_comment" &&
                            step.body.kind === "custom" &&
                            replace(index(), { ...step, body: { ...step.body, value } })
                          }
                          maxLength={50_000}
                          multiline
                          lines={4}
                          required
                        />
                      </Show>
                    </div>
                  </Show>

                  <Show when={step.kind === "set_summary"}>
                    <div class="flex flex-col gap-3">
                      <Select
                        label={messages().textSource}
                        value={() => (step.kind === "set_summary" ? textSourceValue(step.body) : customTextSourceId)}
                        onValueChange={(value) =>
                          step.kind === "set_summary" && replace(index(), { ...step, body: selectTextSource(step.body, value) })
                        }
                        options={textSourceOptions(outputsBefore(index()), locale())}
                      />
                      <Show when={step.kind === "set_summary" && step.body.kind === "custom"}>
                        <TextInput
                          label={messages().summary}
                          description={messages().summaryDescription}
                          value={() => (step.kind === "set_summary" && step.body.kind === "custom" ? step.body.value : "")}
                          onValueChange={(value) =>
                            step.kind === "set_summary" &&
                            step.body.kind === "custom" &&
                            replace(index(), { ...step, body: { ...step.body, value } })
                          }
                          maxLength={50_000}
                          multiline
                          lines={4}
                          required
                        />
                      </Show>
                      <p class="text-[11px] text-dimmed">{messages().summarySafety}</p>
                    </div>
                  </Show>

                  <Show when={step.kind === "if"}>
                    {(() => {
                      const conditionStep = step as Extract<MailAutomationStep, { kind: "if" }>;
                      const outputs = () => outputsBefore(index()).filter((output) => output.type !== "event");
                      const source = () => outputs().find((output) => output.id === conditionStep.condition.sourceStepId) ?? outputs()[0];
                      const context = [props.labelContext, messages().ifStep({ step: index() + 1 })].filter(Boolean).join(", ");
                      return (
                        <div class="flex flex-col gap-3">
                          <div class="grid gap-3 md:grid-cols-2">
                            <Select
                              label={messages().output}
                              value={() => conditionStep.condition.sourceStepId}
                              onValueChange={(sourceStepId) => {
                                const nextSource = outputs().find((output) => output.id === sourceStepId);
                                if (!nextSource) return;
                                replace(index(), {
                                  ...conditionStep,
                                  condition: {
                                    sourceStepId: nextSource.id,
                                    operator: nextSource.type === "text_array" ? "includes" : "equals",
                                    value: nextSource.choices[0] ?? conditionStep.condition.value,
                                  },
                                });
                              }}
                              options={outputs().map((output) => ({ id: output.id, label: output.label }))}
                            />
                            <Show
                              when={(source()?.choices.length ?? 0) > 0}
                              fallback={
                                <TextInput
                                  label={messages().equals}
                                  value={() => conditionStep.condition.value}
                                  onValueChange={(value) =>
                                    replace(index(), { ...conditionStep, condition: { ...conditionStep.condition, value } })
                                  }
                                  maxLength={500}
                                  required
                                />
                              }
                            >
                              <Select
                                label={conditionStep.condition.operator === "includes" ? messages().contains : messages().equals}
                                value={() => conditionStep.condition.value}
                                onValueChange={(value) =>
                                  value && replace(index(), { ...conditionStep, condition: { ...conditionStep.condition, value } })
                                }
                                options={(source()?.choices ?? []).map((value) => ({ id: value, label: value }))}
                              />
                            </Show>
                          </div>
                          <div class="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3">
                            <strong class="mb-2 block text-xs text-primary">{messages().then}</strong>
                            <AutomationStepsEditor
                              mailboxId={props.mailboxId}
                              steps={conditionStep.then}
                              workflowSteps={props.workflowSteps ?? props.steps}
                              availableActions={actions()}
                              availableOutputs={outputs()}
                              catalog={props.catalog}
                              labelContext={`${context}, ${messages().then}`}
                              allowEmpty
                              maxSteps={12}
                              depth={(props.depth ?? 0) + 1}
                              onChange={(then) => replace(index(), { ...conditionStep, then })}
                            />
                          </div>
                          <div class="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3">
                            <strong class="mb-2 block text-xs text-primary">{messages().else}</strong>
                            <AutomationStepsEditor
                              mailboxId={props.mailboxId}
                              steps={conditionStep.else}
                              workflowSteps={props.workflowSteps ?? props.steps}
                              availableActions={actions()}
                              availableOutputs={outputs()}
                              catalog={props.catalog}
                              labelContext={`${context}, ${messages().else}`}
                              allowEmpty
                              maxSteps={12}
                              depth={(props.depth ?? 0) + 1}
                              onChange={(otherwise) => replace(index(), { ...conditionStep, else: otherwise })}
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <Show
        when={menuItems().length > 0}
        fallback={
          <Show when={capacityIssueFor({ localSteps: 1, totalSteps: 1, aiCalls: 0, branchDepth: 0 })}>
            {(message) => (
              <p class="text-[11px] text-dimmed" role="status">
                {message()}
              </p>
            )}
          </Show>
        }
      >
        <Dropdown.Root position="bottom-right" width="18rem" items={menuItems()}>
          <Dropdown.Trigger type="button" variant="secondary" size="sm" class="self-start">
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addStep}
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </div>
  );
}

function IncomingAutomationEditor(props: {
  mailboxId: string;
  catalog: MailWorkflowCatalogSnapshot;
  automation: IncomingAutomation | null;
  preset: IncomingAutomationPreset;
  initialScope?: MailAutomationScope;
  initialAction?: AutomationActionKind;
  initialName?: string;
  close: () => void;
  onSaved: (automation: IncomingAutomation) => void;
  onBackfillStarted: (backfill: IncomingAutomationBackfill) => void;
}) {
  const { locale, messages } = useMessages();
  const initialSteps = () => {
    if (props.automation) return props.automation.steps;
    if (props.initialAction) return [mailActionStep(initialMailAutomationAction(props.initialAction, props.catalog))];
    return presetSteps(props.preset, props.catalog, locale());
  };
  const initialName = props.automation?.name ?? props.initialName ?? "";
  const initialEnabled = props.automation?.enabled ?? false;
  const initialScope = props.automation?.scope ?? props.initialScope ?? ({ mode: "all" } as const);
  const initialStepList = initialSteps();
  const initialMatchingConditions =
    initialScope.mode === "matching" ? initialScope.conditions : { mode: "all" as const, items: [initialMailAutomationCondition()] };
  const [name, setName] = createSignal(initialName);
  const [enabled, setEnabled] = createSignal(initialEnabled);
  const [scope, setScope] = createSignal<MailAutomationScope>(initialScope);
  const [matchingConditions, setMatchingConditions] = createSignal(initialMatchingConditions);
  const [stepState, setStepState] = createStore({ items: initialStepList });
  const steps = (): MailAutomationStep[] => stepState.items;
  const setSteps = (next: MailAutomationStep[]) => setStepState("items", reconcile(next, { key: "id" }));
  const [applyExisting, setApplyExisting] = createSignal(false);
  const [nameTouched, setNameTouched] = createSignal(false);
  const [scopeTouched, setScopeTouched] = createSignal(false);
  const baseline = JSON.stringify({
    name: initialName,
    enabled: initialEnabled,
    scope: initialScope,
    steps: initialStepList,
    applyExisting: false,
  });
  const dirty = () =>
    JSON.stringify({ name: name(), enabled: enabled(), scope: scope(), steps: steps(), applyExisting: applyExisting() }) !== baseline;

  const save = mutation.create<
    { automation: IncomingAutomation; backfill: IncomingAutomationBackfill | null; backfillError: string | null } | null,
    void,
    { operationId: string }
  >({
    onBefore: () => ({ operationId: crypto.randomUUID() }),
    mutation: async (_, { abortSignal, operationId }) => {
      const input = { name: name().trim(), enabled: enabled(), scope: scope(), steps: steps() };
      let shouldBackfill = applyExisting() && enabled() && !hasAi(input.steps);
      if (shouldBackfill) {
        const previewResponse = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].preview.$post(
          { param: { mailboxId: props.mailboxId }, json: { scope: input.scope } },
          { init: { signal: abortSignal } },
        );
        if (!previewResponse.ok) throw new Error(await readApiError(previewResponse, messages().couldNotPreviewExisting));
        const preview: IncomingAutomationMatchPreview = await previewResponse.json();
        if (preview.messageCount === 0) {
          toast(messages().noExistingMatches, { title: messages().futureMailOnly });
          shouldBackfill = false;
        } else {
          const confirmed = await prompts.confirm(
            preview.exact
              ? messages().exactPreviewSummary({ messages: preview.messageCount, conversations: preview.conversationCount })
              : messages().scanPreviewSummary({ messages: preview.messageCount }),
            { title: messages().applyExistingMail, confirmText: messages().saveAndStartBackfill },
          );
          if (!confirmed || abortSignal.aborted) return null;
        }
      }
      const response = props.automation
        ? await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].$put(
            {
              param: { mailboxId: props.mailboxId, automationId: props.automation.id },
              json: { ...input, expectedRevision: props.automation.revision },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"]["incoming-automations"].$post(
            { param: { mailboxId: props.mailboxId }, json: input },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotSaveIncomingAutomation));
      const automation = await response.json();
      if (!shouldBackfill) return { automation, backfill: null, backfillError: null };
      const backfillResponse = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].backfills.$post(
        {
          param: { mailboxId: props.mailboxId, automationId: automation.id },
          json: { operationId, expectedRevision: automation.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!backfillResponse.ok) {
        return {
          automation,
          backfill: null,
          backfillError: await readApiError(backfillResponse, messages().couldNotStartExistingBackfill),
        };
      }
      return { automation, backfill: await backfillResponse.json(), backfillError: null };
    },
    onSuccess: (result) => {
      if (!result) return;
      props.onSaved(result.automation);
      if (result.backfill) props.onBackfillStarted(result.backfill);
      toast.success(props.automation ? messages().incomingAutomationUpdated : messages().incomingAutomationCreated);
      props.close();
      if (result.backfillError) void prompts.error(messages().savedButBackfillFailed({ error: result.backfillError }));
    },
    onError: (error) => prompts.error(error.message),
  });

  const validation = () => createIncomingAutomationSchema.safeParse({ name: name(), enabled: enabled(), scope: scope(), steps: steps() });
  const validationMessage = (field: "name" | "scope" | "steps") => {
    if (field === "name" && !nameTouched()) return null;
    if (field === "scope" && !scopeTouched()) return null;
    const result = validation();
    if (result.success) return null;
    const issue = result.error.issues.find((candidate) => candidate.path[0] === field);
    if (!issue) return null;
    if (field === "name") return name().trim() ? messages().nameTooLong : messages().enterName;
    if (field === "scope") {
      const conditionIndex = typeof issue.path[3] === "number" ? issue.path[3] : null;
      const prefix = conditionIndex === null ? messages().condition : messages().conditionLabel({ index: conditionIndex + 1 });
      return issue.code === "custom" ? `${prefix}: ${issue.message}.` : `${prefix}: ${messages().enterValue}`;
    }
    const stepIndex = typeof issue.path[1] === "number" ? issue.path[1] : null;
    if (stepIndex === null) {
      if (issue.code === "custom") return `${issue.message}.`;
      return steps().length === 0 ? messages().addAtLeastOneStep : messages().topLevelStepLimit;
    }
    const location = [messages().stepLocation({ step: stepIndex + 1 })];
    for (let index = 2; index < issue.path.length; index += 1) {
      if (issue.path[index] === "choices" && typeof issue.path[index + 1] === "number") {
        location.push(messages().choiceLocation({ choice: (issue.path[index + 1] as number) + 1 }));
        index += 1;
        continue;
      }
      if ((issue.path[index] === "then" || issue.path[index] === "else") && typeof issue.path[index + 1] === "number") {
        location.push(
          messages().branchStepLocation({
            branch: issue.path[index] === "then" ? messages().then : messages().else,
            step: (issue.path[index + 1] as number) + 1,
          }),
        );
        index += 1;
        continue;
      }
      if (issue.path[index] === "steps" && typeof issue.path[index + 1] === "number") {
        location.push(messages().stepLocation({ step: (issue.path[index + 1] as number) + 1 }));
        index += 1;
      }
    }
    const fieldName = issue.path.at(-1);
    const message =
      issue.code === "custom"
        ? issue.message
        : fieldName === "instructions"
          ? messages().enterInstructions
          : fieldName === "name"
            ? messages().enterChoiceName
            : fieldName === "description"
              ? messages().describeChoice
              : fieldName === "senderIdentityId"
                ? messages().selectFromAddress
                : fieldName === "sourceStepId"
                  ? messages().selectEarlierOutput
                  : fieldName === "value"
                    ? issue.path.includes("body")
                      ? messages().enterText
                      : messages().enterCompareValue
                    : messages().completeRequiredFields;
    return `${location.join(", ")}: ${message}.`;
  };
  const usesAi = () => hasAi(steps());
  const closeSafely = async () => {
    if (save.loading()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  onCleanup(() => save.abort());

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.automation ? messages().editIncomingAutomation : messages().createIncomingAutomation}
        subtitle={messages().incomingEditorDescription}
        icon="ti ti-mailbox"
        close={() => void closeSafely()}
        closeDisabled={save.loading()}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().basics} subtitle={messages().basicsDescription} icon="ti ti-adjustments">
          <TextInput
            label={messages().name}
            value={name}
            onValueChange={setName}
            onBlur={() => setNameTouched(true)}
            error={() => validationMessage("name")}
            maxLength={120}
            required
          />
        </PanelDialog.Section>
        <PanelDialog.Section title={messages().when} subtitle={messages().whenDescription} icon="ti ti-filter">
          <Select
            label={messages().incomingMessages}
            value={() => scope().mode}
            onValueChange={(mode) => {
              setScopeTouched(true);
              setScope(mode === "all" ? { mode: "all" } : { mode: "matching", conditions: matchingConditions() });
            }}
            options={[
              { id: "all", label: messages().allIncomingMail, icon: "ti ti-mailbox" },
              { id: "matching", label: messages().matchingMail, icon: "ti ti-filter" },
            ]}
          />
          <Show when={scope().mode === "matching"}>
            <MailAutomationConditionsEditor
              conditions={(scope() as Extract<MailAutomationScope, { mode: "matching" }>).conditions}
              onChange={(conditions) => {
                setScopeTouched(true);
                setMatchingConditions(conditions);
                setScope({ mode: "matching", conditions });
              }}
            />
          </Show>
          <Show when={validationMessage("scope")}>
            {(message) => (
              <p class="text-xs text-red-600 dark:text-red-400" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </PanelDialog.Section>
        <AutomationStepsEditor
          mailboxId={props.mailboxId}
          steps={steps()}
          workflowSteps={steps()}
          availableActions={[]}
          catalog={props.catalog}
          onChange={setSteps}
        />
        <Show when={validationMessage("steps")}>
          {(message) => (
            <p class="text-xs text-red-600 dark:text-red-400" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <PanelDialog.Section title={messages().safety} subtitle={messages().safetyDescription} icon="ti ti-shield-check">
          <Show
            when={usesAi()}
            fallback={
              <Switch
                label={messages().applyExistingAfterSave}
                description={messages().backfillPreviewDescription}
                value={applyExisting}
                onValueChange={setApplyExisting}
                disabled={!enabled()}
              />
            }
          >
            <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
              <i class="ti ti-sparkles mt-0.5 shrink-0" aria-hidden="true" />
              <span>{messages().aiFlowNotice({ count: maxAiCalls(steps()) })}</span>
            </NoticeCard>
          </Show>
          <Switch
            label={messages().automationActive}
            value={enabled}
            onValueChange={(value) => {
              setEnabled(value);
              if (!value) setApplyExisting(false);
            }}
          />
          <p class="text-[11px] text-dimmed">{messages().completedEffectsRemain}</p>
        </PanelDialog.Section>
        <Show when={props.automation?.workflowSource}>
          <PanelDialog.Section title={messages().generatedWorkflow} subtitle={messages().generatedWorkflowDescription} icon="ti ti-code">
            <CodeDisplay code={props.automation!.workflowSource} title={messages().canonicalYaml} language="text" lineNumbers={false} />
          </PanelDialog.Section>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="min-w-0 flex-1 text-xs text-dimmed">{enabled() ? messages().appliesToNewMessages : messages().savedInactive}</span>
        <div class="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={save.loading()} onClick={() => void closeSafely()}>
            {messages().cancel}
          </Button>
          <Button type="button" size="sm" disabled={!validation().success || save.loading()} onClick={() => save.mutate()}>
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-check"}`} aria-hidden="true" />
            {props.automation ? messages().saveChanges : messages().createAutomation}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openIncomingAutomationEditor = (params: {
  mailboxId: string;
  catalog?: MailWorkflowCatalogSnapshot;
  automation?: IncomingAutomation | null;
  preset?: IncomingAutomationPreset;
  initialScope?: MailAutomationScope;
  initialAction?: AutomationActionKind;
  initialName?: string;
  onSaved: (automation: IncomingAutomation) => void;
  onBackfillStarted?: (backfill: IncomingAutomationBackfill) => void;
}) => {
  const open = async () => {
    const messages = browserMessages();
    let catalog = params.catalog;
    if (!catalog) {
      const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].catalog.$get({
        param: { mailboxId: params.mailboxId },
      });
      if (!response.ok) {
        await prompts.error(await readApiError(response, messages.couldNotLoadAutomationActions));
        return;
      }
      catalog = await response.json();
    }
    if (params.preset === "ai-draft" && (catalog.senderIdentities ?? []).length === 0) {
      await prompts.error(messages.verifyAutomationIdentity);
      return;
    }
    if (params.preset === "ai-tag" && (catalog.localTags ?? []).length < 2) {
      await prompts.error(messages.createTwoTags);
      return;
    }
    return dialogCore.open<void>(
      (close) => (
        <IncomingAutomationEditor
          mailboxId={params.mailboxId}
          catalog={catalog}
          automation={params.automation ?? null}
          preset={params.preset ?? "blank"}
          initialScope={params.initialScope}
          initialAction={params.initialAction}
          initialName={params.initialName}
          close={() => close()}
          onSaved={params.onSaved}
          onBackfillStarted={(backfill) => params.onBackfillStarted?.(backfill)}
        />
      ),
      { ...panelDialogWideOptions, cancelBehavior: "ignore" },
    );
  };
  return open();
};

export default function MailIncomingAutomationSettings(props: {
  mailboxId: string;
  catalog: MailWorkflowCatalogSnapshot;
  initialAutomations: IncomingAutomation[];
  openPreset?: IncomingAutomationPreset | null;
  onOpenPresetHandled?: () => void;
}) {
  const { locale, messages } = useMessages();
  const formatNumber = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const [automations, setAutomations] = createSignal(props.initialAutomations);
  const [backfills, setBackfills] = createSignal<Record<string, IncomingAutomationBackfill>>({});
  const [loadedBackfills, setLoadedBackfills] = createSignal<Set<string>>(new Set());
  const upsert = (automation: IncomingAutomation) =>
    setAutomations((current) =>
      [...current.filter((candidate) => candidate.id !== automation.id), automation].sort((a, b) => a.name.localeCompare(b.name)),
    );
  const rememberBackfill = (backfill: IncomingAutomationBackfill) => {
    setBackfills((current) => ({ ...current, [backfill.automationId]: backfill }));
    setLoadedBackfills((current) => new Set(current).add(backfill.automationId));
  };
  type BackfillLookup =
    | { automationId: string; status: "found"; backfill: IncomingAutomationBackfill }
    | { automationId: string; status: "missing" };
  const backfillSource = createMemo(() => {
    const operations = new Map<string, { automationId: string; operationId: string }>();
    for (const automation of props.initialAutomations) {
      if (automation.latestBackfillOperationId && !loadedBackfills().has(automation.id)) {
        operations.set(automation.id, { automationId: automation.id, operationId: automation.latestBackfillOperationId });
      }
    }
    for (const backfill of Object.values(backfills())) {
      if (activeBackfillStates.has(backfill.state)) {
        operations.set(backfill.automationId, { automationId: backfill.automationId, operationId: backfill.operationId });
      }
    }
    return JSON.stringify([...operations.values()].sort((left, right) => left.automationId.localeCompare(right.automationId)));
  });
  const backfillStatus = query.create<string, BackfillLookup[]>({
    source: backfillSource,
    enabled: () => backfillSource() !== "[]",
    load: async (serialized, { abortSignal }) =>
      Promise.all(
        (JSON.parse(serialized) as Array<{ automationId: string; operationId: string }>).map(async (operation): Promise<BackfillLookup> => {
          const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].backfills[":operationId"].$get(
            {
              param: { mailboxId: props.mailboxId, automationId: operation.automationId, operationId: operation.operationId },
            },
            { init: { signal: abortSignal } },
          );
          if (response.status === 404) return { automationId: operation.automationId, status: "missing" };
          if (!response.ok) throw new Error(await readApiError(response, messages().couldNotRefreshBackfill));
          return { automationId: operation.automationId, status: "found", backfill: await response.json() };
        }),
      ),
  });
  createEffect(() => {
    const updates = backfillStatus.data();
    if (!updates) return;
    for (const update of updates) {
      if (update.status === "found") rememberBackfill(update.backfill);
      else setLoadedBackfills((current) => new Set(current).add(update.automationId));
    }
  });
  timed.interval(() => void backfillStatus.refresh(), 1_500, { executeImmediately: false });
  const backfillLocksAutomation = (automation: IncomingAutomation): boolean => {
    const backfill = backfills()[automation.id];
    if (automation.latestBackfillOperationId && !loadedBackfills().has(automation.id)) return true;
    return Boolean(backfill && activeBackfillStates.has(backfill.state));
  };

  const toggle = mutation.create<IncomingAutomation, { automation: IncomingAutomation; enabled: boolean }>({
    mutation: async ({ automation, enabled }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].enabled.$patch(
        {
          param: { mailboxId: props.mailboxId, automationId: automation.id },
          json: { expectedRevision: automation.revision, enabled },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotChangeIncomingAutomation));
      return response.json();
    },
    onSuccess: upsert,
    onError: (error) => prompts.error(error.message),
  });

  const remove = mutation.create<IncomingAutomation | null, IncomingAutomation>({
    mutation: async (automation, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().deleteIncomingDescription({ name: automation.name }), {
        title: messages().deleteIncomingAutomation,
        confirmText: messages().deleteAutomation,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].$delete(
        {
          param: { mailboxId: props.mailboxId, automationId: automation.id },
          json: { expectedRevision: automation.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotDeleteIncomingAutomation));
      return response.json();
    },
    onSuccess: (automation) => {
      if (!automation) return;
      setAutomations((current) => current.filter((candidate) => candidate.id !== automation.id));
      toast.success(messages().incomingAutomationDeleted);
    },
    onError: (error) => prompts.error(error.message),
  });

  const startBackfill = mutation.create<IncomingAutomationBackfill | null, IncomingAutomation, { operationId: string }>({
    onBefore: () => ({ operationId: crypto.randomUUID() }),
    mutation: async (automation, { abortSignal, operationId }) => {
      if (hasAi(automation.steps)) throw new Error(messages().aiFutureOnly);
      const previewResponse = await apiClient.mailboxes[":mailboxId"]["incoming-automations"].preview.$post(
        { param: { mailboxId: props.mailboxId }, json: { scope: automation.scope } },
        { init: { signal: abortSignal } },
      );
      if (!previewResponse.ok) throw new Error(await readApiError(previewResponse, messages().couldNotPreviewExisting));
      const preview = await previewResponse.json();
      if (preview.messageCount === 0) {
        toast(messages().noExistingMatches, { title: messages().nothingToBackfill });
        return null;
      }
      const confirmed = await prompts.confirm(messages().backfillConfirmation({ count: preview.messageCount }), {
        title: messages().applyExistingMail,
        confirmText: messages().startBackfill,
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].backfills.$post(
        {
          param: { mailboxId: props.mailboxId, automationId: automation.id },
          json: { operationId, expectedRevision: automation.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotStartBackfill));
      return response.json();
    },
    onSuccess: (backfill) => {
      if (!backfill) return;
      rememberBackfill(backfill);
      toast.success(messages().backfillStarted);
    },
    onError: (error) => prompts.error(error.message),
  });

  const cancelBackfill = mutation.create<IncomingAutomationBackfill | null, IncomingAutomationBackfill>({
    mutation: async (backfill, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().stopBackfillDescription, {
        title: messages().cancelBackfillTitle,
        confirmText: messages().cancelBackfill,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["incoming-automations"][":automationId"].backfills[":operationId"].$delete(
        {
          param: { mailboxId: props.mailboxId, automationId: backfill.automationId, operationId: backfill.operationId },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotCancelBackfill));
      return response.json();
    },
    onSuccess: (backfill) => {
      if (backfill) rememberBackfill(backfill);
    },
    onError: (error) => prompts.error(error.message),
  });

  let disposed = false;
  onMount(() => {
    if (props.openPreset) {
      void (async () => {
        await waitForMailPageTransition();
        if (disposed) return;
        props.onOpenPresetHandled?.();
        await openIncomingAutomationEditor({
          mailboxId: props.mailboxId,
          catalog: props.catalog,
          preset: props.openPreset ?? "blank",
          onSaved: upsert,
          onBackfillStarted: rememberBackfill,
        });
      })();
    }
  });
  onCleanup(() => {
    disposed = true;
    toggle.abort();
    remove.abort();
    startBackfill.abort();
    cancelBackfill.abort();
  });

  const columns = createMemo<DataTableColumn<IncomingAutomation>[]>(() => [
    { id: "name", header: messages().automation, value: (automation) => automation.name },
    { id: "scope", header: messages().when, value: (automation) => scopeLabel(automation.scope, locale()) },
    { id: "flow", header: messages().flow, value: (automation) => flowLabel(automation, props.catalog, locale()) },
    {
      id: "backfill",
      header: messages().backfill,
      value: (automation) => backfills()[automation.id]?.state ?? "not_run",
      cellClass: "w-44",
    },
    { id: "enabled", header: messages().active, value: (automation) => automation.enabled, cellClass: "w-32" },
    { id: "menu", header: "", value: (automation) => automation.id, cellClass: "w-12", headerClass: "w-12" },
  ]);

  return (
    <section class="paper overflow-hidden">
      <div class="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
        <div>
          <h2 class="text-xs font-semibold text-primary">{messages().incomingAutomations}</h2>
          <p class="mt-0.5 text-[11px] text-dimmed">{messages().guidedFlowCount({ count: automations().length })}</p>
        </div>
        <Button
          size="sm"
          type="button"
          onClick={() =>
            void openIncomingAutomationEditor({
              mailboxId: props.mailboxId,
              catalog: props.catalog,
              onSaved: upsert,
              onBackfillStarted: rememberBackfill,
            })
          }
        >
          <i class="ti ti-plus" aria-hidden="true" /> {messages().createAutomation}
        </Button>
      </div>
      <DataTable
        rows={automations()}
        columns={columns()}
        getRowId={(automation) => automation.id}
        class="overflow-x-auto"
        tableClass={automations().length > 0 ? "w-full min-w-[48rem] text-xs" : "w-full text-xs"}
        hoverRows
        empty={messages().noIncomingAutomations}
        renderCell={({ row, col, render }) => {
          if (col.id === "enabled") {
            return (
              <Switch
                label={
                  <>
                    <span aria-hidden="true">{row.enabled ? messages().active : messages().inactive}</span>
                    <span class="sr-only">
                      {row.enabled ? messages().disableNamed({ name: row.name }) : messages().enableNamed({ name: row.name })}
                    </span>
                  </>
                }
                value={() => row.enabled}
                disabled={toggle.loading() || backfillLocksAutomation(row)}
                onValueChange={(enabled) => toggle.mutate({ automation: row, enabled })}
              />
            );
          }
          if (col.id === "backfill") {
            if (hasAi(row.steps)) return <span class="text-dimmed">{messages().futureOnly}</span>;
            const backfill = backfills()[row.id];
            if (row.latestBackfillOperationId && !loadedBackfills().has(row.id))
              return <span class="text-dimmed">{messages().loading}</span>;
            if (row.latestBackfillOperationId && !backfill) return <span class="text-dimmed">{messages().historyExpired}</span>;
            if (!backfill) return <span class="text-dimmed">{messages().notRun}</span>;
            const accepted = backfill.alreadyAcceptedCount + backfill.newlyAcceptedCount;
            if (activeBackfillStates.has(backfill.state)) {
              return (
                <StatusBadge
                  tone="running"
                  label={messages().backfillProgress({ accepted: formatNumber(accepted), total: formatNumber(backfill.candidateCount) })}
                />
              );
            }
            if (backfill.state === "completed")
              return <StatusBadge tone="ok" label={messages().completedNew({ count: formatNumber(backfill.newlyAcceptedCount) })} />;
            if (backfill.state === "failed") return <StatusBadge tone="warning" label={messages().failed} />;
            return <StatusBadge tone="neutral" label={messages().canceled} />;
          }
          if (col.id === "menu") {
            const backfill = backfills()[row.id];
            const active = backfillLocksAutomation(row);
            return (
              <Dropdown.Root
                position="bottom-left"
                items={[
                  ...(!active
                    ? [
                        {
                          label: messages().editAutomation,
                          icon: "ti ti-pencil",
                          action: () =>
                            void openIncomingAutomationEditor({
                              mailboxId: props.mailboxId,
                              catalog: props.catalog,
                              automation: row,
                              onSaved: upsert,
                              onBackfillStarted: rememberBackfill,
                            }),
                        },
                      ]
                    : []),
                  ...(row.enabled && !hasAi(row.steps) && !active
                    ? [
                        {
                          label: backfill || row.latestBackfillOperationId ? messages().runBackfillAgain : messages().applyToExistingMail,
                          icon: "ti ti-database-import",
                          action: () => startBackfill.mutate(row),
                        },
                      ]
                    : []),
                  ...(backfill && active
                    ? [
                        {
                          label: messages().cancelBackfill,
                          icon: "ti ti-player-stop",
                          variant: "danger" as const,
                          action: () => cancelBackfill.mutate(backfill),
                        },
                      ]
                    : []),
                  ...(!active
                    ? [
                        {
                          label: messages().deleteAutomation,
                          icon: "ti ti-trash",
                          variant: "danger" as const,
                          action: () => remove.mutate(row),
                        },
                      ]
                    : []),
                ]}
              >
                <Dropdown.Trigger iconOnly size="sm" type="button" variant="ghost" label={messages().actionsFor({ name: row.name })}>
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            );
          }
          return render(col.value instanceof Function ? col.value(row) : col.value ? row[col.value] : undefined);
        }}
      />
    </section>
  );
}
