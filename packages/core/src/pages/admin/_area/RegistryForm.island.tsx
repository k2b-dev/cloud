import { coreClient } from "@k2b/cloud/clients/core";
import SettingsSaveOutcome from "@k2b/cloud/ssr/SettingsSaveOutcome";
import { createSettingsDraft, SaveRejected, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { Button, ButtonLink, Checkbox, InlineGuidance, readSettingsError, SettingsSection, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { localizeSettingField } from "../settings/_components/setting-copy";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { FieldInput, settingControlId } from "../settings/_components/setting-inputs";
import { type AreaFormMessages, areaFormMessages } from "./messages";

/**
 * One group of fields, in the order the area chose. `shownWhen` hides a field until another field of the form has a
 * given value, such as the URL of a legal page only for the mode "external". `link` opens a related page.
 */
export type RegistryFormSection = {
  title: string;
  description?: string;
  keys: string[];
  shownWhen?: Record<string, { key: string; value: string | boolean }>;
  link?: { label: string; href: string };
};

type Values = Record<string, unknown>;
type Conflict = { key: string; current: unknown; who: string | null; at: string; version: string | null };

const preview = (entry: SettingFieldDef, value: unknown, t: AreaFormMessages): string => {
  if (entry.kind === "secret") return value ? "••••••" : t.emptyValue;
  if (value === null || value === undefined || value === "") return t.emptyValue;
  return Array.isArray(value) ? value.join(", ") : String(value);
};
const sourceText = (entry: SettingFieldDef, t: AreaFormMessages) =>
  entry.valueSource === "custom" ? t.sourceCustom : entry.valueSource === "env" ? t.sourceEnv : t.sourceDefault;
// Secrets come redacted; an empty draft keeps the stored secret.
const initialValues = (entries: SettingFieldDef[]): Values =>
  Object.fromEntries(entries.map((entry) => [entry.key, entry.kind === "secret" ? "" : entry.value]));

/**
 * The registry settings of one admin section, grouped and ordered by hand. It saves with the button in the level head
 * through Core's settings API: a stale version reports who changed what, an unreadable stored value is replaced only
 * after the person confirms it, and "Use default" removes the own value on save.
 */
export default function RegistryForm(props: {
  groups: string[];
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
  /** Keys whose saved value changes what the server shows next to the form; saving one of them reloads the page. */
  reloadAfter?: string[];
}) {
  const locale = useLocale();
  const t = () => areaFormMessages.resolve([locale()]).t;
  const [entries, setEntries] = createSignal(props.entries);
  const entry = (key: string) => localizeSettingField(entries().find((candidate) => candidate.key === key)!, locale());
  const [resets, setResets] = createSignal<string[]>([]);
  const [replace, setReplace] = createSignal<string[]>([]);
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});
  const [conflict, setConflict] = createSignal<Conflict | null>(null);
  // The version each key was read at; "Save my value" moves it to the other person's save.
  const [seenAt, setSeenAt] = createSignal<Record<string, string | null>>(
    Object.fromEntries(props.entries.map((item) => [item.key, item.updatedAt ?? null])),
  );
  const unreadable = (key: string) => entries().find((item) => item.key === key)?.unreadable === true;
  const confirmed = (key: string) => unreadable(key) && replace().includes(key);

  const fetchEntries = async (): Promise<SettingFieldDef[]> => {
    const lists = await Promise.all(
      props.groups.map(async (group) => {
        const response = await coreClient.admin.core.settings.entries.$get({ query: { group } });
        if (!response.ok) throw new Error(t().saveFailed);
        return ((await response.json()) as { items: SettingFieldDef[] }).items;
      }),
    );
    const keys = new Set(props.entries.map((item) => item.key));
    return lists.flat().filter((item) => keys.has(item.key));
  };
  /**
   * Reads the current values without losing edits: an untouched field and every field in `adopt` take the stored
   * value and its version; an edited field keeps the person's value and the version it was read at, so saving it
   * still reports a change someone else made.
   */
  const rebase = async (adopt: readonly string[]) => {
    const next = await fetchEntries();
    const before = form.stored();
    const draft = form.draft();
    const untouched = (key: string) => adopt.includes(key) || JSON.stringify(draft[key]) === JSON.stringify(before[key]);
    setSeenAt(
      Object.fromEntries(next.map((item) => [item.key, untouched(item.key) ? (item.updatedAt ?? null) : (seenAt()[item.key] ?? null)])),
    );
    setEntries(next);
    form.rebase(initialValues(next), adopt);
  };
  const forgetKey = (key: string) => {
    setResets(resets().filter((item) => item !== key));
    setReplace(replace().filter((item) => item !== key));
    const { [key]: _cleared, ...rest } = fieldErrors();
    setFieldErrors(rest);
  };

  const form = createSettingsDraft<Values>({
    initial: initialValues(props.entries),
    locale,
    pending: () => resets().length > 0 || replace().some(confirmed),
    // Only client rules block Save. Errors the server reported stay at their fields until changed, and Save retries.
    validate: (value) => {
      const errors: Record<string, string> = {};
      for (const item of entries()) {
        const current = value[item.key];
        if (item.kind !== "number" || typeof current !== "number") continue;
        if (item.min !== undefined && current < item.min) errors[item.key] = t().atLeast({ min: item.min });
        if (item.max !== undefined && current > item.max) errors[item.key] = t().atMost({ max: item.max });
      }
      return errors;
    },
    onDiscard: () => {
      setResets([]);
      setReplace([]);
      setFieldErrors({});
      setConflict(null);
    },
    save: async (value) => {
      const stored = form.stored();
      const updates: Values = {};
      for (const item of entries()) {
        if (resets().includes(item.key)) continue;
        const draftValue = value[item.key];
        if (item.kind === "secret" && draftValue === "") continue;
        if (JSON.stringify(draftValue) !== JSON.stringify(stored[item.key]) || confirmed(item.key)) updates[item.key] = draftValue;
      }
      const keys = [...Object.keys(updates), ...resets()];
      const response = await coreClient.admin.core.settings.$put({
        json: {
          updates,
          resets: resets(),
          replaceUnreadable: Object.keys(updates).filter(confirmed),
          expectedUpdatedAt: Object.fromEntries(keys.map((key) => [key, seenAt()[key] ?? null])),
        },
      });
      if (!response.ok) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as Record<string, unknown> | null;
        if (response.status === 409 && body?.code === "conflict" && typeof body.key === "string") {
          const by = body.changedBy as { name?: string } | null | undefined;
          const changedAt = String(body.changedAt ?? "");
          setConflict({
            key: body.key,
            current: body.current,
            who: by?.name ?? null,
            at: changedAt,
            // A row someone removed reports the epoch; the version to expect then is "no row".
            version: !changedAt || changedAt === new Date(0).toISOString() ? null : changedAt,
          });
          throw new SaveRejected(t().conflict({ who: by?.name ?? t().someoneElse, time: timeOf(changedAt) }));
        }
        if (response.status === 409 && body?.code === "setting_unreadable") await rebase([]).catch(() => undefined);
        const { message, fields } = await readSettingsError(response, t().saveFailed);
        const { _form: _formError, ...byField } = fields;
        setFieldErrors(byField);
        // A transaction that reported its errors rolled back; anything else may have been stored.
        if (response.status >= 500 && Object.keys(fields).length === 0) throw saveFailure(response.status, message);
        throw new SaveRejected(message);
      }
      if (keys.some((key) => props.reloadAfter?.includes(key))) {
        window.location.reload();
        return value;
      }
      setFieldErrors({});
      setConflict(null);
      setResets([]);
      setReplace([]);
      const next = await fetchEntries();
      setEntries(next);
      setSeenAt(Object.fromEntries(next.map((item) => [item.key, item.updatedAt ?? null])));
      return initialValues(next);
    },
  });
  const timeOf = (iso: string) =>
    iso && iso !== new Date(0).toISOString()
      ? new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
      : "";

  const takeTheirs = async () => {
    const current = conflict();
    if (!current) return;
    forgetKey(current.key);
    setConflict(null);
    await rebase([current.key]).catch(() => form.update({ [current.key]: current.current }));
  };
  const keepMine = () => {
    const current = conflict();
    if (!current) return;
    setSeenAt({ ...seenAt(), [current.key]: current.version });
    setConflict(null);
    void form.save();
  };

  const Field = (fieldProps: { key: string }) => {
    const item = createMemo(() => entry(fieldProps.key));
    const isReset = () => resets().includes(fieldProps.key);
    const locked = () => form.saving() || isReset() || (unreadable(fieldProps.key) && !confirmed(fieldProps.key));
    return (
      <div class="flex flex-col gap-1.5" id={settingControlId(fieldProps.key)}>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-sm font-semibold text-primary">{item().label}</span>
          <span class="flex items-center gap-2 text-xs text-dimmed">
            {sourceText(item(), t())}
            <Show when={item().isCustom || isReset()}>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={form.saving()}
                onClick={() => setResets(isReset() ? resets().filter((key) => key !== fieldProps.key) : [...resets(), fieldProps.key])}
              >
                {isReset() ? t().undoDefault : t().useDefault}
              </Button>
            </Show>
          </span>
        </div>
        <p id={`${settingControlId(fieldProps.key)}-description`} class="text-xs text-dimmed">
          {item().description}
          <Show when={item().kind === "secret"}> {item().isCustom || item().valueSource === "env" ? t().secretSet : t().secretEmpty}</Show>
        </p>
        <Show when={unreadable(fieldProps.key)}>
          <InlineGuidance tone="warning" icon="ti ti-eye-off">
            <b>{t().unreadableTitle}</b> {t().unreadableKeep({ value: preview(item(), item().value, t()) })}
            <Checkbox
              label={t().replaceStored({ label: item().label })}
              value={replace().includes(fieldProps.key)}
              onValueChange={(checked) =>
                setReplace(checked ? [...replace(), fieldProps.key] : replace().filter((key) => key !== fieldProps.key))
              }
              disabled={form.saving()}
            />
          </InlineGuidance>
        </Show>
        <Show
          when={!isReset()}
          fallback={<p class="text-sm text-secondary">{t().defaultApplies({ value: preview(item(), item().resetValue, t()) })}</p>}
        >
          <fieldset disabled={locked()} class="contents">
            <FieldInput
              entry={item()}
              value={() => form.draft()[fieldProps.key]}
              error={() => form.errors()[fieldProps.key] ?? fieldErrors()[fieldProps.key]}
              onChange={(value) => {
                if (fieldErrors()[fieldProps.key]) {
                  const { [fieldProps.key]: _cleared, ...rest } = fieldErrors();
                  setFieldErrors(rest);
                }
                form.update({ [fieldProps.key]: value });
              }}
            />
          </fieldset>
        </Show>
        <Show when={conflict()?.key === fieldProps.key ? conflict() : null}>
          {(current) => (
            <InlineGuidance tone="warning" icon="ti ti-git-branch">
              <b>{t().conflict({ who: current().who ?? t().someoneElse, time: timeOf(current().at) })}</b>{" "}
              {t().conflictKeep({ value: preview(item(), current().current, t()) })}
              <span class="mt-1 flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="xs" onClick={() => void takeTheirs()}>
                  {t().takeTheirs}
                </Button>
                <Button type="button" size="xs" onClick={keepMine}>
                  {t().keepMine}
                </Button>
              </span>
            </InlineGuidance>
          )}
        </Show>
      </div>
    );
  };

  return (
    <div class="flex max-w-2xl flex-col gap-6">
      <SettingsSaveOutcome outcome={conflict() ? null : form.outcome()} onRetry={() => void form.save()} />
      <For each={props.sections}>
        {(section) => (
          <SettingsSection
            title={section.title}
            subtitle={section.description}
            actions={
              section.link ? (
                <ButtonLink href={section.link.href} target="_blank" rel="noreferrer" variant="secondary" size="sm">
                  <i class="ti ti-external-link" aria-hidden="true" /> {section.link.label}
                </ButtonLink>
              ) : undefined
            }
          >
            <div class="flex flex-col gap-5">
              <For each={section.keys.filter((key) => entries().some((item) => item.key === key))}>
                {(key) => {
                  const condition = section.shownWhen?.[key];
                  return (
                    <Show when={!condition || form.draft()[condition.key] === condition.value}>
                      <Field key={key} />
                    </Show>
                  );
                }}
              </For>
            </div>
          </SettingsSection>
        )}
      </For>
    </div>
  );
}
