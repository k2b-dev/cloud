/**
 * Admin button for notebook-app-level settings on `/admin/notebooks`.
 *
 * Click → opens a modal that lists every setting in the `notebooks`
 * group (read from `GET /api/notebooks/admin/settings`). Each setting
 * is rendered as a labelled input picking the right widget for its
 * kind. Save submits the changed values via `PUT /admin/settings/:key`.
 *
 * Extensible by design: future settings just need a `defaults.ts`
 * entry — they auto-appear in this modal without any frontend change.
 */

import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, dialogCore, NumberInput, PanelDialog, Placeholder, panelDialogOptions, TextInput, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { notebooksAdminMessages } from "../admin-messages";

type SettingEntry = {
  key: string;
  label: string;
  kind: string;
  description: string;
  default: unknown;
  value: unknown;
  isCustom: boolean;
};

const fetchSettings = async (signal: AbortSignal, locale: string): Promise<SettingEntry[]> => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const res = await apiClient.admin.settings.$get(undefined, { init: { signal } });
  if (!res.ok) throw new Error(t.loadSettingsFailed({ status: res.status }));
  return await res.json();
};

const updateSetting = async (key: string, value: unknown, signal: AbortSignal, locale: string): Promise<void> => {
  const t = notebooksAdminMessages.resolve([locale]).t;
  const res = await apiClient.admin.settings[":key"].$put(
    {
      param: { key },
      json: { value },
    },
    { init: { signal } },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? t.updateSettingFailed({ key }));
  }
};

/** Visual unit suffix derived from the setting key. Convention beats
 *  schema for two entries — keeps the SettingEntry type generic and
 *  the modal renderer free to grow more suffixes as new settings
 *  appear. Returns `null` when no suffix applies. */
const unitSuffixForKey = (key: string): string | null => {
  if (key.endsWith("_mb")) return "MB";
  if (key.endsWith("_px")) return "px";
  return null;
};

/**
 * Renders one setting row. The input type is picked per `entry.kind`:
 *
 *  - `number` (incl. `_mb` / `_px` suffix keys) → `<input type="number">`
 *    with optional unit pill on the right edge.
 *  - everything else → text input, value round-trips as a string and
 *    the API validates per the registered SettingDef.
 *
 * Unknown kinds also fall back to text, so adding a new `kind` in
 * `defaults.ts` doesn't crash the modal — the value still flows
 * through the backend validator.
 */
const SettingRow = (props: { entry: SettingEntry; onChange: (value: unknown) => void }) => {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const entryValue = () => props.entry.value ?? props.entry.default ?? "";
  const [value, setValue] = createSignal("");
  createEffect(() => {
    const next = entryValue();
    setValue(typeof next === "string" ? next : String(next));
  });

  const isNumber = props.entry.kind === "number";
  const suffix = unitSuffixForKey(props.entry.key);

  const handleValue = (raw: string) => {
    setValue(raw);
    // For number kinds we parse before handing the value off so the
    // PUT body matches the backend validator's expectation. Empty
    // string → null (resets to default per existing service contract).
    if (isNumber) {
      const parsed = raw.trim() === "" ? null : Number(raw);
      props.onChange(parsed);
    } else {
      props.onChange(raw);
    }
  };

  return (
    <Show
      when={isNumber}
      fallback={
        <TextInput
          id={`setting-${props.entry.key}`}
          label={t().settingLabel({ key: props.entry.key, label: props.entry.label })}
          description={t().settingDescription({ key: props.entry.key, description: props.entry.description })}
          value={value}
          onValueChange={handleValue}
          placeholder={typeof props.entry.default === "string" ? props.entry.default : String(props.entry.default ?? "")}
        />
      }
    >
      <NumberInput
        id={`setting-${props.entry.key}`}
        label={t().settingLabel({ key: props.entry.key, label: props.entry.label })}
        description={t().settingDescription({ key: props.entry.key, description: props.entry.description })}
        value={() => (value().trim() === "" ? null : Number(value()))}
        onValueChange={(next) => handleValue(next === null ? "" : String(next))}
        suffix={suffix ? <span class="font-mono text-[11px]">{suffix}</span> : undefined}
      />
    </Show>
  );
};

const SettingsBody = (props: { close: () => void }) => {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => "notebooks-settings",
    load: (_source, { abortSignal }) => fetchSettings(abortSignal, locale()),
  });
  const [pending, setPending] = createSignal<ReadonlyMap<string, unknown>>(new Map());
  const [saveOutcome, setSaveOutcome] = createSignal<{ applied: number; failed?: string; warning?: string } | null>(null);
  const [reconciling, setReconciling] = createSignal(false);
  const removePending = (keys: Iterable<string>) => {
    setPending((current) => {
      const next = new Map(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };
  const save = mutation.create<
    { attempted: ReadonlyArray<readonly [string, unknown]>; appliedKeys: string[]; failed?: string },
    ReadonlyArray<readonly [string, unknown]>
  >({
    mutation: async (changes, { abortSignal }) => {
      const appliedKeys: string[] = [];
      for (const [key, value] of changes) {
        try {
          await updateSetting(key, value, abortSignal, locale());
          appliedKeys.push(key);
        } catch (error) {
          if (abortSignal.aborted) throw error;
          return { attempted: changes, appliedKeys, failed: error instanceof Error ? error.message : t().updateSettingFailed({ key }) };
        }
      }
      return { attempted: changes, appliedKeys };
    },
    onSuccess: (outcome) => {
      if (outcome.failed) {
        setReconciling(true);
        void entries
          .invalidate()
          .then(() => {
            const appliedKeys = new Set(outcome.appliedKeys);
            const canonical = new Map((entries.data() ?? []).map((entry) => [entry.key, entry.value]));
            for (const [key, value] of outcome.attempted) {
              if (Object.is(canonical.get(key), value)) appliedKeys.add(key);
            }
            removePending(appliedKeys);
            setSaveOutcome({ applied: appliedKeys.size, failed: outcome.failed });
          })
          .catch(() => {
            removePending(outcome.appliedKeys);
            setSaveOutcome({
              applied: outcome.appliedKeys.length,
              failed: outcome.failed,
              warning: t().settingsReloadWarning,
            });
          })
          .finally(() => setReconciling(false));
        return;
      }
      removePending(outcome.appliedKeys);
      toast.success(t().settingsSaved);
      props.close();
      refreshCurrentPath();
    },
  });
  onCleanup(() => save.abort());

  const onChange = (key: string, value: unknown) => {
    setPending((current) => new Map(current).set(key, value));
    setSaveOutcome(null);
  };
  const close = () => {
    if (!save.loading() && !reconciling()) props.close();
  };

  const onSave = () => {
    const changes = [...pending().entries()];
    if (changes.length === 0) {
      props.close();
      return;
    }
    if (!save.loading() && !reconciling()) void save.mutate(changes);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().notebookSettings}
        subtitle={t().settingsSubtitle}
        icon="ti ti-settings"
        close={close}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={t().settings} subtitle={t().settingsSectionSubtitle} icon="ti ti-adjustments">
          <Show when={!entries.loading()} fallback={<Placeholder state="loading" align="left" title={t().loadingSettings} />}>
            <Show
              when={!entries.error()}
              fallback={
                <Placeholder
                  state="error"
                  align="left"
                  title={t().settingsLoadFailed}
                  description={entries.error()?.message}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void entries.refresh()}>
                      {t().retry}
                    </Button>
                  }
                />
              }
            >
              <Show
                when={(entries.data() ?? []).length > 0}
                fallback={<Placeholder align="left" class="px-0 py-2" description={t().noSettings} />}
              >
                <div class="flex flex-col gap-3">
                  <For each={entries.data() ?? []}>
                    {(entry) => (
                      <SettingRow
                        entry={pending().has(entry.key) ? { ...entry, value: pending().get(entry.key) } : entry}
                        onChange={(value) => onChange(entry.key, value)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={saveOutcome()}>
            {(outcome) => (
              <p class={outcome().failed ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-amber-700 dark:text-amber-300"}>
                {outcome().applied > 0 ? `${t().savedCount({ count: outcome().applied })} ` : ""}
                {outcome().failed} {outcome().warning}
              </p>
            )}
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <ButtonLink href="/admin/observability/jobs?search=notebooks%3Areindex" variant="secondary" size="sm">
          <i class="ti ti-calendar-time text-sm" />
          {t().reindexJob}
        </ButtonLink>
        <div class="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={close} disabled={save.loading() || reconciling()}>
            {t().cancel}
          </Button>
          <Button type="button" size="sm" onClick={onSave} loading={save.loading() || reconciling()} loadingLabel={t().saving}>
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-check"} text-sm`} />
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
};

const openSettingsDialog = () => dialogCore.open<void>((close) => <SettingsBody close={() => close()} />, panelDialogOptions);

export default function AdminNotebooksAppSettings() {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  return (
    <Button type="button" variant="secondary" size="sm" class="shrink-0" onClick={() => void openSettingsDialog()}>
      <i class="ti ti-settings text-sm" />
      {t().settings}
    </Button>
  );
}
