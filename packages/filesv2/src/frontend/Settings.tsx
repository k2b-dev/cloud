import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  Disclosure,
  InlineGuidance,
  NoticeCard,
  NumberInput,
  prompts,
  Select,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  Switch,
  TextInput,
} from "@k2b/ui";
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
import MachineStorage from "./MachineStorage";
import { useMachineMessages } from "./machine-messages";
import { useFilesMessages } from "./messages";

/** The form edits every stored key; a cleared number stays a draft until it is valid again. */
type Draft = Omit<Configuration, "activityRetentionDays"> & { activityRetentionDays: number | null };
const RETENTION = { min: 30, max: 3650 } as const;
const validRetention = (days: number | null): days is number =>
  days !== null && Number.isInteger(days) && days >= RETENTION.min && days <= RETENTION.max;

export default function Settings(props: {
  configuration: PublicConfiguration;
  availability: Availability;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean, saving: boolean) => void;
}) {
  const t = useFilesMessages();
  const m = useMachineMessages();
  const [machinesOpen, setMachinesOpen] = createSignal(false);
  const a = useAdminMessages();
  const clean = (value: Configuration): Draft => ({
    url: value.url,
    cloud: { ...value.cloud },
    freeipa: { ...value.freeipa },
    collabora: { ...value.collabora },
    activityRetentionDays: value.activityRetentionDays,
  });
  const [baseline, setBaseline] = createSignal(clean(props.configuration));
  const [configuration, setConfiguration] = createStore(clean(props.configuration));
  const [token, setToken] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [invalid, setInvalid] = createSignal<string | null>(null);
  const dirty = createMemo(() => JSON.stringify(configuration) !== JSON.stringify(baseline()) || token().length > 0);
  let form!: HTMLFormElement;
  const save = mutation.create({
    mutation: async (json: ConfigurationInput, { abortSignal }) => {
      const response = await apiClient.admin.configuration.$put({ json }, { init: { signal: abortSignal } });
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : t().saveFailed);
      }
      setBaseline(clean(json));
      setToken("");
      setSaved(true);
      // Saving and reloading are separate outcomes; the workspace owns read failures.
      await props.onSaved();
    },
  });
  // Reset is the explicit recovery when the saved configuration cannot be read here.
  const reset = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await apiClient.admin.configuration.$delete({}, { init: { signal: abortSignal } });
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : a().resetConfigurationFailed);
      }
      setSaved(false);
      await props.onSaved();
      // Drafts made before the reset would no longer match what is stored.
      const next = clean(props.configuration);
      setBaseline(next);
      setConfiguration(reconcile(next));
      setToken("");
      setInvalid(null);
    },
  });
  // Save and reset write the same stored value; one at a time keeps their order.
  const busy = () => save.loading() || reset.loading();
  const confirmReset = async () => {
    if (busy()) return;
    if (await prompts.confirm(a().resetConfigurationConfirm, { title: a().resetConfiguration, variant: "danger" })) void reset.mutate();
  };
  createEffect(() => props.onDirtyChange(dirty(), busy()));
  onCleanup(() => {
    save.abort();
    reset.abort();
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
    setInvalid(null);
  };
  const areas: Area[] = ["cloud", "freeipa"];
  const available = (area: Area) => area === "cloud" || props.availability.freeipaEnabled;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || !dirty()) return;
    setSaved(false);
    const days = configuration.activityRetentionDays;
    // Enter submits the typed text before the field could clamp it; the server refuses it too.
    if (!validRetention(days)) {
      setInvalid(a().historyRetentionInvalid);
      return;
    }
    setInvalid(null);
    void save.mutate({
      url: configuration.url,
      cloud: { ...configuration.cloud },
      freeipa: { ...configuration.freeipa },
      collabora: { ...configuration.collabora },
      activityRetentionDays: days,
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
          saveDisabled={reset.loading}
          saveLabel={t().save}
          onDiscard={discard}
          onSave={() => form.requestSubmit()}
        />
      }
    >
      <form ref={form} onSubmit={submit} class="flex flex-col gap-4" aria-label={t().settings}>
        <Show when={props.configuration.unreadable}>
          <NoticeCard tone="warning" title={a().configurationUnreadable} detail={a().configurationUnreadableDetail}>
            <div class="flex flex-col items-start gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={reset.loading()}
                disabled={save.loading()}
                onClick={() => void confirmReset()}
              >
                <i class="ti ti-arrow-back-up" /> {a().resetConfiguration}
              </Button>
              <Show when={reset.error()}>
                {(error) => (
                  <InlineGuidance tone="danger" role="alert">
                    {error().message}
                  </InlineGuidance>
                )}
              </Show>
            </div>
          </NoticeCard>
        </Show>
        <SettingsSection title={t().connection} icon="ti ti-plug-connected">
          <fieldset class="grid min-w-0 gap-4 md:grid-cols-2" disabled={busy()}>
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
              description={
                props.configuration.unreadable
                  ? t().tokenUnreadable
                  : props.configuration.tokenConfigured
                    ? t().tokenPresent
                    : t().tokenMissing
              }
              value={token()}
              onValueChange={setToken}
            />
          </fieldset>
        </SettingsSection>
        <SettingsSection title={a().collabora} icon="ti ti-file-text">
          <fieldset class="flex min-w-0 flex-col gap-4" disabled={busy()}>
            <NoticeCard tone="info" title={a().collaboraPurpose} detail={a().collaboraExplanation} />
            <div class="grid min-w-0 gap-4 md:grid-cols-2">
              <TextInput
                name="collabora-url"
                type="url"
                label={a().collaboraUrl}
                description={a().collaboraUrlHint}
                value={configuration.collabora.url}
                onValueChange={(value) => setConfiguration("collabora", "url", value)}
                placeholder="https://office.example.org"
              />
              <Select
                name="collabora-format"
                label={a().documentFormat}
                value={configuration.collabora.documentFormat}
                onValueChange={(value) => setConfiguration("collabora", "documentFormat", value === "ooxml" ? "ooxml" : "odf")}
                options={[
                  { value: "odf", label: a().documentFormatOdf },
                  { value: "ooxml", label: a().documentFormatOoxml },
                ]}
              />
            </div>
            <Disclosure summary={a().advanced} surface="plain" icon="ti ti-network">
              <div class="grid min-w-0 gap-4 pt-4 md:grid-cols-2">
                <TextInput
                  name="collabora-internal-url"
                  type="url"
                  label={a().collaboraInternalUrl}
                  description={a().collaboraInternalUrlHint}
                  value={configuration.collabora.internalUrl}
                  onValueChange={(value) => setConfiguration("collabora", "internalUrl", value)}
                  placeholder="http://collabora:9980"
                />
                <TextInput
                  name="collabora-wopi-origin"
                  type="url"
                  label={a().collaboraWopiOrigin}
                  description={a().collaboraWopiOriginHint}
                  value={configuration.collabora.wopiOrigin}
                  onValueChange={(value) => setConfiguration("collabora", "wopiOrigin", value)}
                  placeholder="http://gateway:3000"
                />
              </div>
            </Disclosure>
          </fieldset>
        </SettingsSection>
        <For each={areas}>
          {(area) => (
            <SettingsSection title={t()[area]} icon={area === "cloud" ? "ti ti-cloud" : "ti ti-server"}>
              <fieldset class="flex min-w-0 flex-col gap-4" disabled={busy()}>
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
        <SettingsSection title={a().history} icon="ti ti-history">
          <fieldset class="grid min-w-0 gap-4 md:grid-cols-2" disabled={busy()}>
            <NumberInput
              name="activity-retention-days"
              label={a().historyRetention}
              description={a().historyRetentionHint}
              value={configuration.activityRetentionDays}
              min={RETENTION.min}
              max={RETENTION.max}
              allowNegative={false}
              suffix={a().historyRetentionDays}
              required
              onValueChange={(value) => {
                setConfiguration("activityRetentionDays", value);
                if (validRetention(value)) setInvalid(null);
              }}
            />
          </fieldset>
        </SettingsSection>
        {/* One place for every reason a save did not happen, so a refusal never adds a second line. */}
        <Show when={invalid() ?? save.error()?.message}>
          {(message) => (
            <InlineGuidance tone="danger" role="alert">
              {message()}
            </InlineGuidance>
          )}
        </Show>
        <Show when={saved()}>
          <InlineGuidance tone="success" role="status">
            {a().saved}
          </InlineGuidance>
        </Show>
      </form>
      <Disclosure summary={m().title} onValueChange={setMachinesOpen}>
        <Show when={machinesOpen()}>
          <MachineStorage />
        </Show>
      </Disclosure>
    </SettingsPage>
  );
}
