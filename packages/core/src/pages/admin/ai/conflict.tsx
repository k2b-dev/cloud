import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX } from "solid-js";
import type { AiAdminConflict } from "./client";
import { aiAreaMessages } from "./messages";
import { formatAiTime } from "./presentation";

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** Fields both sides changed to different values; everything else merges on its own. */
export const conflictingFields = <T extends Record<string, unknown>>(base: T, mine: T, theirs: T, fields: readonly (keyof T)[]) =>
  fields.filter((field) => !same(mine[field], base[field]) && !same(theirs[field], base[field]) && !same(mine[field], theirs[field]));

/** Their stored version plus my changes; `choices` decides each field both changed. */
export const mergeDrafts = <T extends Record<string, unknown>>(
  base: T,
  mine: T,
  theirs: T,
  fields: readonly (keyof T)[],
  choices: Partial<Record<keyof T, "mine" | "theirs">>,
): T => {
  const merged = { ...theirs };
  for (const field of fields) {
    if (same(mine[field], base[field])) continue;
    const both = !same(theirs[field], base[field]) && !same(mine[field], theirs[field]);
    if (!both || choices[field] === "mine") merged[field] = mine[field];
  }
  return merged;
};

/**
 * The conflict state: who saved first and when, a choice for every field both changed, and the two ways out.
 * The form below stays as the person left it until they decide.
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
    <NoticeCard tone="warning" icon="ti ti-git-merge" title={title()} detail={t().conflictSub} role="alert">
      <div class="grid gap-3">
        <For each={overlapping()}>
          {(field) => (
            <fieldset class="grid gap-1">
              <legend class="text-sm font-medium">{field.label}</legend>
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  class="accent-(--k2b-action-solid)"
                  name={`conflict-${String(field.key)}`}
                  checked={(choices()[field.key] ?? "mine") === "mine"}
                  onChange={() => setChoices((current) => ({ ...current, [field.key]: "mine" }))}
                />
                {t().conflictMine({ value: show(field, props.mine[field.key]) })}
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  class="accent-(--k2b-action-solid)"
                  name={`conflict-${String(field.key)}`}
                  checked={choices()[field.key] === "theirs"}
                  onChange={() => setChoices((current) => ({ ...current, [field.key]: "theirs" }))}
                />
                {name()
                  ? t().conflictTheirs({ name: name()!, value: show(field, props.theirs[field.key]) })
                  : t().conflictTheirsUnknown({ value: show(field, props.theirs[field.key]) })}
              </label>
            </fieldset>
          )}
        </For>
        <div class="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            loading={props.busy}
            onClick={() => props.onMerge(mergeDrafts(props.base, props.mine, props.theirs, keys(), choices()))}
          >
            {t().conflictMerge}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={props.busy} onClick={props.onDiscard}>
            {t().conflictDiscard}
          </Button>
        </div>
      </div>
    </NoticeCard>
  );
}
