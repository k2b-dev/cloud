import { coreClient } from "@k2b/cloud/clients/core";
import type { AiQuotaConfig } from "@k2b/cloud/shared";
import { Check, Facts, Field, Input, Notice, Section, Text, useLocale } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { aiAreaMessages } from "../../ai/messages";

export type BackgroundCostState = { used: number; reserved: number; unknown: number; stoppedAt: string | null };
type State = BackgroundCostState;

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

/**
 * The background cost brake as settings: the accounting unit, the brake with its warning and stop thresholds, and the
 * spending of the last 24 hours. A brake that stopped background AI is released here, once nothing unsaved waits.
 * The server reads the spending with the page (`initial`), so the first picture shows it; only when that read failed
 * does the browser ask again, and "Aktualisieren" reads it anew.
 */
export default function AiBackgroundBudget(props: {
  config: AiQuotaConfig;
  change: (config: AiQuotaConfig) => void;
  disabled: boolean;
  canRelease: boolean;
  /** The spending of the last 24 hours as the server read it; null when that read failed. */
  initial?: State | null;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const api = coreClient.admin.core["ai-quotas"];
  const budget = () => props.config.background ?? { enabled: false, warnAt: null, stopAt: 10 };
  const unit = () => props.config.unit ?? "EUR";
  const update = (patch: Partial<NonNullable<AiQuotaConfig["background"]>>) =>
    props.change({ ...props.config, background: { ...budget(), ...patch } });
  const [state, setState] = createSignal<State | undefined>(props.initial ?? undefined);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(!props.initial);
  const refresh = async () => {
    setLoading(true);
    try {
      const response = await api.background.$get();
      if (!response.ok) throw new Error(t().brakeStateFailed);
      setState(await response.json());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().brakeStateFailed);
    } finally {
      setLoading(false);
    }
  };
  const release = async () => {
    setBusy(true);
    try {
      const response = await api.background.release.$post();
      if (!response.ok)
        throw new Error(response.status === 409 ? t().releaseBlocked : response.status === 403 ? t().releaseForbidden : t().releaseFailed);
      // Release changes the configuration revision. Reload before editing again.
      window.location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().releaseFailed);
      setBusy(false);
    }
  };
  onMount(() => {
    if (!props.initial) void refresh();
  });
  const amount = (value: number) => `${value.toLocaleString(locale(), { maximumSignificantDigits: 6 })} ${unit()}`;
  const warned = () => {
    const current = state();
    return Boolean(current && !current.stoppedAt && budget().enabled && budget().warnAt !== null && current.used >= budget().warnAt!);
  };

  return (
    <>
      <Show when={state()?.stoppedAt}>
        <Notice
          tone="bad"
          icon="hand-stop"
          title={t().brakeStopped}
          primary={{
            label: t().releaseBrake,
            icon: "player-play",
            disabled: busy() || props.disabled || !props.canRelease,
            onClick: () => void release(),
          }}
        >
          {props.canRelease ? t().brakeStoppedSub : t().brakeSaveFirst}
        </Notice>
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().loadFailed}>
          {error()}
        </Notice>
      </Show>
      <Section
        icon="activity"
        title={t().brakeLast24h}
        actions={[
          { label: t().refreshState, icon: "refresh", disabled: loading(), onClick: () => void refresh() },
          { label: t().inspectBackgroundCosts, href: "/admin/ai?sec=usage&view=runs&kind=background&range=24h&sort=cost", forward: true },
        ]}
      >
        <Facts
          loading={loading()}
          items={[
            { label: t().brakeUsed, value: state() ? amount(state()!.used) : "" },
            { label: t().brakeReserved, value: state() ? amount(state()!.reserved) : "" },
            {
              label: t().colState,
              value: state()
                ? state()!.stoppedAt
                  ? t().brakeStopped
                  : warned()
                    ? t().warnReached
                    : state()!.unknown
                      ? t().measureIncomplete
                      : budget().enabled
                        ? t().brakeWatching
                        : t().brakeOff
                : "",
            },
          ]}
        />
      </Section>
      <Section icon="hand-stop" title={t().brake}>
        {/* slot for #4208/#4223 (DP): the fields of the brake become Setting rows (name left, value at a fixed width) */}
        <Field label={t().accountingUnit} hint={t().unitHint}>
          <Input value={unit()} disabled={props.disabled} onInput={(value) => props.change({ ...props.config, unit: value })} />
        </Field>
        <Field label={t().brakeSwitch} hint={t().brakeSwitchHint}>
          <Check
            switch
            label={budget().enabled ? t().on : t().off}
            checked={budget().enabled}
            disabled={props.disabled}
            onChange={(enabled) => update({ enabled })}
          />
        </Field>
        <Show when={budget().enabled}>
          <Field label={t().budgetWarning} hint={t().optional}>
            <Input
              type="number"
              min={0}
              value={numberText(budget().warnAt)}
              disabled={props.disabled}
              end={<Text type="meta">{unit()}</Text>}
              onInput={(value) => update({ warnAt: value.trim() === "" ? null : Number(value) })}
            />
          </Field>
          <Field label={t().budgetStop} hint={t().brakeStopHint}>
            <Input
              type="number"
              min={0}
              value={numberText(budget().stopAt)}
              disabled={props.disabled}
              end={<Text type="meta">{unit()}</Text>}
              onInput={(value) => {
                if (value.trim() !== "") update({ stopAt: Number(value) });
              }}
            />
          </Field>
        </Show>
      </Section>
      <Text type="meta" muted>
        {t().brakeRunningNote}
      </Text>
    </>
  );
}
