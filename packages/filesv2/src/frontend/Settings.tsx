import { mutation } from "@k2b/stdlib/solid";
import { Disclosure, InlineGuidance, NoticeCard, SettingsPage, SettingsPanelFooter, SettingsSection, Switch, TextInput } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { apiClient } from "../api/client";
import {
  type Area,
  type Availability,
  type Configuration,
  type ConfigurationInput,
  ErrorSchema,
  type PublicConfiguration,
} from "../contracts";
import { useAdminMessages } from "./admin-messages";
import { useFilesMessages } from "./messages";

export default function Settings(props: {
  configuration: PublicConfiguration;
  availability: Availability;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean, saving: boolean) => void;
}) {
  const t = useFilesMessages();
  const a = useAdminMessages();
  const clean = (value: PublicConfiguration): Configuration => ({
    url: value.url,
    cloud: { ...value.cloud },
    freeipa: { ...value.freeipa },
  });
  const [baseline, setBaseline] = createSignal(clean(props.configuration));
  const [configuration, setConfiguration] = createStore(clean(props.configuration));
  const [token, setToken] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const dirty = createMemo(() => JSON.stringify(configuration) !== JSON.stringify(baseline()) || token().length > 0);
  let form!: HTMLFormElement;
  const save = mutation.create({
    mutation: async (json: ConfigurationInput, { abortSignal }) => {
      const response = await apiClient.admin.configuration.$put({ json }, { init: { signal: abortSignal } });
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : t().saveFailed);
      }
      setBaseline({ url: json.url, cloud: { ...json.cloud }, freeipa: { ...json.freeipa } });
      setToken("");
      setSaved(true);
      // Saving and reloading are separate outcomes; the workspace owns read failures.
      await props.onSaved();
    },
  });
  createEffect(() => props.onDirtyChange(dirty(), save.loading()));
  onCleanup(() => {
    save.abort();
    props.onDirtyChange(false, false);
  });
  onMount(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    onCleanup(() => window.removeEventListener("beforeunload", leave));
  });
  const discard = () => {
    setConfiguration(reconcile(baseline()));
    setToken("");
    setSaved(false);
  };
  const areas: Area[] = ["cloud", "freeipa"];
  const available = (area: Area) => (area === "cloud" ? props.availability.localLinuxEnabled : props.availability.freeipaEnabled);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (save.loading() || !dirty()) return;
    setSaved(false);
    void save.mutate({
      url: configuration.url,
      cloud: { ...configuration.cloud },
      freeipa: { ...configuration.freeipa },
      ...(token() ? { token: token() } : {}),
    });
  };
  return (
    <SettingsPage
      title={a().settings}
      subtitle={a().settingsDescription}
      icon="ti ti-settings"
      footer={
        <SettingsPanelFooter
          changeCount={() => (dirty() ? 1 : 0)}
          loading={save.loading}
          saveLabel={t().save}
          onDiscard={discard}
          onSave={() => form.requestSubmit()}
        />
      }
    >
      <form ref={form} onSubmit={submit} class="flex flex-col gap-4" aria-label={t().settings}>
        <SettingsSection title={t().connection} icon="ti ti-plug-connected">
          <fieldset class="grid min-w-0 gap-4 md:grid-cols-2" disabled={save.loading()}>
            <TextInput
              name="filegate-url"
              type="url"
              label={t().url}
              description={t().urlDescription}
              value={configuration.url}
              onValueChange={(value) => setConfiguration("url", value)}
              placeholder="http://filegate:4000"
            />
            <TextInput
              name="filegate-token"
              password
              autocomplete="new-password"
              label={t().token}
              description={props.configuration.tokenConfigured ? t().tokenPresent : t().tokenMissing}
              value={token()}
              onValueChange={setToken}
            />
          </fieldset>
        </SettingsSection>
        <For each={areas}>
          {(area) => (
            <SettingsSection title={t()[area]} icon={area === "cloud" ? "ti ti-cloud" : "ti ti-server"}>
              <fieldset class="flex min-w-0 flex-col gap-4" disabled={save.loading()}>
                <NoticeCard
                  tone="info"
                  title={area === "cloud" ? a().cloudPurpose : a().freeipaPurpose}
                  detail={area === "cloud" ? a().cloudExplanation : a().freeipaExplanation}
                />
                <Switch
                  label={t().enabled}
                  value={configuration[area].enabled}
                  onValueChange={(value) => setConfiguration(area, "enabled", value)}
                  disabled={!available(area) && !configuration[area].enabled}
                />
                <Show when={!available(area)}>
                  <InlineGuidance tone="info">{area === "cloud" ? t().linuxDisabled : t().freeipaDisabled}</InlineGuidance>
                </Show>
                <TextInput
                  name={`${area}-root`}
                  label={t().root}
                  description={a().rootHint}
                  value={configuration[area].root}
                  onValueChange={(value) => setConfiguration(area, "root", value)}
                  required
                />
                <Show
                  when={area === "cloud"}
                  fallback={
                    <InlineGuidance tone="info" icon="ti ti-info-circle">
                      {a().freeipaManual}
                    </InlineGuidance>
                  }
                >
                  <Switch
                    label={a().autoCreate}
                    description={a().autoCreateHint}
                    value={configuration.cloud.autoCreate}
                    onValueChange={(value) => setConfiguration("cloud", "autoCreate", value)}
                    disabled={!configuration.cloud.enabled}
                  />
                  <Switch
                    label={a().autoArchive}
                    description={a().autoArchiveHint}
                    value={configuration.cloud.autoArchive}
                    onValueChange={(value) => setConfiguration("cloud", "autoArchive", value)}
                    disabled={!configuration.cloud.enabled}
                  />
                </Show>
                <Disclosure summary={a().advanced} surface="plain" icon="ti ti-folders">
                  <div class="grid min-w-0 gap-4 pt-4 md:grid-cols-2">
                    <TextInput
                      name={`${area}-prefix`}
                      label={t().prefix}
                      description={t().prefixDescription}
                      value={configuration[area].prefix}
                      onValueChange={(value) => setConfiguration(area, "prefix", value)}
                    />
                    <TextInput
                      name={`${area}-homes`}
                      label={t().homes}
                      description={t().relativeDescription}
                      value={configuration[area].homes}
                      onValueChange={(value) => setConfiguration(area, "homes", value)}
                      required
                    />
                    <TextInput
                      name={`${area}-groups`}
                      label={t().groups}
                      description={t().relativeDescription}
                      value={configuration[area].groups}
                      onValueChange={(value) => setConfiguration(area, "groups", value)}
                      required
                    />
                    <TextInput
                      name={`${area}-archive`}
                      label={t().archive}
                      description={t().relativeDescription}
                      value={configuration[area].archive}
                      onValueChange={(value) => setConfiguration(area, "archive", value)}
                      required
                    />
                  </div>
                </Disclosure>
              </fieldset>
            </SettingsSection>
          )}
        </For>
        <Show when={save.error()}>
          {(error) => (
            <InlineGuidance tone="danger" role="alert">
              {error().message}
            </InlineGuidance>
          )}
        </Show>
        <Show when={saved()}>
          <InlineGuidance tone="success" role="status">
            {a().saved}
          </InlineGuidance>
        </Show>
      </form>
    </SettingsPage>
  );
}
