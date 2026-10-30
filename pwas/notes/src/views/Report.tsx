import { Button, Checkbox, prompts } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { api, type ReportReason } from "../lib/api";
import { t } from "../state";
import { Icon } from "../ui/common";

const REASONS: { value: ReportReason; label: () => string }[] = [
  { value: "abuse", label: () => t().reasonAbuse },
  { value: "illegal", label: () => t().reasonIllegal },
  { value: "copyright", label: () => t().reasonCopyright },
  { value: "privacy", label: () => t().reasonPrivacy },
  { value: "fraud", label: () => t().reasonFraud },
];

/** Accepts a pasted share link or a bare link id. */
const linkIdFrom = (value: string) => value.trim().match(/(?:\/p\/)?([0-9A-Za-z]{16,32})\/?$/)?.[1];

function ReportBody(props: { linkId?: string; close: () => void }) {
  const [reason, setReason] = createSignal<ReportReason>("abuse");
  const [text, setText] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [link, setLink] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [submitted, setSubmitted] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [number, setNumber] = createSignal<string | null>(null);

  const linkId = () => props.linkId ?? linkIdFrom(link());
  const errors = () => ({
    link: !linkId() ? t().reportLinkRequired : undefined,
    // The server takes a reason of at least 10 characters and a valid address, so both are checked here first.
    text: text().trim().length < 10 ? t().reportTextRequired : undefined,
    email: email().trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email().trim()) ? t().reportEmailInvalid : undefined,
    confirmed: !confirmed() ? t().reportConfirmRequired : undefined,
  });

  const send = async () => {
    setSubmitted(true);
    const current = errors();
    const id = linkId();
    if (current.link || current.text || current.email || current.confirmed || !id) return;
    setSending(true);
    setFailed(false);
    try {
      const result = await api.report({
        linkId: id,
        reason: reason(),
        text: text().trim(),
        email: email().trim() || undefined,
        confirmed: true,
      });
      setNumber(result.number);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="n-dialog">
      <Show
        when={number()}
        fallback={
          <>
            <h2>{t().reportTitle}</h2>
            <p class="n-lead">{t().reportLead}</p>
            <Show when={!props.linkId}>
              <div class="n-field">
                <label class="n-l" for="n-report-link">
                  {t().linkRead} / {t().linkEdit}
                </label>
                <input
                  id="n-report-link"
                  type="text"
                  value={link()}
                  onInput={(event) => setLink(event.currentTarget.value)}
                  placeholder="…/p/…"
                />
                <span class="n-error-text">{submitted() ? (errors().link ?? "") : ""}</span>
              </div>
            </Show>
            <fieldset class="n-field" style={{ border: 0, padding: 0, margin: "1rem 0 0" }}>
              <legend class="n-l" style={{ "font-weight": 500, "font-size": ".875rem", padding: 0 }}>
                {t().reportReason}
              </legend>
              <div class="n-radios" style={{ "margin-top": ".35rem" }}>
                <For each={REASONS}>
                  {(entry) => (
                    <label>
                      <input
                        type="radio"
                        name="n-report-reason"
                        checked={reason() === entry.value}
                        onChange={() => setReason(entry.value)}
                      />
                      {entry.label()}
                    </label>
                  )}
                </For>
              </div>
            </fieldset>
            <div class="n-field">
              <label class="n-l" for="n-report-text">
                {t().reportText}
              </label>
              <textarea
                id="n-report-text"
                maxLength={4000}
                placeholder={t().reportTextPlaceholder}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                aria-invalid={submitted() && Boolean(errors().text)}
                aria-describedby="n-report-text-error"
              />
              <span class="n-error-text" id="n-report-text-error">
                {submitted() ? (errors().text ?? "") : ""}
              </span>
            </div>
            <div class="n-field">
              <label class="n-l" for="n-report-email">
                {t().reportEmail}
              </label>
              <input
                id="n-report-email"
                type="email"
                placeholder="name@example.org"
                value={email()}
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
              <span class="n-help">{t().reportEmailHelp}</span>
              <span class="n-error-text">{submitted() ? (errors().email ?? "") : ""}</span>
            </div>
            <Checkbox
              class="n-field"
              label={t().reportConfirm}
              value={confirmed}
              onValueChange={setConfirmed}
              error={() => (submitted() ? errors().confirmed : undefined)}
            />
            <p class="n-error-text" role="alert">
              {failed() ? t().reportFailed : ""}
            </p>
            <div class="n-dialog-acts">
              <Button variant="ghost" onClick={() => props.close()}>
                {t().cancel}
              </Button>
              <Button variant="primary" loading={sending()} loadingLabel={t().reportSending} onClick={() => void send()}>
                <Icon name="ti-flag" />
                {failed() ? t().retry : t().reportSend}
              </Button>
            </div>
          </>
        }
      >
        {(value) => (
          <>
            <div class="n-done" role="status">
              <div class="n-ring">
                <Icon name="ti-check" />
              </div>
              <h2>{t().reportDone}</h2>
              <p>{t().reportDoneBody({ number: value() })}</p>
            </div>
            <div class="n-dialog-acts">
              <Button variant="primary" onClick={() => props.close()}>
                {t().close}
              </Button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

export function openReport(linkId?: string) {
  void prompts.dialog<void>((close) => <ReportBody linkId={linkId} close={() => close()} />, { header: false, history: true });
}
