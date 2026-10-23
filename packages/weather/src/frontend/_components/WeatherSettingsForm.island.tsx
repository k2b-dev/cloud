import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  InlineGuidance,
  NumberInput,
  prompts,
  readSettingsError,
  SettingsField,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  sameSettingValue,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { weatherMessages } from "../../messages";

type Initial = {
  "weather.default_lat": string;
  "weather.default_lon": string;
  "weather.cache_minutes": number;
};

/** `unreadable[key]` marks a saved value this application cannot read; `initial` then holds the value in use. */
export default function WeatherSettingsForm(props: { initial: Initial; unreadable: Record<string, boolean> }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal<Initial>({ ...props.initial });
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});

  const update = <K extends keyof Initial>(key: K, value: Initial[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const changedKeys = createMemo<Array<keyof Initial>>(() => {
    const d = draft();
    return (Object.keys(props.initial) as Array<keyof Initial>).filter((k) => !sameSettingValue(d[k], props.initial[k]));
  });
  const hasChanges = () => changedKeys().length > 0;

  if (typeof window !== "undefined") {
    window.onbeforeunload = () => (hasChanges() ? "" : null);
  }

  const save = mutations.create<void, Record<string, unknown>>({
    mutation: async (updates, { abortSignal }) => {
      const response = await apiClient.admin.settings.$put({ json: updates }, { init: { signal: abortSignal } });
      if (!response.ok) {
        const { message, fields } = await readSettingsError(response, t().saveFailedHttp({ status: response.status }));
        setFieldErrors(fields);
        throw new Error(message);
      }
    },
    onSuccess: () => {
      window.onbeforeunload = null;
      toast.success(t().settingsSaved);
      refreshCurrentPath();
    },
    onError: (e) => prompts.error(e.message),
  });
  onCleanup(() => {
    save.abort();
    if (typeof window !== "undefined") window.onbeforeunload = null;
  });
  const saveSettings = () => {
    const updates: Record<string, unknown> = {};
    const values = draft();
    for (const key of changedKeys()) updates[key] = values[key];
    // A changed field that shows the unreadable warning replaces the saved value explicitly.
    const replaceUnreadable = changedKeys().filter((key) => props.unreadable[key] === true);
    return save.mutate(replaceUnreadable.length > 0 ? { updates, replaceUnreadable } : updates);
  };

  const discardAll = () => {
    setDraft({ ...props.initial });
    setFieldErrors({});
  };

  const isChanged = (key: keyof Initial) => !sameSettingValue(draft()[key], props.initial[key]);
  const unreadableHint = (key: keyof Initial) => (
    <Show when={props.unreadable[key]}>
      <InlineGuidance tone="warning" icon="ti ti-alert-triangle">
        {t().settingUnreadable}
      </InlineGuidance>
    </Show>
  );

  return (
    <SettingsPage
      style="view-transition-name: admin-weather-settings"
      title={t().appName}
      subtitle={t().settingsSubtitle}
      icon="ti ti-cloud-sun"
      scrollPreserveKey="weather-admin"
      footer={
        <SettingsPanelFooter
          changeCount={() => changedKeys().length}
          loading={() => save.loading()}
          onDiscard={discardAll}
          onSave={saveSettings}
        />
      }
    >
      <SettingsSection title={t().forecastSource} subtitle={t().forecastSourceDescription} icon="ti ti-info-circle">
        <div class="flex flex-col gap-2 text-xs text-dimmed">
          <p>{t().forecastSourceBody}</p>
          <p>
            {t().geocodingBody}{" "}
            <a href="/admin/places-and-maps" target="_blank" class="underline" rel="noreferrer">
              {t().locationSearch}
            </a>
            .
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title={t().defaultLocation} subtitle={t().defaultLocationDescription} icon="ti ti-map-pin">
        <SettingsField
          label={t().defaultLatitude}
          description={t().defaultLatitudeDescription}
          error={() => fieldErrors()["weather.default_lat"]}
          changed={() => isChanged("weather.default_lat")}
        >
          <TextInput
            value={() => draft()["weather.default_lat"]}
            onValueChange={(v) => update("weather.default_lat", v)}
            placeholder={t().exampleLatitude}
          />
          {unreadableHint("weather.default_lat")}
        </SettingsField>
        <SettingsField
          label={t().defaultLongitude}
          description={t().defaultLongitudeDescription}
          error={() => fieldErrors()["weather.default_lon"]}
          changed={() => isChanged("weather.default_lon")}
        >
          <TextInput
            value={() => draft()["weather.default_lon"]}
            onValueChange={(v) => update("weather.default_lon", v)}
            placeholder={t().exampleLongitude}
          />
          {unreadableHint("weather.default_lon")}
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t().refresh} subtitle={t().refreshDescription} icon="ti ti-clock">
        <SettingsField
          label={t().cacheMinutes}
          description={t().cacheMinutesDescription}
          error={() => fieldErrors()["weather.cache_minutes"]}
          changed={() => isChanged("weather.cache_minutes")}
        >
          <NumberInput
            value={() => draft()["weather.cache_minutes"]}
            onValueChange={(v) => {
              if (v !== null) update("weather.cache_minutes", v);
            }}
            min={1}
            max={1440}
          />
          {unreadableHint("weather.cache_minutes")}
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
