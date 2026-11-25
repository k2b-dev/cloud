import { Button, Choice, Dialog, Field, Input, Notice, Select } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import type { PulseSource } from "../../contracts";
import { MetricFiltersSchema, parseMetricFilterInput } from "../../metric-filters";
import { usePulseMessages } from "../use-messages";
import { SourceCreateError, SourceEditError } from "../workspace/source-actions";
import { normalizeEndpointInput } from "../workspace/source-helpers";
import { createSourceExpectationForm } from "../workspace/source-expectation-fields";
import type { CreateSourceInput, SourceCreateKind } from "../workspace/types";
import { useScreenMessages } from "./messages";

type ExpectationForm = ReturnType<typeof createSourceExpectationForm>;

/** When a pushing source is expected to deliver: never checked, at least every n seconds, or daily by a time. */
function ExpectationFields(props: { form: ExpectationForm; timezone: string }) {
  const t = usePulseMessages();
  return (
    <>
      <Field name="expectation" label={t().sourceExpectation} hint={t().sourceExpectationTimezone({ timezone: props.timezone })}>
        <Select
          options={[
            { value: "none", label: t().sourceExpectationNone },
            { value: "every", label: t().sourceExpectationEvery },
            { value: "daily", label: t().sourceExpectationDaily },
          ]}
          value={props.form.mode()}
          onChange={props.form.setMode}
        />
      </Field>
      <Show when={props.form.mode() === "every"}>
        <Field name="expectEvery" label={t().sourceExpectationSeconds} error={props.form.valid() ? undefined : t().sourceExpectationInvalid}>
          <Input
            type="number"
            min={1}
            max={2_147_483_647}
            value={String(props.form.seconds() ?? "")}
            onInput={(value) => props.form.setSeconds(value.trim() ? Number(value) : null)}
          />
        </Field>
      </Show>
      <Show when={props.form.mode() === "daily"}>
        <Field name="expectDaily" label={t().sourceExpectationTime} error={props.form.valid() ? undefined : t().sourceExpectationInvalid}>
          <Input value={props.form.time()} placeholder="04:00" onInput={props.form.setTime} />
        </Field>
      </Show>
    </>
  );
}

/** What a metrics endpoint needs: its address, how often Pulse reads it, which metrics stay and an optional token. */
function MetricsFields(props: {
  endpoint: string;
  setEndpoint: (value: string) => void;
  interval: string;
  setInterval: (value: string) => void;
  filters: string;
  setFilters: (value: string) => void;
  filtersValid: boolean;
  intervalValid: boolean;
  token: string;
  setToken: (value: string) => void;
  tokenHint: string;
  tried: boolean;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  return (
    <>
      <Field
        name="endpointUrl"
        label={t().endpointUrl}
        hint={t().endpointUrlDescription}
        required
        error={props.tried && !props.endpoint.trim() ? words().required : undefined}
      >
        <Input type="url" value={props.endpoint} placeholder="https://example.local/metrics" onInput={props.setEndpoint} />
      </Field>
      <Field
        name="scrapeInterval"
        label={t().scrapeInterval}
        optional={words().seconds}
        hint={t().scrapeIntervalDescription}
        error={props.intervalValid ? undefined : t().scrapeIntervalDescription}
      >
        <Input type="number" min={60} max={86_400} value={props.interval} onInput={props.setInterval} />
      </Field>
      <Field
        name="metricFilters"
        label={t().metricFilters}
        optional={words().optional}
        hint={t().metricFiltersDescription}
        error={props.filtersValid ? undefined : t().invalidMetricFilters}
      >
        <Input multiline value={props.filters} placeholder="node_cpu_seconds_total, node_filesystem_*" onInput={props.setFilters} />
      </Field>
      <Field name="bearerToken" label={t().bearerToken} optional={words().optional} hint={props.tokenHint}>
        <Input type="password" value={props.token} onInput={props.setToken} />
      </Field>
    </>
  );
}

const intervalOk = (value: string) => {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 60 && seconds <= 86_400;
};

/**
 * A new source in one dialog: first what Pulse should receive (a choice, pushing by default), then the fields that
 * kind needs. A lost answer leaves the dialog blocked with a way to look at the list, so nothing is created twice.
 */
export function NewSourceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseName: string;
  timezone: string;
  create: (input: CreateSourceInput) => Promise<boolean>;
  inspect: () => void;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [kind, setKind] = createSignal<SourceCreateKind>("http_ingest");
  const [name, setName] = createSignal("");
  const [endpoint, setEndpoint] = createSignal("");
  const [interval, setInterval] = createSignal("60");
  const [filters, setFilters] = createSignal("");
  const [token, setToken] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<"failed" | "uncertain" | null>(null);
  let expectation = createSourceExpectationForm({});
  const [form, setForm] = createSignal(expectation);
  const filtersValid = () => MetricFiltersSchema.safeParse(parseMetricFilterInput(filters())).success;
  const valid = () =>
    kind() === "metrics" ? Boolean(endpoint().trim()) && intervalOk(interval()) && filtersValid() : form().valid();
  const reset = () => {
    setKind("http_ingest");
    setName("");
    setEndpoint("");
    setInterval("60");
    setFilters("");
    setToken("");
    setTried(false);
    setFailure(null);
    expectation = createSourceExpectationForm({});
    setForm(expectation);
  };
  const close = (open: boolean) => {
    if (busy()) return;
    props.onOpenChange(open);
    if (!open) reset();
  };
  const submit = async () => {
    setTried(true);
    if (busy() || failure() === "uncertain" || !valid()) return;
    setBusy(true);
    setFailure(null);
    try {
      const created = await props.create({
        kind: kind(),
        name: name(),
        endpointUrl: endpoint(),
        bearerToken: token(),
        metricFilters: kind() === "metrics" ? parseMetricFilterInput(filters()) : undefined,
        scrapeIntervalSeconds: Number(interval()) || 60,
        ...(kind() === "http_ingest" ? form().value() : {}),
      });
      setBusy(false);
      if (created) close(false);
      else setFailure("failed");
    } catch (error) {
      setBusy(false);
      setFailure(!(error instanceof SourceCreateError) || error.kind === "uncertain" ? "uncertain" : "failed");
    }
  };
  return (
    <Dialog
      title={t().sourcePickTitle({ base: props.baseName })}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {words().cancel}
          </Button>
          <Show
            when={failure() !== "uncertain"}
            fallback={
              <Button
                variant="primary"
                onClick={() => {
                  close(false);
                  props.inspect();
                }}
              >
                {t().sourceInspectAfterCreate}
              </Button>
            }
          >
            <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
              {t().add}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={failure()}>
        {(state) => (
          <Notice tone="bad" icon="alert-circle">
            {state() === "uncertain" ? t().sourceCreateUncertain : t().sourceAddFailed}
          </Notice>
        )}
      </Show>
      <Field name="kind" label={words().sourceKindTitle} hint={kind() === "metrics" ? words().metricsKindHint : words().ingestKindHint}>
        <Choice
          name="kind"
          options={[
            { value: "http_ingest", label: t().sourcePickPush },
            { value: "metrics", label: t().sourcePickPull },
          ]}
          value={kind()}
          onChange={(value) => setKind(value === "metrics" ? "metrics" : "http_ingest")}
        />
      </Field>
      <Field name="name" label={t().name} optional={words().optional} hint={t().sourceNameDescription}>
        <Input value={name()} placeholder={kind() === "http_ingest" ? t().salesPipelineExample : t().serviceMetricsExample} onInput={setName} />
      </Field>
      <Show when={kind() === "metrics"} fallback={<ExpectationFields form={form()} timezone={props.timezone} />}>
        <MetricsFields
          endpoint={endpoint()}
          setEndpoint={setEndpoint}
          interval={interval()}
          setInterval={setInterval}
          intervalValid={intervalOk(interval())}
          filters={filters()}
          setFilters={setFilters}
          filtersValid={filtersValid()}
          token={token()}
          setToken={setToken}
          tokenHint={t().bearerTokenDescription}
          tried={tried()}
        />
      </Show>
    </Dialog>
  );
}

/** Changes to one source. A conflict or a lost answer blocks a second save until the list was read again. */
export function EditSourceDialog(props: {
  source: PulseSource | null;
  onClose: () => void;
  timezone: string;
  save: (source: PulseSource, patch: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <Show when={props.source} keyed>
      {(source) => <EditSourceForm source={source} onClose={props.onClose} timezone={props.timezone} save={props.save} />}
    </Show>
  );
}

function EditSourceForm(props: {
  source: PulseSource;
  onClose: () => void;
  timezone: string;
  save: (source: PulseSource, patch: Record<string, unknown>) => Promise<void>;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const source = props.source;
  const [name, setName] = createSignal(source.name);
  const [endpoint, setEndpoint] = createSignal(source.endpointUrl ?? "");
  const [interval, setInterval] = createSignal(String(source.scrapeIntervalSeconds ?? 60));
  const [filters, setFilters] = createSignal(source.metricFilters.join(", "));
  const [token, setToken] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [blocked, setBlocked] = createSignal(false);
  const expectation = createSourceExpectationForm(source);
  const filtersValid = () => MetricFiltersSchema.safeParse(parseMetricFilterInput(filters())).success;
  const valid = () =>
    Boolean(name().trim()) &&
    (source.kind === "metrics" ? Boolean(endpoint().trim()) && intervalOk(interval()) && filtersValid() : expectation.valid());
  const close = (open: boolean) => {
    if (!open && !busy()) props.onClose();
  };
  const submit = async () => {
    setTried(true);
    if (busy() || blocked() || !valid()) return;
    setBusy(true);
    setError(null);
    const patch =
      source.kind === "metrics"
        ? {
            endpointUrl: normalizeEndpointInput(endpoint().trim()),
            scrapeIntervalSeconds: Number(interval()),
            metricFilters: parseMetricFilterInput(filters()),
            ...(token().trim() ? { bearerToken: token().trim() } : {}),
          }
        : expectation.value();
    try {
      await props.save(source, { name: name().trim(), expectedRevision: source.revision, ...patch });
      setBusy(false);
      props.onClose();
    } catch (failure) {
      setBusy(false);
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
    <Dialog
      title={source.kind === "metrics" ? t().editMetricsSource : t().editSource}
      open
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {words().cancel}
          </Button>
          <Button variant="primary" busy={busy()} disabled={blocked()} onClick={() => void submit()}>
            {words().save}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(message) => (
          <Notice tone={blocked() ? "warn" : "bad"} icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Field name="name" label={t().name} required error={tried() && !name().trim() ? words().required : undefined}>
        <Input value={name()} onInput={setName} />
      </Field>
      <Show when={source.kind === "metrics"} fallback={<ExpectationFields form={expectation} timezone={props.timezone} />}>
        <MetricsFields
          endpoint={endpoint()}
          setEndpoint={setEndpoint}
          interval={interval()}
          setInterval={setInterval}
          intervalValid={intervalOk(interval())}
          filters={filters()}
          setFilters={setFilters}
          filtersValid={filtersValid()}
          token={token()}
          setToken={setToken}
          tokenHint={source.bearerTokenConfigured ? words().bearerTokenHint : t().bearerTokenDescription}
          tried={tried()}
        />
      </Show>
    </Dialog>
  );
}
