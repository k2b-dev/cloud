import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, Checkbox, InlineGuidance, Paper, TextInput } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { apiClient } from "../api/client";
import { type Area, type Availability, type ConfigurationInput, ErrorSchema, type PublicConfiguration } from "../contracts";
import { useFilesMessages } from "./messages";

export default function Settings(props: { configuration: PublicConfiguration; availability: Availability }) {
  const t = useFilesMessages();
  const [configuration, setConfiguration] = createStore({
    url: props.configuration.url,
    cloud: { ...props.configuration.cloud },
    freeipa: { ...props.configuration.freeipa },
  });
  const [token, setToken] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const save = mutation.create({
    mutation: async (json: ConfigurationInput, { abortSignal }) => {
      const response = await apiClient.admin.configuration.$put({ json }, { init: { signal: abortSignal } });
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : t().saveFailed);
      }
    },
    onSuccess: async () => {
      setToken("");
      setSaved(true);
      await refreshCurrentPath();
    },
  });
  onCleanup(() => save.abort());
  const areas: Area[] = ["cloud", "freeipa"];
  const available = (area: Area) => (area === "cloud" ? props.availability.localLinuxEnabled : props.availability.freeipaEnabled);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (save.loading()) return;
    setSaved(false);
    void save.mutate({
      url: configuration.url,
      cloud: { ...configuration.cloud },
      freeipa: { ...configuration.freeipa },
      ...(token() ? { token: token() } : {}),
    });
  };
  return (
    <Paper class="p-4">
      <form onSubmit={submit} class="flex flex-col gap-5" aria-label={t().settings}>
        <h2 class="text-base font-semibold text-primary">{t().settings}</h2>
        <fieldset class="flex min-w-0 flex-col gap-3" disabled={save.loading()}>
          <legend class="mb-3 text-sm font-semibold text-primary">{t().connection}</legend>
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
          <p class="text-xs text-dimmed">{t().tokenDescription}</p>
        </fieldset>
        <div class="grid min-w-0 gap-6 lg:grid-cols-2">
          <For each={areas}>
            {(area) => (
              <fieldset class="flex min-w-0 flex-col gap-3" disabled={save.loading()}>
                <legend class="mb-3 text-sm font-semibold text-primary">{t()[area]}</legend>
                <Checkbox
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
                  value={configuration[area].root}
                  onValueChange={(value) => setConfiguration(area, "root", value)}
                  required
                />
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
              </fieldset>
            )}
          </For>
        </div>
        <Show when={save.error()}>
          {(error) => (
            <InlineGuidance tone="danger" role="alert">
              {error().message}
            </InlineGuidance>
          )}
        </Show>
        <Show when={saved()}>
          <InlineGuidance tone="success" role="status">
            {t().saved}
          </InlineGuidance>
        </Show>
        <div>
          <Button type="submit" loading={save.loading()} loadingLabel={t().saving}>
            {t().save}
          </Button>
        </div>
      </form>
    </Paper>
  );
}
