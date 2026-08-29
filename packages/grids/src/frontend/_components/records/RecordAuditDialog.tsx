import { Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { AuditRequirement, AuditUpdateRequirement, RecordMutationAudit } from "../../../contracts";
import { recordMessages } from "./messages";

type OpenRecordAuditDialogArgs = {
  operation: "update" | "delete" | "restore";
  requirement: AuditRequirement | AuditUpdateRequirement;
  recordTitle: string;
};

export const openRecordAuditDialog = (args: OpenRecordAuditDialogArgs): Promise<RecordMutationAudit | null> =>
  dialogCore
    .open<RecordMutationAudit | null>((close) => {
      const locale = useLocale();
      const t = () => recordMessages.resolve([locale()]).t;
      const operationCopy = {
        update: {
          title: t().explainChanges,
          subtitle: t().explainChangesSubtitle,
          action: t().saveChanges,
          icon: "ti ti-pencil",
          actionVariant: "primary" as const,
        },
        delete: {
          title: t().moveToTrash,
          subtitle: t().moveToTrashSubtitle,
          action: t().moveToTrash,
          icon: "ti ti-trash",
          actionVariant: "danger" as const,
        },
        restore: {
          title: t().restoreRecord,
          subtitle: t().restoreSubtitle,
          action: t().restore,
          icon: "ti ti-arrow-back-up",
          actionVariant: "primary" as const,
        },
      };
      const copy = operationCopy[args.operation];
      const [answers, setAnswers] = createSignal<Record<string, string>>({});
      const [errors, setErrors] = createSignal<Record<string, string>>({});
      const setAnswer = (questionId: string, value: string) => {
        setAnswers((current) => ({ ...current, [questionId]: value }));
        setErrors((current) => {
          if (!current[questionId]) return current;
          const next = { ...current };
          delete next[questionId];
          return next;
        });
      };
      const submit = () => {
        const nextErrors: Record<string, string> = {};
        for (const question of args.requirement.questions) {
          if (question.required && !answers()[question.id]?.trim()) nextErrors[question.id] = t().required;
        }
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        close({ answers: answers() });
      };

      return (
        <PanelDialog>
          <PanelDialog.Header title={copy.title} subtitle={args.recordTitle} icon={copy.icon} close={() => close(null)} />
          <PanelDialog.Body>
            <NoticeCard tone="info" title={t().whyRequired} detail={copy.subtitle} />
            <PanelDialog.Section title={t().auditDetails} subtitle={t().auditPermanent} icon="ti ti-shield-check">
              <For each={args.requirement.questions}>
                {(question) => (
                  <Show
                    when={question.type === "select"}
                    fallback={
                      <TextInput
                        label={question.label}
                        description={question.description}
                        value={() => answers()[question.id] ?? ""}
                        onValueChange={(value) => setAnswer(question.id, value)}
                        error={() => errors()[question.id]}
                        multiline={question.type === "longtext"}
                        lines={question.type === "longtext" ? 4 : undefined}
                        required={question.required}
                      />
                    }
                  >
                    <Select
                      label={question.label}
                      description={question.description}
                      value={() => answers()[question.id] ?? null}
                      onValueChange={(value) => setAnswer(question.id, value ?? "")}
                      error={() => errors()[question.id]}
                      options={question.type === "select" ? question.options.map((option) => ({ id: option.id, label: option.label })) : []}
                      placeholder={t().chooseOption}
                      clearable={!question.required}
                      required={question.required}
                    />
                  </Show>
                )}
              </For>
            </PanelDialog.Section>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={() => close(null)}>
                {t().cancel}
              </Button>
              <Button variant={copy.actionVariant} size="sm" onClick={submit}>
                <i class={copy.icon} /> {copy.action}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogOptions)
    .then((result) => result ?? null);
