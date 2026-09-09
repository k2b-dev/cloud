import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  InlineGuidance,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { gridsAdminMessages } from "../../admin-messages";

type SettingEntry = {
  key: string;
  label: string;
  kind: string;
  description: string;
  default: unknown;
  value: unknown;
  isCustom: boolean;
};

const fetchSettings = async (fallback: string): Promise<SettingEntry[]> => {
  const res = await apiClient.admin.settings.$get();
  if (!res.ok) throw new Error(fallback);
  return res.json();
};

const updateSetting = async (key: string, value: unknown, fallback: string): Promise<void> => {
  const res = await apiClient.admin.settings[":key{.+}"].$put({
    param: { key },
    json: { value },
  });
  if (!res.ok) throw new Error(fallback);
};

const unitSuffixForKey = (key: string): string | null => {
  if (key.endsWith("_mb")) return "MB";
  return null;
};

const SettingRow = (props: { entry: SettingEntry; disabled: boolean; onChange: (value: unknown) => void }) => {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  const label = () => (props.entry.key === "grids.max_file_size_mb" ? t().maxFileSize : props.entry.label);
  const description = () => (props.entry.key === "grids.max_file_size_mb" ? t().maxFileSizeDescription : props.entry.description);
  const initial = props.entry.value ?? props.entry.default ?? "";
  const [value, setValue] = createSignal(typeof initial === "string" ? initial : String(initial));
  const isNumber = props.entry.kind === "number";
  const suffix = unitSuffixForKey(props.entry.key);

  const updateText = (next: string) => {
    setValue(next);
    props.onChange(next);
  };
  const updateNumber = (next: number | null) => {
    const raw = next === null ? "" : String(next);
    setValue(raw);
    props.onChange(next);
  };

  return (
    <Show
      when={isNumber}
      fallback={
        <TextInput
          id={`setting-${props.entry.key}`}
          label={label()}
          description={description()}
          value={value}
          onValueChange={updateText}
          disabled={props.disabled}
        />
      }
    >
      <NumberInput
        id={`setting-${props.entry.key}`}
        label={label()}
        description={description()}
        min={1}
        disabled={props.disabled}
        step={1}
        value={() => (value().trim() === "" ? null : Number(value()))}
        onValueChange={updateNumber}
        suffix={suffix ? <span class="font-mono text-xs text-dimmed">{suffix}</span> : undefined}
      />
    </Show>
  );
};

export const SettingsBody = (props: { close: () => void; setDismissHandler: (handler: () => void | Promise<void>) => void }) => {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  const baseline = new Map<string, unknown>();
  const entries = query.create({
    source: () => true,
    load: async () => {
      const values = await fetchSettings(t().loadSettingsFailed);
      for (const entry of values) baseline.set(entry.key, entry.value ?? entry.default ?? "");
      return values;
    },
  });
  const pending = new Map<string, unknown>();
  const [dirty, setDirty] = createSignal(false);

  const saveMutation = mutations.create<boolean, void>({
    mutation: async () => {
      if (pending.size === 0) return false;
      for (const [key, value] of pending) {
        await updateSetting(key, value, t().updateSettingFailed);
        baseline.set(key, value);
        pending.delete(key);
        setDirty(pending.size > 0);
      }
      return true;
    },
    onSuccess: (changed) => {
      props.close();
      if (changed) toast.success(t().settingsSaved);
    },
  });
  const dismiss = async () => {
    if (!saveMutation.loading() && (await confirmDiscardIfDirty(dirty))) props.close();
  };
  props.setDismissHandler(dismiss);

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().gridsSettings}
        subtitle={t().settingsSubtitle}
        icon="ti ti-settings"
        close={dismiss}
        closeDisabled={saveMutation.loading()}
      />
      <PanelDialog.Body>
        <Show when={saveMutation.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
        <PanelDialog.Section title={t().settings} subtitle={t().registeredSettings} icon="ti ti-adjustments">
          <Show when={!entries.loading()} fallback={<Placeholder state="loading" align="left" title={t().loadingSettings} />}>
            <Show
              when={!entries.error()}
              fallback={
                <Placeholder
                  state="error"
                  title={t().loadSettingsFailed}
                  action={
                    <Button onClick={() => void entries.refresh()} variant="secondary">
                      {t().retrySettings}
                    </Button>
                  }
                />
              }
            >
              <Show
                when={(entries.data() ?? []).length > 0}
                fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noSettings}</>} />}
              >
                <div class="flex flex-col gap-3">
                  <For each={entries.data() ?? []}>
                    {(entry) => (
                      <SettingRow
                        entry={entry}
                        disabled={saveMutation.loading()}
                        onChange={(value) => {
                          if (Object.is(value, baseline.get(entry.key))) pending.delete(entry.key);
                          else pending.set(entry.key, value);
                          setDirty(pending.size > 0);
                        }}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div />
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={dismiss} disabled={saveMutation.loading()}>
            {t().cancel}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => saveMutation.mutate(undefined)}
            disabled={saveMutation.loading() || entries.loading() || !!entries.error() || !dirty()}
          >
            <i class={`ti ${saveMutation.loading() ? "ti-loader-2 animate-spin" : "ti-check"} text-sm`} />
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
};

const openSettingsDialog = () =>
  dialogCore.open<void>(
    (close, context) => <SettingsBody close={() => close()} setDismissHandler={context.setDismissHandler} />,
    panelDialogOptions,
  );

export default function AdminGridsSettings() {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  return (
    <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={() => void openSettingsDialog()}>
      <i class="ti ti-settings text-sm" />
      {t().settings}
    </Button>
  );
}
