import { qr } from "@k2b/stdlib/qr";
import { Button, ButtonLink, NoticeCard, toast, useLocale } from "@k2b/ui";
import { appApproval } from "@valentinkolb/cloud/browser/app-approval";
import { AppPairingInspectionSchema, AppPairingPayloadSchema } from "@valentinkolb/cloud/contracts";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "./client";
import ApprovalFeedback from "./Feedback";
import { appApprovalMessages } from "./messages";

const ResumeSchema = z.object({ pairingId: z.string().uuid(), expiresAt: z.string().datetime() });
export default function Pairing(props: { userId: string; actorId: string; name: string; appOrigin: string; returnTo: string }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [reference, setReference] = createSignal<z.infer<typeof ResumeSchema>>();
  const [link, setLink] = createSignal("");
  const [inspection, setInspection] = createSignal<z.infer<typeof AppPairingInspectionSchema>>();
  const [state, setState] = createSignal<"idle" | "waiting" | "done" | "expired" | "cancelled">("idle");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [retrying, setRetrying] = createSignal(false);
  const storageKey = `cloud.app-pairing:${props.actorId}:${props.userId}`;
  const returnTo = `/me/security/pair?${new URLSearchParams({ userId: props.userId })}`;
  let stop = () => {};
  let disposed = false;
  const forget = () => {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (next: "done" | "expired" | "cancelled") => {
    stop();
    forget();
    setLink("");
    setInspection(undefined);
    setReference(undefined);
    setRetrying(false);
    setError(undefined);
    setState(next);
  };
  const wait = (ref: z.infer<typeof ResumeSchema>) => {
    stop();
    setReference(ref);
    setState("waiting");
    stop = pollApproval(
      async (signal) => {
        if (Date.parse(ref.expiresAt) <= Date.now()) {
          finish("expired");
          return false;
        }
        const data = await parsed(
          await approvalApi.manage.pairings.status.$post({ json: { pairingId: ref.pairingId } }, approvalRequestOptions(signal)),
          AppPairingInspectionSchema,
        );
        if (signal.aborted) return false;
        if (data.userId !== props.userId) throw new ApprovalError("FORBIDDEN", 403);
        setRetrying(false);
        if (data.state === "confirmed") {
          finish("done");
          return false;
        }
        if (data.state === "cancelled") {
          finish("cancelled");
          return false;
        }
        setInspection(data);
        if (data.state === "claimed") setLink("");
        return true;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          if (cause.status === 404) finish("expired");
          else {
            setInspection(undefined);
            setLink("");
            setError(cause);
          }
          return false;
        }
        setRetrying(true);
        return true;
      },
    );
  };
  onMount(() => {
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
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
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await parsed(
        await approvalApi.manage.pairings.start.$post({ json: { userId: props.userId } }, approvalRequestOptions()),
        AppPairingPayloadSchema,
      );
      if (disposed) return;
      const ref = { pairingId: payload.pairingId, expiresAt: payload.expiresAt };
      setLink(appApproval.createPairingLink(props.appOrigin, payload));
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(ref));
      } catch {}
      wait(ref);
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const change = async (confirm: boolean) => {
    const ref = reference();
    const code = inspection()?.comparison;
    if (!ref || busy() || (confirm && !code)) return;
    if (Date.parse(ref.expiresAt) <= Date.now()) {
      finish("expired");
      return;
    }
    setBusy(true);
    setError(undefined);
    stop();
    try {
      await checked(
        confirm && code
          ? await approvalApi.manage.pairings.confirm.$post(
              { json: { pairingId: ref.pairingId, comparison: code } },
              approvalRequestOptions(),
            )
          : await approvalApi.manage.pairings.cancel.$post({ json: { pairingId: ref.pairingId } }, approvalRequestOptions()),
      );
      if (!disposed) {
        finish(confirm ? "done" : "cancelled");
        if (confirm) toast.success(t().paired);
      }
    } catch (cause) {
      if (!disposed) {
        setError(cause);
        setInspection(undefined);
        setLink("");
        wait(ref);
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link());
      toast.success(t().copied);
    } catch {
      setError(new Error());
    }
  };
  return (
    <section class="paper mx-auto flex w-full max-w-2xl flex-col gap-4 p-5">
      <h2 class="text-lg font-semibold">{t().pairingFor({ name: props.name })}</h2>
      <Show when={props.actorId !== props.userId}>
        <NoticeCard tone="warning">{t().assistedWarning}</NoticeCard>
      </Show>
      <ApprovalFeedback error={error()} returnTo={returnTo} />
      <Show when={retrying()}>
        <NoticeCard tone="info">{t().retrying}</NoticeCard>
      </Show>
      <Show when={state() === "idle" || state() === "expired" || state() === "cancelled"}>
        <p class="text-sm text-dimmed" role="status">
          {state() === "idle" ? t().instructionsStart : state() === "expired" ? t().expired : t().cancelled}
        </p>
        <Button class="self-start" onClick={start} loading={busy()}>
          {t().pair}
        </Button>
      </Show>
      <Show when={state() === "done"}>
        <NoticeCard tone="success">
          <p role="status">{t().done}</p>
        </NoticeCard>
      </Show>
      <Show when={state() === "waiting"}>
        <Show
          when={link()}
          fallback={
            <Show when={!inspection()?.comparison}>
              <p class="text-sm text-dimmed">{t().resumed}</p>
            </Show>
          }
        >
          <p class="text-sm text-dimmed">{t().instructions}</p>
          <img class="w-64 max-w-full self-center" alt={t().qr} src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`} />
          <div class="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={copy}>
              {t().copy}
            </Button>
            <ButtonLink href={link()} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" variant="secondary">
              {t().open}
            </ButtonLink>
          </div>
        </Show>
        <Show when={inspection()?.state === "claimed" && inspection()?.comparison}>
          <p class="text-sm">{t().confirmHint({ name: inspection()?.name ?? "" })}</p>
          <div role="status">
            <p class="text-sm">{t().comparison}</p>
            <p class="text-3xl font-mono tracking-widest">{inspection()?.comparison}</p>
          </div>
          <Button class="self-start" disabled={busy()} onClick={() => change(true)}>
            {t().confirm}
          </Button>
        </Show>
        <Button class="self-start" variant="secondary" disabled={busy()} onClick={() => change(false)}>
          {t().cancel}
        </Button>
      </Show>
      <ButtonLink class="self-start" variant="ghost" href={props.returnTo}>
        {t().back}
      </ButtonLink>
    </section>
  );
}
