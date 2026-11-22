import { Button, dialogCore, NoticeCard, NumberInput, PanelDialog, panelDialogOptions, Select, TextInput } from "@k2b/ui";
import { type Accessor, createSignal, Show } from "solid-js";
import { MetricFiltersSchema, parseMetricFilterInput } from "../../metric-filters";
import { usePulseMessages } from "../use-messages";
import { SourceCreateError } from "./source-actions";
import { createSourceExpectationForm, SourceExpectationFields } from "./source-expectation-fields";
import type { CreateSourceInput, SourceCreateKind } from "./types";

type SourceCreateDialogOptions = {
  loading: Accessor<boolean>;
  baseName?: string;
  timezone?: string;
  askAssistant?: () => Promise<void>;
  assistantPending?: Accessor<boolean>;
  assistantError?: Accessor<string | null>;
  createSource: (input: CreateSourceInput) => Promise<boolean>;
  inspectSources: () => void;
};

export const openSourceCreateDialog = (options: SourceCreateDialogOptions) =>
  dialogCore.open<void>((close) => {
    const t = usePulseMessages();
    const [choosing, setChoosing] = createSignal(true);
    const [failure, setFailure] = createSignal(false);
    const [uncertain, setUncertain] = createSignal(false);
    const expectation = createSourceExpectationForm({});
    const [kind, setKind] = createSignal<SourceCreateKind>("http_ingest");
    const [name, setName] = createSignal("");
    const [endpointUrl, setEndpointUrl] = createSignal("");
    const [metricFilters, setMetricFilters] = createSignal("");
    const filtersValid = () => MetricFiltersSchema.safeParse(parseMetricFilterInput(metricFilters())).success;
    const [bearerToken, setBearerToken] = createSignal("");
    const [scrapeIntervalSeconds, setScrapeIntervalSeconds] = createSignal<number | null>(60);
    const title = () => (kind() === "http_ingest" ? t().httpIngest : t().metricsEndpoint);

    const submit = async () => {
      if (options.loading() || choosing() || uncertain() || (kind() === "metrics" ? !filtersValid() : !expectation.valid())) return;
      setFailure(false);
      try {
        const created = await options.createSource({
          kind: kind(),
          name: name(),
          endpointUrl: endpointUrl(),
          bearerToken: bearerToken(),
          metricFilters: kind() === "metrics" ? parseMetricFilterInput(metricFilters()) : undefined,
          scrapeIntervalSeconds: scrapeIntervalSeconds() ?? 60,
          ...(kind() === "http_ingest" ? expectation.value() : {}),
        });
        if (created) close();
        else setFailure(true);
      } catch (error) {
        setUncertain(!(error instanceof SourceCreateError) || error.kind === "uncertain");
        setFailure(true);
      }
    };

    return (
      <Show
        when={!choosing()}
        fallback={
          <PanelDialog>
            <PanelDialog.Header
              title={options.baseName ? t().sourcePickTitle({ base: options.baseName }) : t().newSource}
              subtitle={t().sourcePickDescription}
              close={close}
            />
            <PanelDialog.Body>
              <div class="pulse-source-picker">
                <Button
                  variant="ghost"
                  align="start"
                  wrap
                  onClick={() => {
                    setKind("metrics");
                    setChoosing(false);
                  }}
                >
                  <span class="pulse-source-choice">
                    <i class="ti ti-download pulse-source-choice__pull" aria-hidden="true" />
                    <span>
                      <strong>{t().sourcePickPull}</strong>
                      <span>{t().sourcePickPullDetail}</span>
                    </span>
                    <i class="ti ti-chevron-right" aria-hidden="true" />
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  align="start"
                  wrap
                  onClick={() => {
                    setKind("http_ingest");
                    setChoosing(false);
                  }}
                >
                  <span class="pulse-source-choice">
                    <i class="ti ti-send pulse-source-choice__push" aria-hidden="true" />
                    <span>
                      <strong>{t().sourcePickPush}</strong>
                      <span>{t().sourcePickPushDetail}</span>
                    </span>
                    <i class="ti ti-chevron-right" aria-hidden="true" />
                  </span>
                </Button>
                <Show when={options.askAssistant}>
                  <Button
                    variant="ghost"
                    align="start"
                    wrap
                    disabled={options.assistantPending?.()}
                    onClick={() => void options.askAssistant?.()}
                  >
                    <span class="pulse-source-choice">
                      <i class="ti ti-sparkles pulse-source-choice__ai" aria-hidden="true" />
                      <span>
                        <strong>{t().sqlAskAssistant}</strong>
                        <span>{t().sourcePickAssistantDetail}</span>
                      </span>
                      <i class="ti ti-chevron-right" aria-hidden="true" />
                    </span>
                  </Button>
                </Show>
              </div>
              <Show when={options.assistantError?.()}>
                <p role="alert" class="text-sm text-danger">
                  {options.assistantError?.()}
                </p>
              </Show>
            </PanelDialog.Body>
          </PanelDialog>
        }
      >
        <form
          class="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PanelDialog>
            <PanelDialog.Header title={t().newSource} subtitle={t().newSourceDescription} icon="ti ti-plug-connected" close={close} />
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
                  onValueChange={(value) => {
                    if (value === "http_ingest" || value === "metrics") setKind(value);
                  }}
                  options={[
                    { id: "http_ingest", icon: "ti ti-webhook" },
                    { id: "metrics", icon: "ti ti-plug" },
                  ].map((option) => ({
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
                      min={60}
                      step={60}
                      max={86_400}
                      value={scrapeIntervalSeconds}
                      onValueChange={setScrapeIntervalSeconds}
                    />
                  </div>
                  <TextInput
                    label={t().metricFilters}
                    description={t().metricFiltersDescription}
                    value={metricFilters}
                    onValueChange={setMetricFilters}
                    placeholder="node_cpu_seconds_total, node_filesystem_*"
                    icon="ti ti-filter"
                    monospace
                    multiline
                    error={filtersValid() ? undefined : t().invalidMetricFilters}
                  />
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
                  <NoticeCard tone="info">{t().sourceInfo}</NoticeCard>
                  <SourceExpectationFields form={expectation} timezone={options.timezone ?? "UTC"} disabled={options.loading} />
                </Show>
              </PanelDialog.Section>
            </PanelDialog.Body>
            <Show when={failure()}>
              <p role="alert" class="px-5 text-sm text-danger">
                {uncertain() ? t().sourceCreateUncertain : t().sourceAddFailed}
              </p>
            </Show>
            <PanelDialog.Footer>
              <Button type="button" variant="ghost" onClick={() => setChoosing(true)} disabled={options.loading() || uncertain()}>
                {t().sourceBackToChoice}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => close()} disabled={options.loading()}>
                {t().cancel}
              </Button>
              <Show when={uncertain()}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    close();
                    options.inspectSources();
                  }}
                >
                  {t().sourceInspectAfterCreate}
                </Button>
              </Show>
              <Button
                type="submit"
                size="sm"
                disabled={
                  options.loading() ||
                  uncertain() ||
                  (kind() === "metrics" ? !endpointUrl().trim() || !filtersValid() : !expectation.valid())
                }
              >
                <i class={`ti ${options.loading() ? "ti-loader-2 animate-spin" : "ti-plus"} text-sm`} aria-hidden="true" />
                {t().add}
              </Button>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      </Show>
    );
  }, panelDialogOptions);
