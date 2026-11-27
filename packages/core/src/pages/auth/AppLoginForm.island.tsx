import { type AccountCategory, AppLoginStartResultSchema, AppLoginStatusSchema } from "@k2b/cloud/contracts";
import { cookies } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import { Band, Button, CodeFigure, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import type { z } from "zod";
import { FREEIPA_APP_SIGN_IN_COOKIE, LOGIN_EMAIL_SIGN_IN_COOKIE } from "../app-approval/availability";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "../app-approval/client";
import ApprovalFeedbackV2 from "../app-approval/FeedbackV2";
import { appApprovalMessages } from "../app-approval/messages";
import { FormActions } from "./FormActions";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";

export default function AppLoginForm(props: {
  category: AccountCategory;
  redirectTo?: string;
  fallback?: { href: string; label: string };
  /** A shared workstation: the page remembers neither the account nor the method. */
  forget?: boolean;
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [identifier, setIdentifier] = createSignal("");
  const [pending, setPending] = createSignal<z.infer<typeof AppLoginStartResultSchema>>();
  const [busy, setBusy] = createSignal(false);
  // Terminal: the session exists and navigation has started. The form must not return.
  const [signedIn, setSignedIn] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [message, setMessage] = createSignal<"expired" | "denied" | "uncertain" | "retrying">();
  const storageKey = `cloud.app-login:${props.category}:${props.redirectTo ?? "/"}`;
  let stop = () => {};
  let disposed = false;
  // Only the initiating tab retains this bearer secret, never URLs or the app.
  const forget = () => {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const clear = () => {
    stop();
    forget();
    setPending(undefined);
  };
  const wait = (request: z.infer<typeof AppLoginStartResultSchema>) => {
    stop();
    setPending(request);
    stop = pollApproval(
      async (signal) => {
        if (Date.parse(request.expiresAt) <= Date.now()) {
          clear();
          setMessage("expired");
          return false;
        }
        const json = { requestId: request.requestId, browserSecret: request.browserSecret };
        const status = await parsed(await approvalApi.login.status.$post({ json }, approvalRequestOptions(signal)), AppLoginStatusSchema);
        if (signal.aborted) return false;
        setMessage(undefined);
        if (status.state === "pending") return true;
        // Remove before the one-use completion. A lost response must never be retried after reload.
        forget();
        if (status.state === "approved") {
          setBusy(true);
          try {
            await checked(
              await approvalApi.login.complete.$post(
                { json },
                { ...approvalRequestOptions(), ...confirmationRequestOptions(props.redirectTo) },
              ),
            );
          } catch (cause) {
            if (!disposed) {
              setBusy(false);
              setPending(undefined);
              if (cause instanceof ApprovalError && cause.code === "ACCOUNT_MISMATCH") setError(cause);
              else setMessage("uncertain");
            }
            return false;
          }
          if (!disposed) {
            setSignedIn(true);
            // Reopen this account type next time; a FreeIPA browser also keeps the app ahead of the password.
            if (!props.forget) {
              cookies.writeCookie("login_method", props.category === "freeipa" ? "ipa" : props.category);
              if (props.category === "freeipa") cookies.writeCookie(FREEIPA_APP_SIGN_IN_COOKIE, "1");
            }
            if (props.category === "login") cookies.deleteCookie(LOGIN_EMAIL_SIGN_IN_COOKIE);
            window.location.assign(afterSignInHref(props.redirectTo));
          }
        } else {
          setPending(undefined);
          setMessage(status.state === "denied" ? "denied" : status.state === "expired" ? "expired" : "uncertain");
        }
        return false;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
          clear();
          setError(cause);
          return false;
        }
        setMessage("retrying");
        return true;
      },
      request.pollAfterSeconds,
      // The status endpoint holds a pending request until the decision lands.
      { immediate: true },
    );
  };
  onMount(() => {
    try {
      const saved = AppLoginStartResultSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) wait(saved.data);
      else forget();
    } catch {
      forget();
    }
  });
  onCleanup(() => {
    disposed = true;
    stop();
  });
  const start = async () => {
    if (busy() || pending() || !identifier().trim()) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const request = await parsed(
        await approvalApi.login.start.$post(
          { json: { identifier: identifier().trim(), category: props.category } },
          approvalRequestOptions(),
        ),
        AppLoginStartResultSchema,
      );
      if (disposed) return;
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(request));
      } catch {}
      wait(request);
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  // The password or email form for the same account, beside the form's own action; not while a request starts.
  // a link like every other way out of a visitor form; following it drops the pending request
  const fallbackButton = () => (!busy() && props.fallback ? <Text href={props.fallback.href}>{props.fallback.label}</Text> : undefined);
  onMount(() => {
    const leave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (link && props.fallback && link.getAttribute("href") === props.fallback.href) clear();
    };
    document.addEventListener("click", leave, true);
    onCleanup(() => document.removeEventListener("click", leave, true));
  });
  // the form stands apart and hidden; its fields and buttons name it, so no form box stands in the column
  const formId = createUniqueId();
  return (
    <>
      <ApprovalFeedbackV2 error={error()} />
      <Show when={message()}>
        {(key) => (
          <Notice tone="warn">
            <span role="status">{t()[key()]}</span>
          </Notice>
        )}
      </Show>
      <Show
        when={!signedIn()}
        fallback={
          <Notice tone="note" icon="circle-check">
            <span role="status">{t().signedIn}</span>
          </Notice>
        }
      >
        <Show
          when={pending()}
          fallback={
            <>
              <form
                id={formId}
                hidden
                onSubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              />
              <Band>
                <Field label={t().identifier} required>
                  <Input
                    form={formId}
                    icon="user"
                    value={identifier()}
                    onInput={setIdentifier}
                    placeholder={t().identifierPlaceholder}
                    autocomplete={props.forget ? "off" : "username"}
                    autocapitalize="off"
                    spellcheck={false}
                    maxLength={254}
                    autofocus
                  />
                </Field>
                {fallbackButton()}
              </Band>
              <FormActions
                end={
                  <Button variant="primary" type="submit" form={formId} busy={busy()} disabled={!identifier().trim()}>
                    {t().signIn}
                  </Button>
                }
              />
            </>
          }
        >
          {(request) => (
            <>
              <Band>
                {/* the same code as on the phone, grouped by three like Cloud Login shows it; read out when it comes */}
                <div role="status" aria-live="polite">
                  <Text muted>{t().waiting}</Text>
                  <CodeFigure value={request().comparison} label={t().comparison} />
                </div>
                {fallbackButton()}
              </Band>
              <FormActions
                end={
                  <Button
                    disabled={busy()}
                    onClick={() => {
                      clear();
                      setMessage(undefined);
                    }}
                  >
                    {t().cancelWait}
                  </Button>
                }
              />
            </>
          )}
        </Show>
      </Show>
    </>
  );
}
