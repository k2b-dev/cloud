import { BottomSheet, Button, bottomSheetAdaptiveOptions, dialogCore, FilterToggle, TextInput } from "@k2b/ui";
import { createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { CODE_PAGE_REPORT_REASONS, CODE_PAGE_REPORT_TEXT_MAX, type CodePageReportReason } from "./page-provenance-contracts";
import { provenanceMessages } from "./provenance-messages";
import { type CodePageRef, readCodePageProvenance, sendCodePageReport } from "./provenance-request";

type Failure =
  | "failedLost"
  | "failedUnknown"
  | "failedChanged"
  | "failedRateLimit"
  | "failedMembersOnly"
  | "failedSignedOut"
  | "failedNotFound"
  | "failedInput";
type Phase = { kind: "edit" } | { kind: "sending" } | { kind: "failed"; failure: Failure } | { kind: "done" };

/** A refusal in one sentence that says what to do; the person's text always stays. */
const failure = (code: string | undefined): Failure => {
  switch (code) {
    case "code_page_changed":
      return "failedChanged";
    case "code_report_rate_limit":
    case "code_request_rate_limit":
      return "failedRateLimit";
    case "code_report_members_only":
    case "code_members_only":
      return "failedMembersOnly";
    case "code_sign_in_required":
      return "failedSignedOut";
    case "code_route_not_found":
      return "failedNotFound";
    case "BAD_INPUT":
      return "failedInput";
    default:
      return "failedLost";
  }
};

/**
 * "Seite melden": an optional reason, one required sentence, and a status line that is always there, so the dialog
 * keeps its size while it is empty, filled, sending, or failed. A sheet from below on phones. Each dialog sends with
 * one idempotency key; when an answer is lost, it asks the card's route whether the report arrived before it offers
 * to send again.
 */
function ReportDialog(props: {
  page: CodePageRef;
  locale: string;
  close: (reportedAt: string | undefined) => void;
  requestDismiss: () => void;
  guard: (handler: () => void) => void;
  onReported: (reportedAt: string) => void;
}) {
  const t = () => provenanceMessages.resolve([props.locale]).t;
  const key = crypto.randomUUID();
  const ids = { title: createUniqueId(), reason: createUniqueId(), text: createUniqueId(), status: createUniqueId() };
  const [reason, setReason] = createSignal<CodePageReportReason | null>(null);
  const [text, setText] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>({ kind: "edit" });
  const [reportedAt, setReportedAt] = createSignal<string>();
  const sending = () => phase().kind === "sending";
  const failedWith = () => {
    const current = phase();
    return current.kind === "failed" ? current.failure : undefined;
  };
  const ready = () => text().trim().length > 0 && !sending();
  let done: HTMLButtonElement | undefined;
  // Sending cannot be cancelled: Escape and the backdrop wait for the answer.
  props.guard(() => {
    if (!sending()) props.close(reportedAt());
  });

  const arrived = (at: string) => {
    setReportedAt(at);
    props.onReported(at);
    setPhase({ kind: "done" });
    queueMicrotask(() => done?.focus());
  };

  const send = async () => {
    if (!ready()) return;
    setPhase({ kind: "sending" });
    const answer = await sendCodePageReport({ ...props.page, reason: reason(), text: text().trim(), key });
    if (answer.kind === "ok") return arrived(answer.data.reportedAt);
    if (answer.kind === "failed") return setPhase({ kind: "failed", failure: failure(answer.code) });
    // No answer: first ask whether the report arrived. Only then is sending again offered, with the same key.
    const check = await readCodePageProvenance(props.page);
    const at = check.kind === "ok" ? check.data.report?.reportedAt : undefined;
    if (at) return arrived(at);
    setPhase({ kind: "failed", failure: check.kind === "ok" ? "failedLost" : "failedUnknown" });
  };

  return (
    <BottomSheet onDismiss={props.requestDismiss} handle={false}>
      <div class="code-page-report" data-phase={phase().kind} aria-busy={sending() || undefined}>
        <Show
          when={phase().kind !== "done"}
          fallback={
            <>
              <h2 class="code-page-report__title" id={ids.title}>
                {t().doneTitle}
              </h2>
              <p class="code-page-report__arrived" role="status">
                <i class="ti ti-circle-check" aria-hidden="true" />
                <span>{t().doneLead}</span>
              </p>
              <dl class="code-page-report__who">
                <dt>{t().seesNow}</dt>
                <dd>{t().seesNowValue}</dd>
                <dt>{t().included}</dt>
                <dd>{t().includedValue}</dd>
                <dt>{t().getsNothing}</dt>
                <dd>{t().getsNothingValue}</dd>
              </dl>
              <p class="code-page-report__lead">{t().doneNext}</p>
              <div class="code-page-report__actions">
                <Button ref={done} onClick={() => props.close(reportedAt())}>
                  {t().done}
                </Button>
              </div>
            </>
          }
        >
          <h2 class="code-page-report__title" id={ids.title}>
            {t().dialogTitle}
          </h2>
          <p class="code-page-report__lead">{t().dialogLead}</p>
          <div class="code-page-report__group" role="group" aria-labelledby={ids.reason}>
            <span class="code-page-report__label" id={ids.reason}>
              {t().reason} <span>{t().optional}</span>
            </span>
            <div class="code-page-report__reasons">
              <For each={CODE_PAGE_REPORT_REASONS}>
                {(value) => (
                  <FilterToggle
                    label={t()[`reason_${value}`]}
                    active={reason() === value}
                    disabled={sending()}
                    // One reason at most; choosing it again takes it back.
                    onClick={() => setReason(reason() === value ? null : value)}
                  />
                )}
              </For>
            </div>
          </div>
          <div class="code-page-report__group">
            <span class="code-page-report__label" id={ids.text}>
              {t().whatsWrong} <span>{t().oneSentence}</span>
            </span>
            <TextInput
              multiline
              lines={2}
              required
              aria-labelledby={ids.text}
              aria-describedby={ids.status}
              placeholder={t().placeholder}
              maxLength={CODE_PAGE_REPORT_TEXT_MAX}
              value={text}
              disabled={sending()}
              onValueChange={(next) => {
                setText(next);
                // Typing after a failure returns to the plain state; the reason for the failure was read.
                if (phase().kind === "failed" && !next.trim()) setPhase({ kind: "edit" });
              }}
              onSubmit={() => void send()}
            />
          </div>
          <p class="code-page-report__status" id={ids.status} role="status" data-tone={failedWith() ? "danger" : undefined}>
            <Switch>
              <Match when={failedWith()}>
                {(failed) => (
                  <>
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    {/* A phone shows the short sentence, so the line stays one line of 20px in every state. */}
                    <span class="code-page-report__long">{t()[failed()]}</span>
                    <span class="code-page-report__short">{t()[`${failed()}Short`]}</span>
                  </>
                )}
              </Match>
              <Match when={sending()}>
                <i class="ti ti-loader-2 code-page-report__spinner" aria-hidden="true" />
                <span>{t().statusSending}</span>
              </Match>
              <Match when={text().trim()}>
                <i class="ti ti-users" aria-hidden="true" />
                <span>{t().statusReady}</span>
              </Match>
              <Match when={true}>
                <i class="ti ti-pencil" aria-hidden="true" />
                <span>{t().statusEmpty}</span>
              </Match>
            </Switch>
          </p>
          <div class="code-page-report__actions">
            <Button variant="secondary" disabled={sending()} onClick={() => props.requestDismiss()}>
              {t().cancel}
            </Button>
            <Button disabled={!ready()} aria-describedby={ids.status} onClick={() => void send()}>
              <Show when={failedWith()} fallback={t().send}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().retry}
              </Show>
            </Button>
          </div>
        </Show>
      </div>
    </BottomSheet>
  );
}

/** Opens the report dialog; resolves with the time of the open report when one arrived. */
export function openPageReport(options: { page: CodePageRef; locale: string; onReported: (reportedAt: string) => void }) {
  const t = provenanceMessages.resolve([options.locale]).t;
  return dialogCore.open<string | undefined>(
    (close, context) => (
      <ReportDialog
        page={options.page}
        locale={options.locale}
        close={close}
        requestDismiss={() => void context.requestDismiss()}
        guard={context.setDismissHandler}
        onReported={options.onReported}
      />
    ),
    {
      ...bottomSheetAdaptiveOptions,
      panelClassName: `${bottomSheetAdaptiveOptions.panelClassName} code-page-report-frame`,
      ariaLabel: t.dialogTitle,
    },
  );
}
