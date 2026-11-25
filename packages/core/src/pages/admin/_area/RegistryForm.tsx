import { coreClient } from "@k2b/cloud/clients/core";
import { createSettingsDraft, SaveRejected, saveFailure, settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { readSettingsError, useLocale } from "@k2b/ui";
import { Bar, Button, Field, Menu, Notice, Section, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { localizeSettingField } from "../settings/_components/setting-copy";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { type AreaFormMessages, areaFormMessages } from "./messages";
import SettingControl from "./SettingControl";

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
// Secrets come redacted; an empty draft keeps the stored secret.
const initialValues = (entries: SettingFieldDef[]): Values =>
  Object.fromEntries(entries.map((entry) => [entry.key, entry.kind === "secret" ? "" : entry.value]));

/**
 * The registry settings of one admin section on v2, grouped and ordered by hand, inside the screen's pane. It saves
 * with "Speichern" in its own footer through Core's settings API: a stale version reports who changed what as a notice
 * with both ways out, an unreadable stored value is replaced only after the person confirms it, and a value of its own
 * goes back to the default through "Zurücksetzen" in the footer, applied on save.
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
  const shownKeys = (section: RegistryFormSection) => section.keys.filter((key) => entries().some((item) => item.key === key));
  const formKeys = createMemo(() => props.sections.flatMap(shownKeys));

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
  const status = () => settingsSaveControls()?.state ?? "saved";

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
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  /** The quiet word on the label line: where the value comes from now. */
  const source = (item: SettingFieldDef) =>
    resets().includes(item.key)
      ? t().sourceDefault
      : item.isCustom
        ? t().sourceCustom
        : item.valueSource === "env"
          ? t().sourceEnv
          : t().sourceDefault;
  const hint = (item: SettingFieldDef) =>
    resets().includes(item.key)
      ? t().resetStaged
      : item.kind === "secret"
        ? `${item.description} ${item.isCustom || item.valueSource === "env" ? t().secretSet : t().secretEmpty}`
        : item.description;
  const shown = (section: RegistryFormSection, key: string) => {
    const condition = section.shownWhen?.[key];
    return !condition || form.draft()[condition.key] === condition.value;
  };
  // Every value of its own can go back to the default; the tick marks the ones that will on save.
  const resettable = createMemo(() =>
    formKeys()
      .map(entry)
      .filter((item) => item.isCustom || resets().includes(item.key)),
  );

  const SettingField = (fieldProps: { key: string }) => {
    const item = createMemo(() => entry(fieldProps.key));
    const isReset = () => resets().includes(fieldProps.key);
    const locked = () => form.saving() || isReset() || (unreadable(fieldProps.key) && !confirmed(fieldProps.key));
    return (
      <Field
        name={fieldProps.key}
        label={item().label}
        hint={hint(item())}
        optional={source(item())}
        error={form.errors()[fieldProps.key] ?? fieldErrors()[fieldProps.key]}
      >
        <SettingControl
          entry={item()}
          // A staged reset shows the default in the locked field, so the row keeps its footprint.
          value={isReset() ? (item().kind === "secret" ? "" : item().resetValue) : form.draft()[fieldProps.key]}
          locked={locked()}
          secretPlaceholder={t().leaveSecretEmpty}
          error={form.errors()[fieldProps.key] ?? fieldErrors()[fieldProps.key]}
          onChange={(value) => {
            if (isReset()) return;
            if (fieldErrors()[fieldProps.key]) {
              const { [fieldProps.key]: _cleared, ...rest } = fieldErrors();
              setFieldErrors(rest);
            }
            form.update({ [fieldProps.key]: value });
          }}
        />
      </Field>
    );
  };

  return (
    <>
      <Show when={conflict() ?? undefined}>
        {(current) => (
          <Notice
            tone="warn"
            title={t().conflict({ who: current().who ?? t().someoneElse, time: timeOf(current().at) })}
            actions={[
              { label: t().takeTheirs, onClick: () => void takeTheirs() },
              { label: t().keepMine, onClick: keepMine },
            ]}
          >
            {t().conflictAt({ label: entry(current().key).label, value: preview(entry(current().key), current().current, t()) })}
          </Notice>
        )}
      </Show>
      <Show when={!conflict() ? form.outcome() : undefined}>
        {(outcome) =>
          outcome().kind === "failed" ? (
            <Notice tone="bad" title={t().notSaved} actions={[{ label: t().retry, onClick: () => void form.save() }]}>
              {outcome().message} {t().notSavedKeep}
            </Notice>
          ) : (
            <Notice tone="warn" title={t().unknownOutcome} actions={[{ label: t().checkNow, onClick: () => window.location.reload() }]}>
              {t().unknownOutcomeKeep}
            </Notice>
          )
        }
      </Show>
      <For each={formKeys().filter(unreadable)}>
        {(key) => (
          <Notice
            tone="warn"
            icon="eye-off"
            title={`${entry(key).label}: ${t().unreadableTitle}`}
            actions={[
              {
                label: replace().includes(key) ? t().keepStored : t().replaceOnSave,
                onClick: () => setReplace(toggle(replace(), key)),
                disabled: form.saving(),
              },
            ]}
          >
            {t().unreadableKeep({ value: preview(entry(key), entry(key).value, t()) })}
          </Notice>
        )}
      </For>
      <For each={props.sections}>
        {(section) => (
          <Section
            title={section.title}
            summary={section.description}
            actions={section.link ? [{ label: section.link.label, icon: "external-link", href: section.link.href }] : undefined}
          >
            <For each={shownKeys(section)}>{(key) => <Show when={shown(section, key)}>{<SettingField key={key} />}</Show>}</For>
          </Section>
        )}
      </For>
      <Bar
        start={
          <Text type="meta" muted>
            {status() === "saved" && settingsSaveControls()?.savedAt
              ? t().savedAt({ time: settingsSaveControls()!.savedAt! })
              : status() === "draft"
                ? t().unsaved
                : status() === "invalid"
                  ? t().invalid({ count: settingsSaveControls()?.invalidCount ?? 0 })
                  : ""}
          </Text>
        }
        end={
          <>
            <Show when={resettable().length > 0}>
              <Menu
                disabled={form.saving()}
                items={resettable().map((item) => ({
                  label: item.label,
                  checked: resets().includes(item.key),
                  onClick: () => setResets(toggle(resets(), item.key)),
                }))}
              >
                {t().resetMenu}
              </Menu>
            </Show>
            <Button disabled={form.saving() || status() === "saved"} onClick={form.discard}>
              {t().discard}
            </Button>
            <Button
              variant="primary"
              busy={form.saving()}
              disabled={status() === "saved" || status() === "invalid" || status() === "unknown"}
              onClick={() => void form.save()}
            >
              {t().save}
            </Button>
          </>
        }
      />
    </>
  );
}
