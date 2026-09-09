import { Button, ButtonLink, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { type AccountCategory, AppLoginStartResultSchema, AppLoginStatusSchema } from "@valentinkolb/cloud/contracts";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { z } from "zod";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "../app-approval/client";
import ApprovalFeedback from "../app-approval/Feedback";
import { appApprovalMessages } from "../app-approval/messages";
import { afterSignInHref } from "./login-redirect";

export default function AppLoginForm(props: {
  category: AccountCategory;
  redirectTo?: string;
  fallback?: { href: string; label: string };
  setupHint?: string;
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [identifier, setIdentifier] = createSignal("");
  const [pending, setPending] = createSignal<z.infer<typeof AppLoginStartResultSchema>>();
  const [busy, setBusy] = createSignal(false);
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
            await checked(await approvalApi.login.complete.$post({ json }, approvalRequestOptions()));
            if (!disposed) window.location.assign(afterSignInHref(props.redirectTo));
          } catch {
            if (!disposed) setMessage("uncertain");
          } finally {
            if (!disposed) {
              setBusy(false);
              setPending(undefined);
            }
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
  return (
    <section class="flex flex-col gap-3">
      <ApprovalFeedback error={error()} />
      <Show when={message()}>
        {(key) => (
          <NoticeCard tone={key() === "retrying" ? "info" : "warning"}>
            <p role="status">{t()[key()]}</p>
          </NoticeCard>
        )}
      </Show>
      <Show
        when={pending()}
        fallback={
          <form
            class="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <TextInput
              class="auth-login-identifier"
              label={t().identifier}
              placeholder={t().identifierPlaceholder}
              value={identifier}
              onValueChange={setIdentifier}
              autocomplete="username"
              icon=""
              activeIcon=""
              required
              maxLength={254}
            />
            <Button type="submit" class="auth-login-action w-full justify-center" loading={busy()} disabled={!identifier().trim()}>
              {t().signIn}
            </Button>
          </form>
        }
      >
        {(request) => (
          <div class="flex flex-col gap-5">
            <div class="text-center" role="status" aria-live="polite">
              <p class="text-sm text-dimmed">{t().waiting}</p>
              <span class="sr-only">{t().comparison}</span>
              <p class="py-6 text-4xl sm:text-5xl font-mono tabular-nums tracking-widest">{request().comparison}</p>
            </div>
            <Button
              variant="secondary"
              disabled={busy()}
              onClick={() => {
                clear();
                setMessage(undefined);
              }}
            >
              {t().cancelWait}
            </Button>
          </div>
        )}
      </Show>
      <Show when={!busy() ? props.fallback : undefined}>
        {(fallback) => (
          <ButtonLink href={fallback().href} variant="ghost" class="auth-login-alternative w-full justify-center" onClick={clear}>
            {fallback().label}
          </ButtonLink>
        )}
      </Show>
      <Show when={!pending() && props.setupHint}>
        <p class="text-xs text-center text-dimmed">{props.setupHint}</p>
      </Show>
    </section>
  );
}
