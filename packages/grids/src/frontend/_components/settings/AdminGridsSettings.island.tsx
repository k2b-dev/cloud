import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
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

const SettingRow = (props: { entry: SettingEntry; onChange: (value: unknown) => void }) => {
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
        <TextInput id={`setting-${props.entry.key}`} label={label()} description={description()} value={value} onValueChange={updateText} />
      }
    >
      <NumberInput
        id={`setting-${props.entry.key}`}
        label={label()}
        description={description()}
        min={1}
        step={1}
        value={() => (value().trim() === "" ? null : Number(value()))}
        onValueChange={updateNumber}
        suffix={suffix ? <span class="font-mono text-xs text-dimmed">{suffix}</span> : undefined}
      />
    </Show>
  );
};

const SettingsBody = (props: { close: () => void }) => {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  const [entries] = createResource(() => fetchSettings(t().loadSettingsFailed));
  const pending = new Map<string, unknown>();

  const saveMutation = mutations.create<boolean, void>({
    mutation: async () => {
      if (pending.size === 0) return false;
      for (const [key, value] of pending) await updateSetting(key, value, t().updateSettingFailed);
      return true;
    },
    onSuccess: (changed) => {
      props.close();
      if (changed) toast.success(t().settingsSaved);
    },
    onError: (e) => prompts.error(e.message),
  });

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().gridsSettings} subtitle={t().settingsSubtitle} icon="ti ti-settings" close={props.close} />
      <PanelDialog.Body>
        <PanelDialog.Section title={t().settings} subtitle={t().registeredSettings} icon="ti ti-adjustments">
          <Show when={!entries.loading} fallback={<Placeholder state="loading" align="left" title={t().loadingSettings} />}>
            <Show
              when={(entries() ?? []).length > 0}
              fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noSettings}</>} />}
            >
              <div class="flex flex-col gap-3">
                <For each={entries() ?? []}>
                  {(entry) => <SettingRow entry={entry} onChange={(value) => pending.set(entry.key, value)} />}
                </For>
              </div>
            </Show>
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div />
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={props.close} disabled={saveMutation.loading()}>
            {t().cancel}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => saveMutation.mutate(undefined)}
            disabled={saveMutation.loading()}
          >
            <i class={`ti ${saveMutation.loading() ? "ti-loader-2 animate-spin" : "ti-check"} text-sm`} />
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
};

const openSettingsDialog = () => dialogCore.open<void>((close) => <SettingsBody close={() => close()} />, panelDialogOptions);

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
