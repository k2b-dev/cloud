import { dates } from "@k2b/stdlib";
import { BottomSheet, Button, PanelDialog, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ActionView, Authenticator } from "./authenticator";
import { authMessages } from "./i18n";
import type { Binding } from "./storage";

type Outcome = "approve" | "deny" | "stale" | "uncertain" | "expired";

/** Opens with an already loaded view, so the first frame has its final height. */
export function ActionSheet(props: {
  auth: Authenticator;
  binding: Binding;
  view: ActionView;
  dismiss: () => void | Promise<void>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [armed, setArmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<Outcome>();
  const [decidedAt, setDecidedAt] = createSignal<string>();
  const [height, setHeight] = createSignal<number>();
  let body: HTMLDivElement | undefined;
  // The visible part only: a long request scrolls, and its result must not.
  const keepHeight = () => {
    if (body) setHeight(Math.min(body.offsetHeight, body.closest(".k2b-panel-dialog__body")?.clientHeight ?? body.offsetHeight));
  };
  // Every ending, including expiry and an unconfirmed result, replaces the request at the same height.
  const finish = (outcome: Outcome) => {
    keepHeight();
    setResult(outcome);
    setDecidedAt(new Date().toISOString());
  };
  let stopped = false;
  const host = () => new URL(props.binding.issuer).host;
  const expired = () => props.auth.now() >= Date.parse(props.view.expiresAt);
  const disabled = () => busy() || expired() || !props.auth.online();
  const timer = setTimeout(() => setArmed(true), 500);
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  createEffect(() => {
    if (!result() && !busy() && expired()) finish("expired");
  });
  let done: HTMLButtonElement | undefined;
  // The result replaces the pressed button with Done; focus moves there instead of falling to the page.
  createEffect(() => {
    if (result()) queueMicrotask(() => done?.focus());
  });
  const decide = async (decision: "approve" | "deny") => {
    if (!armed() || disabled() || result()) return;
    setBusy(true);
    let outcome: Outcome = decision;
    try {
      await props.auth.act(props.binding, props.view, decision);
    } catch (error) {
      outcome = error instanceof Error && error.message === "stale" ? "stale" : "uncertain";
    }
    if (stopped) return;
    finish(outcome);
    setBusy(false);
  };
  const detailValue = (detail: ActionView["details"][number]) => {
    if (detail.format === "date")
      return /^\d{4}-\d{2}-\d{2}$/.test(detail.value)
        ? dates.formatDate(`${detail.value}T12:00:00.000Z`, { locale: locale(), timeZone: "UTC" })
        : dates.formatDate(detail.value, { locale: locale() });
    if (detail.format === "date-time") return dates.formatDateTime(detail.value, { locale: locale() });
    return detail.value;
  };
  const outcomes = {
    approve: {
      icon: "ti ti-check",
      title: () => t().actionApproved,
      text: () => t().actionContinues({ app: props.view.requester.app.name }),
    },
    deny: { icon: "ti ti-x", title: () => t().actionDenied, text: () => t().actionNothing },
    stale: { icon: "ti ti-info-circle", title: () => t().actionNotApplied, text: () => t().actionStale },
    uncertain: { icon: "ti ti-alert-triangle", title: () => t().actionUncertainTitle, text: () => t().actionUncertain },
    expired: { icon: "ti ti-clock", title: () => t().actionExpiredTitle, text: () => t().actionExpired },
  } satisfies Record<Outcome, { icon: string; title: () => string; text: () => string }>;
  return (
    <BottomSheet onDismiss={props.dismiss}>
      <PanelDialog.Header title={props.binding.label} />
      <PanelDialog.Body>
        {/* The result keeps the height the request had, so the sheet does not jump when it appears. */}
        <div class="auth-action-body" ref={body} style={height() ? { "min-height": `${height()}px` } : undefined}>
          <Show
            when={result()}
            fallback={
              <>
                {/* Cloud Login's own frame, from the Cloud's registry and address; the app's words follow below it. */}
                <p class="auth-action-frame">
                  <span>
                    <b>{props.view.app.name}</b> {t().actionOn} <b>{host()}</b> {t().actionWants}
                  </span>
                  <span>{t().actionRequestedBy({ app: props.view.requester.app.name })}</span>
                </p>
                <blockquote class="auth-action-quote">{props.view.sentence}</blockquote>
                <Show when={props.view.message}>{(message) => <p class="auth-action-message">{message()}</p>}</Show>
                <Show when={props.view.requester.title || props.view.details.length > 0}>
                  <dl class="auth-action-details">
                    <Show when={props.view.requester.title}>
                      {(title) => (
                        <>
                          <dt>{t().actionChat}</dt>
                          <dd>{title()}</dd>
                        </>
                      )}
                    </Show>
                    <For each={props.view.details}>
                      {(detail) => (
                        <>
                          <dt>{detail.label}</dt>
                          <dd>{detailValue(detail)}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
                <Show when={props.view.truncated}>
                  <p class="auth-action-note">
                    <i class="ti ti-info-circle" aria-hidden="true" />
                    <span>{t().actionTruncated}</span>
                  </p>
                </Show>
                <p class="auth-action-meta">
                  <span>
                    <Show when={props.view.assurance === "confirm"}>
                      <i class="ti ti-lock" aria-hidden="true" /> {t().actionConfirm}
                    </Show>
                  </span>
                  <span>{t().actionExpires({ time: dates.formatTimeSpan(props.view.expiresAt, { locale: locale() }) })}</span>
                </p>
              </>
            }
          >
            {(outcome) => (
              <div class="auth-action-result" data-outcome={outcome()} role={outcome() === "uncertain" ? "alert" : "status"}>
                <span class="auth-action-result__icon">
                  <i class={outcomes[outcome()].icon} aria-hidden="true" />
                </span>
                <h3>{outcomes[outcome()].title()}</h3>
                <p>{outcomes[outcome()].text()}</p>
                <p class="auth-action-result__meta">
                  {host()} · {dates.formatDateTime(decidedAt() ?? new Date().toISOString(), { locale: locale() })}
                </p>
              </div>
            )}
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show
          when={!result()}
          fallback={
            <div class="auth-action-actions auth-action-actions--one">
              <Button size="lg" ref={done} onClick={props.close}>
                {t().done}
              </Button>
            </div>
          }
        >
          {/* Inert, not disabled, while arming: the buttons look the same from the first frame, so nothing flickers. */}
          <div class="auth-action-actions" inert={armed() ? undefined : true}>
            <Button size="lg" variant="secondary" disabled={disabled()} onClick={() => void decide("deny")}>
              {t().deny}
            </Button>
            <Button size="lg" disabled={disabled()} loading={busy()} onClick={() => void decide("approve")}>
              {t().actionApprove}
            </Button>
          </div>
        </Show>
      </PanelDialog.Footer>
    </BottomSheet>
  );
}
