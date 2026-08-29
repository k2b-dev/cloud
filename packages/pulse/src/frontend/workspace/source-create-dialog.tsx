import { NoticeCard, Button, dialogCore, NumberInput, PanelDialog, panelDialogOptions, Select, TextInput } from "@k2b/ui";
import { createSignal, Show, type Accessor } from "solid-js";
import { SOURCE_TYPE_OPTIONS } from "./helpers";
import type { CreateSourceInput, SourceCreateKind } from "./types";
import { usePulseMessages } from "../use-messages";

type SourceCreateDialogOptions = {
  loading: Accessor<boolean>;
  createSource: (input: CreateSourceInput) => Promise<boolean>;
};

export const openSourceCreateDialog = (options: SourceCreateDialogOptions) =>
  dialogCore.open<void>((close) => {
    const t = usePulseMessages();
    const [kind, setKind] = createSignal<SourceCreateKind>("http_ingest");
    const [name, setName] = createSignal("");
    const [endpointUrl, setEndpointUrl] = createSignal("");
    const [bearerToken, setBearerToken] = createSignal("");
    const [scrapeIntervalSeconds, setScrapeIntervalSeconds] = createSignal<number | null>(60);
    const title = () => (kind() === "http_ingest" ? t().httpIngest : t().metricsEndpoint);

    const submit = async () => {
      const created = await options.createSource({
        kind: kind(),
        name: name(),
        endpointUrl: endpointUrl(),
        bearerToken: bearerToken(),
        scrapeIntervalSeconds: scrapeIntervalSeconds() ?? 60,
      });
      if (created) close();
    };

    return (
      <form
        class="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PanelDialog>
          <PanelDialog.Header
            title={t().newSource}
            subtitle={t().newSourceDescription}
            icon="ti ti-plug-connected"
            close={close}
          />
          <PanelDialog.Body>
            <TextInput
              label={t().name}
              description={t().sourceNameDescription}
              icon="ti ti-tag"
              value={name}
              onValueChange={setName}
              placeholder={kind() === "http_ingest" ? t().salesPipelineExample : t().serviceMetricsExample}
            />

            <PanelDialog.Section title={title()} subtitle={t().sourceReceiveDescription} icon="ti ti-route">
              <Select
                label={t().type}
                description={t().sourceTypeDescription}
                icon="ti ti-plug-connected"
                value={kind}
                onValueChange={(value) => setKind(value as SourceCreateKind)}
                options={SOURCE_TYPE_OPTIONS.map((option) => ({
                  ...option,
                  label: option.id === "http_ingest" ? t().httpIngest : t().metricsEndpoint,
                  description: option.id === "http_ingest" ? t().ingestDescription : t().metricsEndpointEditDescription,
                }))}
                required
              />
              <Show when={kind() === "metrics"}>
                <div class="grid gap-3 md:grid-cols-2">
                  <TextInput
                    label={t().endpointUrl}
                    description={t().endpointUrlDescription}
                    type="url"
                    icon="ti ti-link"
                    value={endpointUrl}
                    onValueChange={setEndpointUrl}
                    placeholder="https://example.local/metrics"
                    required
                  />
                  <NumberInput
                    label={t().scrapeInterval}
                    description={t().scrapeIntervalDescription}
                    icon="ti ti-refresh"
                    suffix={t().secondsShort}
                    min={10}
                    max={86_400}
                    value={scrapeIntervalSeconds}
                    onValueChange={setScrapeIntervalSeconds}
                  />
                </div>
                <TextInput
                  label={t().bearerToken}
                  description={t().bearerTokenDescription}
                  icon="ti ti-key"
                  value={bearerToken}
                  onValueChange={setBearerToken}
                  placeholder={t().optional}
                  password
                />
              </Show>
              <Show when={kind() !== "metrics"}>
                <NoticeCard tone="info" icon={false}>
                  <div class="flex items-start gap-2">
                    <i class="ti ti-info-circle mt-0.5 shrink-0 text-blue-500" />
                    <p>{t().sourceInfo}</p>
                  </div>
                </NoticeCard>
              </Show>
            </PanelDialog.Section>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <Button type="button" variant="secondary" size="sm" onClick={() => close()} disabled={options.loading()}>
              {t().cancel}
            </Button>
            <Button type="submit" size="sm" disabled={options.loading() || (kind() === "metrics" && !endpointUrl().trim())}>
              <i class={`ti ${options.loading() ? "ti-loader-2 animate-spin" : "ti-plus"} text-sm`} />
              {t().add}
            </Button>
          </PanelDialog.Footer>
        </PanelDialog>
      </form>
    );
  }, panelDialogOptions);
