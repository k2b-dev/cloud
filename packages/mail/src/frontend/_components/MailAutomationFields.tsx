import { Button, IconButton, Select, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { MailAutomationAction, MailAutomationCondition, MailAutomationConditions } from "../../contracts";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";
import {
  type AutomationActionKind,
  createMailAutomationAction,
  mailAutomationActionKindsFor,
  mailAutomationDestinationFolders,
  mailAutomationStatusLabels,
} from "./mail-automation-actions";
import { mailRemainingMessages } from "./mail-remaining-messages";

type ConditionField = MailAutomationCondition["field"];
type TextCondition = Extract<MailAutomationCondition, { field: "subject" | "body_text" }>;
type TextOperator = TextCondition["operator"];

const conditionFieldMessage = (field: ConditionField, locale: string): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  return {
    sender_address: messages.senderAddress,
    sender_domain: messages.senderDomain,
    subject: messages.subject,
    body_text: messages.messageBody,
    attachment_presence: messages.attachments,
  }[field];
};

export const initialMailAutomationCondition = (field: ConditionField = "sender_address"): MailAutomationCondition => {
  if (field === "attachment_presence") return { field, operator: "is", value: true };
  if (field === "sender_address" || field === "sender_domain") return { field, operator: "is", value: "" };
  return { field, operator: "contains", value: "" };
};

export const mailAutomationConditionLabel = (condition: MailAutomationCondition, locale = "en"): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (condition.field === "attachment_presence") return condition.value ? messages.hasAttachments : messages.hasNoAttachments;
  if (condition.field === "sender_address") return condition.value;
  if (condition.field === "sender_domain") return `*@${condition.value}`;
  return `${conditionFieldMessage(condition.field, locale)} ${messages.textOperator({ operator: condition.operator })} “${condition.value}”`;
};

export function MailAutomationConditionsEditor(props: {
  conditions: MailAutomationConditions;
  onChange: (conditions: MailAutomationConditions) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const conditionFieldLabels = createMemo<Record<ConditionField, string>>(() => ({
    sender_address: messages().senderAddress,
    sender_domain: messages().senderDomain,
    subject: messages().subject,
    body_text: messages().messageBody,
    attachment_presence: messages().attachments,
  }));
  const textOperatorLabels = createMemo<Record<TextOperator, string>>(() => ({
    is: messages().textOperator({ operator: "is" }),
    contains: messages().textOperator({ operator: "contains" }),
    starts_with: messages().textOperator({ operator: "starts_with" }),
    ends_with: messages().textOperator({ operator: "ends_with" }),
  }));
  const [conditionIds, setConditionIds] = createSignal(props.conditions.items.map(() => crypto.randomUUID()));
  const replace = (index: number, condition: MailAutomationCondition) =>
    props.onChange({
      ...props.conditions,
      items: props.conditions.items.map((candidate, candidateIndex) => (candidateIndex === index ? condition : candidate)),
    });
  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= props.conditions.items.length) return;
    const items = [...props.conditions.items];
    [items[index], items[destination]] = [items[destination]!, items[index]!];
    setConditionIds((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      return next;
    });
    props.onChange({ ...props.conditions, items });
  };
  const remove = (index: number) => {
    setConditionIds((current) => current.filter((_, candidateIndex) => candidateIndex !== index));
    props.onChange({
      ...props.conditions,
      items: props.conditions.items.filter((_, candidateIndex) => candidateIndex !== index),
    });
  };
  const add = () => {
    setConditionIds((current) => [...current, crypto.randomUUID()]);
    props.onChange({ ...props.conditions, items: [...props.conditions.items, initialMailAutomationCondition("subject")] });
  };

  return (
    <div class="flex flex-col gap-2">
      <For each={conditionIds()}>
        {(conditionId) => {
          const index = () => conditionIds().indexOf(conditionId);
          const condition = () => props.conditions.items[index()]!;
          return (
            <div
              class="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-2"
              role="group"
              aria-label={messages().conditionLabel({ index: index() + 1 })}
            >
              <div class="flex flex-wrap items-end gap-2 md:flex-nowrap">
                <div class="min-w-40 flex-[1_1_11rem]">
                  <Select
                    label={messages().field}
                    value={() => condition().field}
                    onValueChange={(field) => replace(index(), initialMailAutomationCondition(field as ConditionField))}
                    options={Object.entries(conditionFieldLabels()).map(([id, label]) => ({ id, label }))}
                  />
                </div>
                <Show when={condition().field === "subject" || condition().field === "body_text"}>
                  <div class="min-w-32 flex-[0.75_1_9rem]">
                    <Select
                      label={messages().operator}
                      value={() => {
                        const current = condition();
                        return current.field === "subject" || current.field === "body_text" ? current.operator : "is";
                      }}
                      onValueChange={(operator) => {
                        const current = condition();
                        if (current.field === "subject" || current.field === "body_text") {
                          replace(index(), { ...current, operator: operator as TextOperator });
                        }
                      }}
                      options={Object.entries(textOperatorLabels()).map(([id, label]) => ({ id, label }))}
                    />
                  </div>
                </Show>
                <div class="min-w-48 flex-[1.5_1_16rem]">
                  <Show
                    when={condition().field === "attachment_presence"}
                    fallback={
                      <TextInput
                        label={messages().value}
                        type={condition().field === "sender_address" ? "email" : "text"}
                        value={() => {
                          const current = condition();
                          return current.field === "attachment_presence" ? "" : current.value;
                        }}
                        onValueChange={(value) => {
                          const current = condition();
                          if (current.field !== "attachment_presence") replace(index(), { ...current, value });
                        }}
                        placeholder={
                          condition().field === "sender_address"
                            ? "sender@example.com"
                            : condition().field === "sender_domain"
                              ? "example.com"
                              : messages().textToMatch
                        }
                        maxLength={condition().field === "sender_address" || condition().field === "sender_domain" ? 320 : 1_000}
                        required
                      />
                    }
                  >
                    <Select
                      label={messages().value}
                      value={() => (condition().field === "attachment_presence" && condition().value ? "yes" : "no")}
                      onValueChange={(value) => replace(index(), { field: "attachment_presence", operator: "is", value: value === "yes" })}
                      options={[
                        { id: "yes", label: messages().hasAttachments },
                        { id: "no", label: messages().hasNoAttachments },
                      ]}
                    />
                  </Show>
                </div>
                <div class="flex h-9 shrink-0 items-center gap-1">
                  <IconButton
                    size="sm"
                    type="button"
                    label={messages().moveConditionUp({ index: index() + 1 })}
                    disabled={index() === 0}
                    onClick={() => move(index(), -1)}
                  >
                    <i class="ti ti-arrow-up" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    type="button"
                    label={messages().moveConditionDown({ index: index() + 1 })}
                    disabled={index() === props.conditions.items.length - 1}
                    onClick={() => move(index(), 1)}
                  >
                    <i class="ti ti-arrow-down" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    type="button"
                    label={messages().removeIndexedCondition({ index: index() + 1 })}
                    disabled={props.conditions.items.length === 1}
                    onClick={() => remove(index())}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            </div>
          );
        }}
      </For>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.conditions.items.length < 8}>
          <Button size="sm" variant="input" type="button" onClick={add}>
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addCondition}
          </Button>
        </Show>
        <Show when={props.conditions.items.length > 1}>
          <div class="w-56">
            <Select
              aria-label={messages().matchConditions}
              value={() => props.conditions.mode}
              onValueChange={(mode) => props.onChange({ ...props.conditions, mode: mode as MailAutomationConditions["mode"] })}
              options={[
                { id: "all", label: messages().matchAll, icon: "ti ti-list-check" },
                { id: "any", label: messages().matchAny, icon: "ti ti-list-details" },
              ]}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}

export function MailAutomationActionEditor(props: {
  action: MailAutomationAction;
  otherActions: MailAutomationAction[];
  catalog: MailWorkflowCatalogSnapshot;
  onChange: (action: MailAutomationAction) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const kinds = () =>
    mailAutomationActionKindsFor({
      actions: [...props.otherActions, props.action],
      catalog: props.catalog,
      index: props.otherActions.length,
    });
  const setKind = (kind: AutomationActionKind) => {
    const action = createMailAutomationAction({
      kind,
      actions: [...props.otherActions, props.action],
      catalog: props.catalog,
      index: props.otherActions.length,
    });
    if (action) props.onChange(action);
  };

  return (
    <div class="grid gap-2 md:grid-cols-2">
      <Select
        label={messages().mailAction}
        value={() => props.action.kind}
        onValueChange={(kind) => setKind(kind as AutomationActionKind)}
        options={kinds().map((kind) => ({ id: kind, label: messages().automationAction({ kind }) }))}
      />
      <Show when={props.action.kind === "add_keyword"}>
        <TextInput
          label={messages().providerKeyword}
          value={() => (props.action.kind === "add_keyword" ? props.action.keyword : "")}
          onValueChange={(keyword) => props.onChange({ kind: "add_keyword", keyword })}
          maxLength={100}
          required
        />
      </Show>
      <Show when={props.action.kind === "move_to_folder"}>
        <Select
          label={messages().destinationFolder}
          value={() => (props.action.kind === "move_to_folder" ? props.action.folderId : "")}
          onValueChange={(folderId) => props.onChange({ kind: "move_to_folder", folderId: folderId ?? "" })}
          options={mailAutomationDestinationFolders(props.catalog).map((folder) => ({ id: folder.id, label: folder.name }))}
        />
      </Show>
      <Show when={props.action.kind === "add_local_tag"}>
        <Select
          label={messages().tag}
          value={() => (props.action.kind === "add_local_tag" ? props.action.tagId : "")}
          onValueChange={(tagId) => props.onChange({ kind: "add_local_tag", tagId: tagId ?? "" })}
          options={(props.catalog.localTags ?? []).map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
        />
      </Show>
      <Show when={props.action.kind === "assign_user"}>
        <Select
          label={messages().assignee}
          value={() => (props.action.kind === "assign_user" ? props.action.userId : "")}
          onValueChange={(userId) => props.onChange({ kind: "assign_user", userId: userId ?? "" })}
          options={props.catalog.assignableUsers.map((user) => ({ id: user.id, label: user.name }))}
        />
      </Show>
      <Show when={props.action.kind === "set_status"}>
        <Select
          label={messages().conversationStatus}
          value={() => (props.action.kind === "set_status" ? props.action.status : "")}
          onValueChange={(status) =>
            props.onChange({ kind: "set_status", status: status as Extract<MailAutomationAction, { kind: "set_status" }>["status"] })
          }
          options={Object.keys(mailAutomationStatusLabels).map((id) => ({ id, label: messages().automationStatus({ status: id }) }))}
        />
      </Show>
    </div>
  );
}
