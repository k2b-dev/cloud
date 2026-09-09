import {
  Button,
  CheckboxCard,
  CopyButton,
  confirmDiscardIfDirty,
  dialogCore,
  IconButton,
  MultiSelectInput,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  Select,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import {
  type AuditQuestion,
  AuditQuestionSchema,
  type AuditRequirement,
  type AuditUpdateRequirement,
  PublicTableAuditPolicySchema,
  type TableAuditPolicy,
} from "../../../contracts";
import { gridsDialogMessages } from "./messages";

type Operation = "delete" | "restore" | "update";

const QUESTION_TYPE_OPTIONS = [
  { id: "text", label: "Short text", icon: "ti ti-cursor-text" },
  { id: "longtext", label: "Long text", icon: "ti ti-align-left" },
  { id: "select", label: "Select", icon: "ti ti-list" },
];

const emptyQuestion = (): AuditQuestion => ({
  id: crypto.randomUUID(),
  type: "text",
  label: "",
  required: true,
});

const clonePolicy = (policy: TableAuditPolicy): TableAuditPolicy => structuredClone(policy);

const defaultRequirement = (): AuditRequirement => ({ enabled: false, questions: [] });
const defaultUpdateRequirement = (): AuditUpdateRequirement => ({
  enabled: false,
  questions: [],
  scope: "all",
  fieldIds: [],
});

export const auditPolicySummary = (policy: TableAuditPolicy, locale = "en"): string => {
  const { t } = gridsDialogMessages.resolve([locale]);
  const enabled = [policy.update, policy.delete, policy.restore].filter((requirement) => requirement?.enabled);
  if (enabled.length === 0) return t.noAuditAnswers;
  const questions = enabled.reduce((count, requirement) => count + (requirement?.questions.length ?? 0), 0);
  return t.auditSummary({ operations: enabled.length, questions });
};

const openQuestionDialog = (question: AuditQuestion, locale: string): Promise<AuditQuestion | null> => {
  const { t } = gridsDialogMessages.resolve([locale]);
  const questionTypeOptions = QUESTION_TYPE_OPTIONS.map((option) => ({
    ...option,
    label: option.id === "text" ? t.shortText : option.id === "longtext" ? t.longText : t.select,
  }));
  return dialogCore
    .open<AuditQuestion | null>((close, context) => {
      const [label, setLabel] = createSignal(question.label);
      const [description, setDescription] = createSignal(question.description ?? "");
      const [type, setType] = createSignal<AuditQuestion["type"]>(question.type);
      const [required, setRequired] = createSignal(question.required);
      const [options, setOptions] = createSignal(
        question.type === "select" ? question.options.map((option) => ({ ...option })) : [{ id: crypto.randomUUID(), label: "" }],
      );

      const updateOption = (id: string, value: string) =>
        setOptions((current) => current.map((option) => (option.id === id ? { ...option, label: value } : option)));
      const [submitted, setSubmitted] = createSignal(false);
      const candidate = () => ({
        id: question.id,
        label: label(),
        description: description().trim() || undefined,
        type: type(),
        required: required(),
        ...(type() === "select" ? { options: options() } : {}),
      });
      const initialQuestion = JSON.stringify(candidate());
      const closeIfClean = async () => {
        if (await confirmDiscardIfDirty(() => JSON.stringify(candidate()) !== initialQuestion)) close(null);
      };
      context.setDismissHandler(closeIfClean);
      const save = () => {
        setSubmitted(true);
        const parsed = AuditQuestionSchema.safeParse(candidate());
        if (!parsed.success) {
          context.dialog
            .querySelector<HTMLElement>('[data-invalid="true"] input, input[data-invalid="true"], textarea[data-invalid="true"]')
            ?.focus();
          return;
        }
        close(parsed.data);
      };

      return (
        <PanelDialog>
          <PanelDialog.Header
            title={question.label ? t.editAuditQuestion : t.addAuditQuestion}
            icon="ti ti-message-question"
            close={closeIfClean}
          />
          <PanelDialog.Body>
            <PanelDialog.Section title={t.question} subtitle={t.questionDescription} icon="ti ti-message-question">
              <TextInput
                label={t.label}
                value={label}
                onValueChange={setLabel}
                placeholder={t.auditLabelPlaceholder}
                required
                maxLength={200}
                error={() => (submitted() && !label().trim() ? t.auditLabelRequired : undefined)}
              />
              <TextInput
                label={t.guidance}
                value={description}
                onValueChange={setDescription}
                placeholder={t.guidancePlaceholder}
                multiline
                lines={2}
                maxLength={1_000}
              />
              <Select
                label={t.answerType}
                value={type}
                onValueChange={(value) => setType(value as AuditQuestion["type"])}
                options={questionTypeOptions}
                required
              />
              <CheckboxCard
                label={t.answerRequired}
                description={t.answerRequiredDescription}
                icon="ti ti-asterisk"
                variant="input"
                value={required}
                onValueChange={setRequired}
              />
            </PanelDialog.Section>

            <Show when={type() === "select"}>
              <PanelDialog.Section title={t.options} subtitle={t.auditOptionsDescription} icon="ti ti-list">
                <div class="flex flex-col gap-2">
                  <For each={options()}>
                    {(option, index) => (
                      <div class="flex items-end gap-2">
                        <div class="min-w-0 flex-1">
                          <TextInput
                            label={t.option({ number: index() + 1 })}
                            value={() => option.label}
                            onValueChange={(value) => updateOption(option.id, value)}
                            placeholder={t.optionLabel}
                            required
                            maxLength={200}
                            error={() => (submitted() && !option.label.trim() ? t.auditOptionRequired : undefined)}
                          />
                        </div>
                        <Tooltip.Anchor content={t.removeOption}>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            class="mb-1 text-dimmed hover:text-red-600"
                            label={t.removeOptionNumber({ number: index() + 1 })}
                            disabled={options().length === 1}
                            onClick={() => setOptions((current) => current.filter((candidate) => candidate.id !== option.id))}
                          >
                            <i class="ti ti-trash" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </div>
                    )}
                  </For>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    class="self-start"
                    disabled={options().length >= 100}
                    onClick={() => setOptions((current) => [...current, { id: crypto.randomUUID(), label: "" }])}
                  >
                    <i class="ti ti-plus" /> {t.addOption}
                  </Button>
                </div>
              </PanelDialog.Section>
            </Show>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={closeIfClean}>
                {t.cancel}
              </Button>
              <Button variant="primary" size="sm" type="button" onClick={save}>
                {t.saveQuestion}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogOptions)
    .then((result) => result ?? null);
};

function RequirementQuestions(props: { questions: () => AuditQuestion[]; onChange: (questions: AuditQuestion[]) => void }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const questionTypeLabel = (type: AuditQuestion["type"]) =>
    type === "text" ? t().shortText : type === "longtext" ? t().longText : t().select;
  const edit = async (question: AuditQuestion) => {
    const updated = await openQuestionDialog(question, locale());
    if (!updated) return;
    props.onChange(props.questions().map((candidate) => (candidate.id === updated.id ? updated : candidate)));
  };
  const add = async () => {
    const question = await openQuestionDialog(emptyQuestion(), locale());
    if (question) props.onChange([...props.questions(), question]);
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={props.questions().length === 0}>
        <p class="text-sm text-dimmed">{t().noQuestions}</p>
      </Show>
      <For each={props.questions()}>
        {(question) => (
          <div class="paper flex min-w-0 items-center gap-3 p-2">
            <i
              class={`ti ${question.type === "select" ? "ti-list" : question.type === "longtext" ? "ti-align-left" : "ti-cursor-text"} text-dimmed`}
            />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-primary">{question.label}</div>
              <div class="text-xs text-dimmed">
                {question.required ? t().required : t().optional} · {questionTypeLabel(question.type)}
              </div>
            </div>
            <Tooltip.Anchor content={t().editQuestion}>
              <IconButton
                variant="ghost"
                size="sm"
                type="button"
                label={t().editNamed({ label: question.label })}
                onClick={() => void edit(question)}
              >
                <i class="ti ti-pencil" />
              </IconButton>
            </Tooltip.Anchor>
            <CopyButton text={question.id} label={t().copyId} variant="ghost" size="sm" />
            <Tooltip.Anchor content={t().removeQuestion}>
              <IconButton
                variant="ghost"
                size="sm"
                type="button"
                class="text-dimmed hover:text-red-600"
                label={t().removeNamed({ label: question.label })}
                onClick={() => props.onChange(props.questions().filter((candidate) => candidate.id !== question.id))}
              >
                <i class="ti ti-trash" />
              </IconButton>
            </Tooltip.Anchor>
          </div>
        )}
      </For>
      <Button variant="secondary" size="sm" type="button" class="self-start" onClick={() => void add()}>
        <i class="ti ti-plus" /> {t().addQuestion}
      </Button>
    </div>
  );
}

function RequirementEditor(props: {
  operation: Operation;
  requirement: () => AuditRequirement | AuditUpdateRequirement;
  fields: Field[];
  onChange: (requirement: AuditRequirement | AuditUpdateRequirement) => void;
  error?: string;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const copy = (patch: Partial<AuditRequirement | AuditUpdateRequirement>) =>
    props.onChange({ ...props.requirement(), ...patch } as AuditRequirement | AuditUpdateRequirement);
  const title = () => (props.operation === "delete" ? t().moveTrash : props.operation === "restore" ? t().restoreTrash : t().editRecord);
  const description = () =>
    props.operation === "delete"
      ? t().auditDeleteDescription
      : props.operation === "restore"
        ? t().auditRestoreDescription
        : t().auditUpdateDescription;
  const updateRequirement = () => props.requirement() as AuditUpdateRequirement;

  return (
    <PanelDialog.Section
      title={title()}
      subtitle={description()}
      icon={props.operation === "delete" ? "ti ti-trash" : props.operation === "restore" ? "ti ti-arrow-back-up" : "ti ti-pencil"}
    >
      <Show when={props.error}>
        <NoticeCard tone="danger" title={props.error} />
      </Show>
      <CheckboxCard
        label={t().requireAuditAnswers}
        description={t().requireAuditAnswersDescription}
        icon="ti ti-shield-check"
        variant="input"
        value={() => props.requirement().enabled}
        onValueChange={(enabled) => copy({ enabled })}
      />
      <Show when={props.requirement().enabled}>
        <Show when={props.operation === "update"}>
          <Select
            label={t().applyWhen}
            value={() => updateRequirement().scope}
            onValueChange={(scope) =>
              copy({ scope: scope as "all" | "selected", fieldIds: scope === "all" ? [] : updateRequirement().fieldIds })
            }
            options={[
              { id: "all", label: t().anyFieldChanges },
              { id: "selected", label: t().selectedFieldsChange },
            ]}
          />
          <Show when={updateRequirement().scope === "selected"}>
            <MultiSelectInput
              label={t().fields}
              description={t().selectedFieldsDescription}
              value={() => updateRequirement().fieldIds}
              onValueChange={(fieldIds) => copy({ fieldIds })}
              options={props.fields.filter((field) => !field.deletedAt).map((field) => ({ id: field.id, label: field.name }))}
              icon="ti ti-columns"
              clearable
              required
            />
          </Show>
        </Show>
        <RequirementQuestions questions={() => props.requirement().questions} onChange={(questions) => copy({ questions })} />
      </Show>
    </PanelDialog.Section>
  );
}

export const openAuditPolicyDialog = (args: {
  tableName: string;
  fields: Field[];
  value: TableAuditPolicy;
}): Promise<TableAuditPolicy | null> =>
  dialogCore
    .open<TableAuditPolicy | null>((close, context) => {
      const locale = useLocale();
      const t = () => gridsDialogMessages.resolve([locale()]).t;
      const [policy, setPolicy] = createSignal<TableAuditPolicy>(clonePolicy(args.value));
      const [errors, setErrors] = createSignal<Partial<Record<Operation, string>>>({});
      const closeIfClean = async () => {
        if (await confirmDiscardIfDirty(() => JSON.stringify(policy()) !== JSON.stringify(args.value))) close(null);
      };
      context.setDismissHandler(closeIfClean);
      const requirement = (operation: Operation): AuditRequirement | AuditUpdateRequirement =>
        policy()[operation] ?? (operation === "update" ? defaultUpdateRequirement() : defaultRequirement());
      const updateRequirement = (operation: Operation, value: AuditRequirement | AuditUpdateRequirement) => {
        setErrors((current) => ({ ...current, [operation]: undefined }));
        setPolicy((current) => ({ ...current, [operation]: value }));
      };

      const save = () => {
        const parsed = PublicTableAuditPolicySchema.safeParse(policy());
        if (!parsed.success) {
          const next: Partial<Record<Operation, string>> = {};
          for (const issue of parsed.error.issues) {
            const operation = issue.path[0];
            if (operation === "update" || operation === "delete" || operation === "restore") {
              next[operation] =
                issue.path[1] === "fieldIds"
                  ? t().auditSelectFields
                  : requirement(operation).questions.length === 0
                    ? t().auditQuestionMissing
                    : issue.message === "Audit question labels must be unique"
                      ? t().auditQuestionDuplicates
                      : issue.message === "Select option labels must be unique"
                        ? t().auditOptionsDuplicates
                        : t().auditQuestionsGuidance;
            }
          }
          setErrors(next);
          context.dialog.querySelector<HTMLElement>('[role="alert"]')?.scrollIntoView({ block: "nearest" });
          return;
        }
        close(parsed.data);
      };

      return (
        <PanelDialog>
          <PanelDialog.Header title={t().auditRequirements} subtitle={args.tableName} icon="ti ti-shield-check" close={closeIfClean} />
          <PanelDialog.Body>
            <NoticeCard tone="info" title={t().askReason} detail={t().askReasonDetail} />
            <RequirementEditor
              operation="update"
              error={errors().update}
              requirement={() => requirement("update")}
              fields={args.fields}
              onChange={(value) => updateRequirement("update", value)}
            />
            <RequirementEditor
              operation="delete"
              error={errors().delete}
              requirement={() => requirement("delete")}
              fields={args.fields}
              onChange={(value) => updateRequirement("delete", value)}
            />
            <RequirementEditor
              operation="restore"
              error={errors().restore}
              requirement={() => requirement("restore")}
              fields={args.fields}
              onChange={(value) => updateRequirement("restore", value)}
            />
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={closeIfClean}>
                {t().cancel}
              </Button>
              <Button variant="primary" size="sm" type="button" onClick={save}>
                {t().apply}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogOptions)
    .then((result) => result ?? null);
