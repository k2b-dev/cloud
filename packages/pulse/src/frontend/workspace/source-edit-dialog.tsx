import { Button, dialogCore, NumberInput, PanelDialog, panelDialogOptions, TextInput } from "@k2b/ui";
import { type Accessor, createSignal, Show } from "solid-js";
import type { PulseSource } from "../../contracts";
import { MetricFiltersSchema, parseMetricFilterInput } from "../../metric-filters";
import { usePulseMessages } from "../use-messages";
import { normalizeEndpointInput } from "./helpers";
import { createSourceExpectationForm, SourceExpectationFields } from "./source-expectation-fields";

export class SourceEditError extends Error {
  constructor(
    readonly kind: "conflict" | "uncertain" | "rejected",
    message: string,
  ) {
    super(message);
  }
}

export const openSourceEditDialog = (
  source: PulseSource,
  options: {
    loading: Accessor<boolean>;
    timezone: string;
    save: (patch: Record<string, unknown>) => Promise<void>;
  },
) =>
  dialogCore.open<void>((close) => {
    const t = usePulseMessages();
    const [name, setName] = createSignal(source.name);
    const [endpoint, setEndpoint] = createSignal(source.endpointUrl ?? "");
    const [interval, setInterval] = createSignal<number | null>(source.scrapeIntervalSeconds ?? 60);
    const [filters, setFilters] = createSignal(source.metricFilters.join(", "));
    const [token, setToken] = createSignal("");
    const [error, setError] = createSignal<string | null>(null);
    const [blocked, setBlocked] = createSignal(false);
    const expectation = createSourceExpectationForm(source);
    const filtersValid = () => MetricFiltersSchema.safeParse(parseMetricFilterInput(filters())).success;
    const valid = () =>
      Boolean(name().trim()) &&
      (source.kind === "metrics"
        ? Boolean(endpoint().trim()) && Number.isInteger(interval()) && interval()! >= 60 && interval()! <= 86_400 && filtersValid()
        : expectation.valid());
    const submit = async () => {
      if (options.loading() || blocked() || !valid()) return;
      setError(null);
      const patch =
        source.kind === "metrics"
          ? {
              endpointUrl: normalizeEndpointInput(endpoint().trim()),
              scrapeIntervalSeconds: interval(),
              metricFilters: parseMetricFilterInput(filters()),
              ...(token().trim() ? { bearerToken: token().trim() } : {}),
            }
          : expectation.value();
      try {
        await options.save({ name: name().trim(), expectedRevision: source.revision, ...patch });
        close();
      } catch (failure) {
        const kind = failure instanceof SourceEditError ? failure.kind : "uncertain";
        setBlocked(kind !== "rejected");
        setError(
          kind === "conflict"
            ? t().sourceEditConflict
            : kind === "uncertain"
              ? t().sourceEditUncertain
              : failure instanceof Error
                ? failure.message
                : t().sourceUpdateFailed,
        );
      }
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
          <PanelDialog.Header title={source.kind === "metrics" ? t().editMetricsSource : t().editSource} close={close} />
          <PanelDialog.Body>
            <TextInput
              label={t().sourceName}
              description={t().sourceNameEditDescription}
              value={name}
              onValueChange={setName}
              required
              disabled={options.loading()}
            />
            <Show
              when={source.kind === "metrics"}
              fallback={<SourceExpectationFields form={expectation} timezone={options.timezone} disabled={options.loading} />}
            >
              <TextInput
                label={t().metricsEndpointUrl}
                description={t().metricsEndpointEditDescription}
                type="url"
                value={endpoint}
                onValueChange={setEndpoint}
                required
                disabled={options.loading()}
              />
              <NumberInput
                label={t().scrapeIntervalSeconds}
                description={t().scrapeIntervalEditDescription}
                value={interval}
                onValueChange={setInterval}
                min={60}
                max={86_400}
                step={60}
                disabled={options.loading()}
              />
              <TextInput
                label={t().metricFilters}
                description={t().metricFiltersDescription}
                value={filters}
                onValueChange={setFilters}
                multiline
                disabled={options.loading()}
                error={filtersValid() ? undefined : t().invalidMetricFilters}
              />
              <TextInput
                label={t().newBearerToken}
                description={t().newBearerTokenDescription}
                placeholder={t().leaveUnchanged}
                value={token}
                onValueChange={setToken}
                password
                disabled={options.loading()}
              />
            </Show>
            <Show when={error()}>
              <p role="alert" class="text-sm text-danger">
                {error()}
              </p>
            </Show>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <Button type="button" variant="secondary" onClick={() => close()} disabled={options.loading()}>
              {t().cancel}
            </Button>
            <Button type="submit" disabled={!valid() || options.loading() || blocked()}>
              {t().save}
            </Button>
          </PanelDialog.Footer>
        </PanelDialog>
      </form>
    );
  }, panelDialogOptions);
