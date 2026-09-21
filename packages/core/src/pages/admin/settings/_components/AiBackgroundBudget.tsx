import { coreClient } from "@k2b/cloud/clients/core";
import type { AiQuotaConfig } from "@k2b/cloud/shared";
import { Button, ButtonLink, NoticeCard, NumberInput, Placeholder, Switch, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";

export default function AiBackgroundBudget(props: {
  config: AiQuotaConfig;
  change: (config: AiQuotaConfig) => void;
  disabled: boolean;
  canRelease: boolean;
}) {
  const locale = useLocale();
  const de = () => locale().startsWith("de");
  const api = coreClient.admin.core["ai-quotas"];
  const budget = () => props.config.background ?? { enabled: false, warnAt: null, stopAt: 10 };
  const update = (patch: Partial<NonNullable<AiQuotaConfig["background"]>>) =>
    props.change({ ...props.config, background: { ...budget(), ...patch } });
  const [state, setState] = createSignal<{ used: number; reserved: number; unknown: number; stoppedAt: string | null }>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function refresh() {
    try {
      const response = await api.background.$get();
      if (!response.ok) throw new Error(de() ? "Status konnte nicht geladen werden." : "Could not load status.");
      setState(await response.json());
      setError("");
    } catch (error) {
      setError(String(error));
    }
  }
  onMount(() => void refresh());
  return (
    <section class="paper flex flex-col gap-4 p-4">
      <TextInput
        label={de() ? "Recheneinheit" : "Accounting unit"}
        value={props.config.unit ?? "EUR"}
        disabled={props.disabled}
        onValueChange={(unit) => props.change({ ...props.config, unit })}
      />
      <p class="text-xs text-dimmed">
        {de()
          ? "EUR empfohlen. Nach der ersten bepreisten Nutzung ist die Einheit festgelegt."
          : "EUR recommended. The unit is fixed after the first priced call."}
      </p>
      <Switch
        label={de() ? "Notbremse für Hintergrund-AI" : "Background AI emergency stop"}
        description={
          de()
            ? "Gemeinsame Referenzkosten der letzten 24 Stunden. Workflows und interne Aufgaben; unbepreiste Modelle sind ausgenommen."
            : "Combined reference costs over the last 24 hours. Workflows and internal tasks; unpriced models are excluded."
        }
        value={budget().enabled}
        onValueChange={(enabled) => update({ enabled })}
        disabled={props.disabled}
      />
      <Show when={budget().enabled}>
        <div class="grid gap-4 sm:grid-cols-2">
          <NumberInput
            label={de() ? "Warnung ab (optional)" : "Warn at (optional)"}
            value={budget().warnAt}
            step={0.000001}
            clearable
            min={0}
            showSteppers={false}
            disabled={props.disabled}
            onValueChange={(warnAt) => update({ warnAt })}
          />
          <NumberInput
            label={de() ? "Stopp ab" : "Stop at"}
            value={budget().stopAt}
            step={0.000001}
            min={0.000001}
            showSteppers={false}
            disabled={props.disabled}
            onValueChange={(stopAt) => {
              if (stopAt !== null) update({ stopAt });
            }}
          />
        </div>
        <p class="text-xs text-muted">
          {de()
            ? "Laufende Aufrufe werden noch gebucht. Nach Auslösung bleibt die Bremse bis zur bewussten Freigabe aktiv."
            : "Calls already running are still recorded. Once triggered, the stop stays active until explicitly released."}
        </p>
      </Show>
      <Show when={state()}>
        {(current) => (
          <div class="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {current().used.toLocaleString(locale(), { maximumSignificantDigits: 6 })} {props.config.unit ?? "EUR"} / 24h
            </span>
            <Show when={current().unknown}>
              <span>{de() ? "Unvollständige Messung" : "Incomplete measurement"}</span>
            </Show>
            <Show when={!current().stoppedAt && budget().enabled && budget().warnAt !== null && current().used >= budget().warnAt!}>
              <span class="text-warning">{de() ? "Warnschwelle erreicht" : "Warning threshold reached"}</span>
            </Show>
            <Show when={current().stoppedAt}>
              <NoticeCard tone="warning" title={de() ? "Hintergrund-AI angehalten" : "Background AI stopped"} />
              <Button
                disabled={busy() || props.disabled || !props.canRelease}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const response = await api.background.release.$post();
                    if (!response.ok)
                      throw new Error(
                        response.status === 409
                          ? de()
                            ? "Freigabe nicht möglich: Der Verbrauch ist noch zu hoch oder Kosten sind noch ungeklärt."
                            : "Cannot release: usage or unknown costs still prevent admission."
                          : response.status === 403
                            ? de()
                              ? "Keine Berechtigung zur Freigabe."
                              : "You do not have permission to release the stop."
                            : de()
                              ? "Freigabe fehlgeschlagen. Bitte erneut versuchen."
                              : "Could not release the stop. Please try again.",
                      );
                    await refresh();
                    // Release changes the configuration revision. Reload before editing again.
                    window.location.reload();
                  } catch (error) {
                    setError(String(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {de() ? "Bremse freigeben" : "Release stop"}
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <Placeholder state="error" description={error()} />
      </Show>
      <ButtonLink variant="text" href="/admin/settings?tab=ai-usage&view=runs&kind=background&range=24h&sort=cost">
        {de() ? "Hintergrundkosten untersuchen" : "Inspect background costs"}
      </ButtonLink>
      <Button size="sm" variant="ghost" onClick={() => void refresh()}>
        {de() ? "Status aktualisieren" : "Refresh status"}
      </Button>
    </section>
  );
}
