import { createSignal, Show, onCleanup } from "solid-js";
import { Button, FilterChip, TextInput, Switch, useLocale } from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { navigateTo } from "@k2b/ssr/nav";
import { browserMessages } from "./messages";
import { browserUrl, type BrowserFilter } from "./filter";
import { TELEMETRY_RANGES, isTelemetryRange } from "../contracts";

export default function Controls(props: { filter: BrowserFilter; apps: { id: string; name: string }[]; enabled: boolean | null }) {
  const { t } = browserMessages.resolve([useLocale()()]);
  const [enabled, setEnabled] = createSignal(props.enabled),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(false);
  let controller: AbortController | undefined;
  let requested = false;
  onCleanup(() => controller?.abort());
  const [route, setRoute] = createSignal(props.filter.route);
  async function save(value: boolean) {
    if (pending()) return;
    requested = value;
    controller = new AbortController();
    const signal = controller.signal;
    setPending(true);
    setError(false);
    try {
      const response = await coreClient.admin.core.settings.$put(
        { json: { updates: { "observability.web_vitals.enabled": value } } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error("save");
      const confirmed = await coreClient.admin.core.settings["web-vitals"].$get({}, { init: { signal } });
      if (!confirmed.ok) throw new Error("read");
      const state = await confirmed.json();
      setEnabled(state.enabled);
      if (state.enabled !== value) throw new Error("mismatch");
    } catch {
      if (!signal.aborted) {
        setError(true);
        setEnabled(null);
      }
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }
  return (
    <>
      <section class="paper p-3 space-y-2">
        <Switch label={t.collect} value={enabled() === true} disabled={pending()} onValueChange={save} />
        <p class="text-xs text-dimmed" role="status">
          {enabled() === null ? t.unknown : enabled() ? t.active : t.inactive}
        </p>
        <p class="text-[10px] text-dimmed">{t.costs}</p>
        <Show when={error()}>
          <div>
            <p role="alert" class="text-xs text-red-600">
              {t.saveError}
            </p>
            <Button size="sm" variant="secondary" disabled={pending()} onClick={() => save(requested)}>
              {t.retry}
            </Button>
          </div>
        </Show>
        <Show when={enabled() === false}>
          <p class="text-xs text-dimmed">{t.history}</p>
        </Show>
      </section>
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={props.filter.range}
          icon="ti ti-clock"
          value={[props.filter.range]}
          options={[{ options: Object.keys(TELEMETRY_RANGES).map((value) => ({ value, label: value })) }]}
          onValueChange={(values) => {
            if (isTelemetryRange(values[0])) navigateTo(browserUrl(props.filter, { range: values[0], page: 1 }));
          }}
        />
        <FilterChip
          label={props.filter.appId ? (props.apps.find((app) => app.id === props.filter.appId)?.name ?? props.filter.appId) : t.app}
          icon="ti ti-apps"
          value={props.filter.appId ? [props.filter.appId] : []}
          options={[{ options: [{ value: "", label: t.allApps }, ...props.apps.map((app) => ({ value: app.id, label: app.name }))] }]}
          onValueChange={(values) => navigateTo(browserUrl(props.filter, { appId: values[0] ?? "", page: 1 }))}
        />
        <form
          class="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            navigateTo(browserUrl(props.filter, { route: route().trim(), page: 1 }));
          }}
        >
          <TextInput aria-label={t.route} placeholder={t.route} value={route()} onValueChange={setRoute} maxLength={200} />
          <Button type="submit" size="sm" variant="secondary">
            {t.apply}
          </Button>
        </form>
        <a class="text-xs text-dimmed hover:text-primary" href={browserUrl(props.filter, { appId: "", route: "", page: 1 })}>
          {t.clear}
        </a>
      </div>
    </>
  );
}
