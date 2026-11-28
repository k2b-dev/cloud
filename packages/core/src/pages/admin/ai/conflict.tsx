import { Choice, Notice, useLocale } from "@k2b/ui/v2";
import { createSignal, For, type JSX } from "solid-js";
import type { AiAdminConflict } from "./client";
import { conflictingFields, DEFAULT_CONFLICT_CHOICE, mergeDrafts } from "./merge-drafts";
import { aiAreaMessages } from "./messages";
import { formatAiTime } from "./presentation";

/**
 * The conflict state: who saved first and when, the two ways out, and under it a choice for every field both
 * changed (mine by default). The form below stays as the person left it until they decide.
 */
export function ConflictNotice<T extends Record<string, unknown>>(props: {
  conflict: AiAdminConflict;
  fields: { key: keyof T; label: string; format?: (value: unknown) => string }[];
  base: T;
  mine: T;
  theirs: T;
  busy?: boolean;
  onMerge: (merged: T) => void;
  onDiscard: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [choices, setChoices] = createSignal<Partial<Record<keyof T, "mine" | "theirs">>>({});
  const keys = () => props.fields.map((field) => field.key);
  const overlapping = () =>
    props.fields.filter((field) => conflictingFields(props.base, props.mine, props.theirs, keys()).includes(field.key));
  const show = (field: (typeof props.fields)[number], value: unknown) => {
    const text = field.format ? field.format(value) : value === null || value === undefined || value === "" ? "" : String(value);
    return text || t().emptyValue;
  };
  const name = () => props.conflict.changedBy?.name;
  const title = () =>
    name() ? t().conflictTitle({ name: name()!, time: formatAiTime(locale(), props.conflict.changedAt) }) : t().conflictTitleUnknown;
  return (
    <>
      <Notice
        tone="warn"
        icon="git-merge"
        title={title()}
        actions={[{ label: t().conflictDiscard, disabled: props.busy, onClick: props.onDiscard }]}
        primary={{
          label: t().conflictMerge,
          disabled: props.busy,
          onClick: () => props.onMerge(mergeDrafts(props.base, props.mine, props.theirs, keys(), choices())),
        }}
      >
        {t().conflictSub}
      </Notice>
      <For each={overlapping()}>
        {(field) => (
          <Choice
            name={`conflict-${String(field.key)}`}
            label={field.label}
            value={choices()[field.key] ?? DEFAULT_CONFLICT_CHOICE}
            onChange={(value) => setChoices((current) => ({ ...current, [field.key]: value === "theirs" ? "theirs" : "mine" }))}
            options={[
              { value: "mine", label: t().conflictMine({ value: show(field, props.mine[field.key]) }) },
              {
                value: "theirs",
                label: name()
                  ? t().conflictTheirs({ name: name()!, value: show(field, props.theirs[field.key]) })
                  : t().conflictTheirsUnknown({ value: show(field, props.theirs[field.key]) }),
              },
            ]}
          />
        )}
      </For>
    </>
  );
}
