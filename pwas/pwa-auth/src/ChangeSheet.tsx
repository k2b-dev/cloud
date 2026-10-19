import { BottomSheet, Button, PanelDialog, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { Authenticator, DeviceChange } from "./authenticator";
import { authMessages } from "./i18n";
import type { Binding } from "./storage";

type Ending = "approve" | "deny" | "stale" | "uncertain" | "expired";

/** A request to pair or remove a device of this account. Everything it shows arrived with the inbox, so the
 * sheet has its final height from the first frame; an ending replaces the request in the same grid cell. */
export function ChangeSheet(props: {
  auth: Authenticator;
  binding: Binding;
  change: DeviceChange;
  dismiss: () => void | Promise<void>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const pair = () => props.change.kind === "pair";
  const self = () => !pair() && props.change.device.id === props.binding.deviceId;
  const name = () => props.change.device.name || t().changeUnnamed;
  // Inert for a moment after opening, so a tap meant for the page behind never approves a device.
  const [armed, setArmed] = createSignal(false);
  const [busy, setBusy] = createSignal<"approve" | "deny">();
  const [ending, setEnding] = createSignal<Ending>();
  let stopped = false;
  const timer = setTimeout(() => setArmed(true), 500);
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  const expired = () => props.auth.now() >= Date.parse(props.change.expiresAt);
  const off = () => !!busy() || !!ending() || expired() || !props.auth.online();
  createEffect(() => {
    if (!ending() && !busy() && expired()) setEnding("expired");
  });
  // Decided elsewhere, for example on another paired device: the request leaves without an ending of its own. Only a
  // complete read inbox says so; trimmed changes stay pending. Offline or after a failed read, the sheet stays with its offline state.
  createEffect(() => {
    const state = props.auth.states()[props.binding.id];
    const listed = state?.changes.some((change) => change.changeId === props.change.changeId);
    if (state && !state.error && state.moreChanges === 0 && !busy() && !ending() && !expired() && !listed) props.close();
  });
  let done: HTMLButtonElement | undefined;
  createEffect(() => {
    if (ending()) queueMicrotask(() => done?.focus());
  });
  const decide = async (decision: "approve" | "deny") => {
    if (!armed() || off()) return;
    setBusy(decision);
    let outcome: Ending = decision;
    try {
      await props.auth.decideChange(props.binding, props.change, decision);
    } catch (error) {
      outcome = error instanceof Error && error.message === "stale" ? "stale" : "uncertain";
    }
    if (stopped) return;
    setEnding(outcome);
    setBusy(undefined);
  };
  const endings = {
    approve: {
      icon: "ti ti-check",
      title: () => (pair() ? t().changePairedTitle : t().changeRemovedTitle),
      text: () =>
        pair() ? t().changePairedText({ name: name() }) : self() ? t().changeRemovedSelf : t().changeRemovedText({ name: name() }),
    },
    deny: { icon: "ti ti-x", title: () => t().actionDenied, text: () => t().changeDeniedText },
    stale: { icon: "ti ti-info-circle", title: () => t().actionNotApplied, text: () => t().actionStale },
    uncertain: { icon: "ti ti-alert-triangle", title: () => t().actionUncertainTitle, text: () => t().changeUncertain },
    expired: { icon: "ti ti-clock", title: () => t().actionExpiredTitle, text: () => t().changeExpired },
  } satisfies Record<Ending, { icon: string; title: () => string; text: () => string }>;
  const Result = (result: { kind: Ending }) => (
    <>
      <span class="auth-action-result__icon">
        <i class={endings[result.kind].icon} aria-hidden="true" />
      </span>
      <h3>{endings[result.kind].title()}</h3>
      <p>{endings[result.kind].text()}</p>
    </>
  );
  const effect = () => {
    if (pair()) return t().changePairEffect;
    if (self()) return props.change.endSessions ? t().changeRevokeSelfEndEffect : t().changeRevokeSelfEffect;
    return props.change.endSessions ? t().changeRevokeEndEffect : t().changeRevokeEffect;
  };
  return (
    <BottomSheet onDismiss={props.dismiss}>
      <PanelDialog.Header title={props.binding.label} />
      <PanelDialog.Body>
        <div class="auth-decision" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision__request" aria-hidden={ending() ? true : undefined}>
            <p>{pair() ? t().changePairLead : t().changeRevokeLead}</p>
            <div class="auth-change-device">
              <span class="auth-change-device__icon" data-kind={props.change.kind} aria-hidden="true">
                <i class={pair() ? "ti ti-device-mobile-plus" : "ti ti-device-mobile-off"} />
              </span>
              <span class="auth-change-device__copy">
                <strong>{name()}</strong>
                <span>{pair() ? t().changeNewDevice : self() ? t().thisDevice : t().changePairedDevice}</span>
              </span>
            </div>
            {/* The consequence and the offline reason share one place, so going offline moves nothing. */}
            <div class="auth-change-note" data-offline={props.auth.online() ? undefined : ""}>
              <p aria-hidden={props.auth.online() ? undefined : true}>{effect()}</p>
              <p class="auth-change-note__sizer" aria-hidden="true">
                {t().changeOffline}
              </p>
              <p role="status">{props.auth.online() ? "" : t().changeOffline}</p>
            </div>
          </div>
          <div class="auth-action-result auth-decision__sizer" aria-hidden="true">
            <Result kind="uncertain" />
          </div>
          <div class="auth-action-result" data-outcome={ending()} role={ending() === "uncertain" ? "alert" : "status"}>
            <Show when={ending()}>{(kind) => <Result kind={kind()} />}</Show>
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="auth-decision-actions" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision-actions__choices" inert={ending() || !armed() ? true : undefined}>
            {/* Cloud refuses a device's denial of its own removal, so this device can only leave the request open. */}
            <Show
              when={!self()}
              fallback={
                <Button size="lg" variant="secondary" disabled={!!busy() || !!ending()} onClick={() => void props.dismiss()}>
                  {t().changeNotNow}
                </Button>
              }
            >
              <Button size="lg" variant="secondary" disabled={off()} loading={busy() === "deny"} onClick={() => void decide("deny")}>
                {t().deny}
              </Button>
            </Show>
            <Button size="lg" disabled={off()} loading={busy() === "approve"} onClick={() => void decide("approve")}>
              {pair() ? t().changeApprovePair : t().changeApproveRevoke}
            </Button>
          </div>
          <div class="auth-decision-actions__done" inert={ending() ? undefined : true}>
            <Button size="lg" ref={done} onClick={() => props.close()}>
              {t().done}
            </Button>
          </div>
        </div>
      </PanelDialog.Footer>
    </BottomSheet>
  );
}
