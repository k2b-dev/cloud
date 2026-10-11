import { dates } from "@k2b/stdlib";
import { BottomSheet, Button, PanelDialog, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ActionView, Authenticator } from "./authenticator";
import { authMessages } from "./i18n";
import type { Binding } from "./storage";

export function ActionSheet(props: {
  auth: Authenticator;
  binding: Binding;
  actionId: string;
  dismiss: () => void | Promise<void>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [view, setView] = createSignal<ActionView>();
  const [failed, setFailed] = createSignal(false);
  const [armed, setArmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [uncertain, setUncertain] = createSignal(false);
  const [result, setResult] = createSignal<"approve" | "deny" | "stale">();
  const [decidedAt, setDecidedAt] = createSignal<string>();
  const [height, setHeight] = createSignal<number>();
  let body: HTMLDivElement | undefined;
  // The visible part only: a long request scrolls, and its result must not.
  const keepHeight = () => {
    if (body) setHeight(Math.min(body.offsetHeight, body.closest(".k2b-panel-dialog__body")?.clientHeight ?? body.offsetHeight));
  };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const host = () => new URL(props.binding.issuer).host;
  const expired = () => props.auth.now() >= Date.parse(view()?.expiresAt ?? "");
  const disabled = () => !view() || busy() || uncertain() || expired() || !props.auth.online();
  onCleanup(() => {
    stopped = true;
    abort.abort();
    clearTimeout(timer);
  });
  onMount(() => {
    void props.auth.action(props.binding, props.actionId, abort.signal).then(
      (value) => {
        if (stopped) return;
        setView(value);
        timer = setTimeout(() => setArmed(true), 500);
      },
      () => {
        if (!stopped) setFailed(true);
      },
    );
  });
  const decide = async (decision: "approve" | "deny") => {
    const value = view();
    if (!value || !armed() || disabled() || result()) return;
    setBusy(true);
    try {
      await props.auth.act(props.binding, value, decision);
      if (!stopped) {
        keepHeight();
        setResult(decision);
      }
    } catch (error) {
      if (!stopped) {
        if (error instanceof Error && error.message === "stale") {
          keepHeight();
          setResult("stale");
        } else setUncertain(true);
      }
    } finally {
      if (!stopped) {
        setDecidedAt(new Date().toISOString());
        setBusy(false);
      }
    }
  };
  const detailValue = (detail: ActionView["details"][number]) => {
    if (detail.format === "date")
      return /^\d{4}-\d{2}-\d{2}$/.test(detail.value)
        ? dates.formatDate(`${detail.value}T12:00:00.000Z`, { locale: locale(), timeZone: "UTC" })
        : dates.formatDate(detail.value, { locale: locale() });
    if (detail.format === "date-time") return dates.formatDateTime(detail.value, { locale: locale() });
    return detail.value;
  };
  const outcomeIcon = (outcome: "approve" | "deny" | "stale") =>
    outcome === "approve" ? "ti ti-check" : outcome === "deny" ? "ti ti-x" : "ti ti-info-circle";
  return (
    <BottomSheet onDismiss={props.dismiss}>
      <PanelDialog.Header title={props.binding.label} />
      <PanelDialog.Body>
        {/* The result keeps the height the request had, so the sheet does not jump when it appears. */}
        <div class="auth-action-body" ref={body} style={height() ? { "min-height": `${height()}px` } : undefined}>
          <Show
            when={result()}
            fallback={
              <Show when={!failed()} fallback={<p role="alert">{t().actionLoadFailed}</p>}>
                <Show when={view()} fallback={<p role="status">{t().actionLoading}</p>}>
                  {(value) => (
                    <>
                      {/* Cloud Login's own frame, from the Cloud's registry and address; the app's words follow below it. */}
                      <p class="auth-action-frame">
                        <span>
                          <b>{value().app.name}</b> {t().actionOn} <b>{host()}</b> {t().actionWants}
                        </span>
                        <span>{t().actionRequestedBy({ app: value().requester.app.name })}</span>
                      </p>
                      <blockquote class="auth-action-quote">{value().sentence}</blockquote>
                      <Show when={value().message}>{(message) => <p class="auth-action-message">{message()}</p>}</Show>
                      <Show when={value().requester.title || value().details.length > 0}>
                        <dl class="auth-action-details">
                          <Show when={value().requester.title}>
                            {(title) => (
                              <>
                                <dt>{t().actionChat}</dt>
                                <dd>{title()}</dd>
                              </>
                            )}
                          </Show>
                          <For each={value().details}>
                            {(detail) => (
                              <>
                                <dt>{detail.label}</dt>
                                <dd>{detailValue(detail)}</dd>
                              </>
                            )}
                          </For>
                        </dl>
                      </Show>
                      <Show when={value().truncated}>
                        <p class="auth-action-note">
                          <i class="ti ti-info-circle" aria-hidden="true" />
                          <span>{t().actionTruncated}</span>
                        </p>
                      </Show>
                      <p class="auth-action-meta">
                        <span>
                          <Show when={value().assurance === "confirm"}>
                            <i class="ti ti-lock" aria-hidden="true" /> {t().actionConfirm}
                          </Show>
                        </span>
                        <span>{t().actionExpires({ time: dates.formatTimeSpan(value().expiresAt, { locale: locale() }) })}</span>
                      </p>
                      <Show when={expired()}>
                        <p role="status">{t().actionExpired}</p>
                      </Show>
                      <Show when={uncertain()}>
                        <p role="alert">{t().actionUncertain}</p>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
            }
          >
            {(outcome) => (
              <div class="auth-action-result" data-outcome={outcome()} role="status">
                <span class="auth-action-result__icon">
                  <i class={outcomeIcon(outcome())} aria-hidden="true" />
                </span>
                <h3>{outcome() === "approve" ? t().actionApproved : outcome() === "deny" ? t().actionDenied : t().actionNotApplied}</h3>
                <p>
                  {outcome() === "approve"
                    ? t().actionContinues({ app: view()?.app.name ?? "" })
                    : outcome() === "deny"
                      ? t().actionNothing
                      : t().actionStale}
                </p>
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
          when={!result() && !failed()}
          fallback={
            <div class="auth-action-actions auth-action-actions--one">
              <Button size="lg" variant={result() ? "primary" : "secondary"} onClick={props.close}>
                {result() ? t().done : t().close}
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
